process.env.DB_STORAGE = ':memory:';
process.env.NODE_ENV = 'test';

jest.mock('../src/clients/paymentClient');

const request = require('supertest');
const app = require('../src/app');
const { sequelize, Member } = require('../src/models');
const paymentClient = require('../src/clients/paymentClient');
const ApiError = require('../src/utils/ApiError');

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

afterEach(async () => {
  await Member.destroy({ where: {}, truncate: true });
  paymentClient.charge.mockReset();
  paymentClient.getMemberPayments.mockReset();
  paymentClient.refund.mockReset();
});

afterAll(async () => {
  await sequelize.close();
});

const validMember = {
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
  membershipPlan: 'PREMIUM',
};

describe('GET /api/health', () => {
  it('returns ok status', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('POST /api/members', () => {
  it('creates a member with the given fields', async () => {
    const res = await request(app).post('/api/members').send(validMember);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@example.com',
      membershipPlan: 'PREMIUM',
      status: 'ACTIVE',
    });
    expect(res.body.id).toEqual(expect.any(Number));
  });

  it('defaults membershipPlan to BASIC and status to ACTIVE when omitted', async () => {
    const res = await request(app).post('/api/members').send({
      firstName: 'John',
      lastName: 'Smith',
      email: 'john@example.com',
    });

    expect(res.status).toBe(201);
    expect(res.body.membershipPlan).toBe('BASIC');
    expect(res.body.status).toBe('ACTIVE');
  });

  it('rejects creation when a required field is missing', async () => {
    const res = await request(app).post('/api/members').send({
      lastName: 'Doe',
      email: 'missing-first@example.com',
    });

    expect(res.status).toBe(400);
  });

  it('rejects a duplicate email', async () => {
    await request(app).post('/api/members').send(validMember);
    const res = await request(app)
      .post('/api/members')
      .send({ ...validMember, firstName: 'Other' });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/members', () => {
  it('lists all members', async () => {
    await request(app).post('/api/members').send(validMember);

    const res = await request(app).get('/api/members');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].email).toBe(validMember.email);
  });

  it('returns an empty list when there are no members', async () => {
    const res = await request(app).get('/api/members');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('GET /api/members/:id', () => {
  it('gets a member by id', async () => {
    const created = await request(app).post('/api/members').send(validMember);

    const res = await request(app).get(`/api/members/${created.body.id}`);

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(validMember.email);
  });

  it('returns 404 for an unknown member id', async () => {
    const res = await request(app).get('/api/members/999999');

    expect(res.status).toBe(404);
  });
});

describe('PUT /api/members/:id', () => {
  it('updates a member', async () => {
    const created = await request(app).post('/api/members').send(validMember);

    const res = await request(app)
      .put(`/api/members/${created.body.id}`)
      .send({ status: 'SUSPENDED' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SUSPENDED');
  });

  it('returns 404 when updating an unknown member', async () => {
    const res = await request(app).put('/api/members/999999').send({ status: 'SUSPENDED' });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/members/:id', () => {
  it('deletes a member', async () => {
    const created = await request(app).post('/api/members').send(validMember);

    const del = await request(app).delete(`/api/members/${created.body.id}`);
    expect(del.status).toBe(204);

    const after = await request(app).get(`/api/members/${created.body.id}`);
    expect(after.status).toBe(404);
  });

  it('returns 404 when deleting an unknown member', async () => {
    const res = await request(app).delete('/api/members/999999');

    expect(res.status).toBe(404);
  });
});

describe('unknown routes', () => {
  it('returns 404 for an undefined route', async () => {
    const res = await request(app).get('/api/not-a-real-route');

    expect(res.status).toBe(404);
  });
});

function expectedRenewalDate() {
  const renewal = new Date();
  renewal.setUTCDate(renewal.getUTCDate() + 30);
  return renewal.toISOString().slice(0, 10);
}

function dateInDays(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const REFUND_CHARGE_ID = 30;

function buildRefundHistory(memberId, status, relatedPaymentId = REFUND_CHARGE_ID) {
  return [
    {
      id: relatedPaymentId,
      memberId,
      amount: 49.99,
      reason: 'PREMIUM plan renewal',
      status: 'SUCCESS',
      type: 'CHARGE',
      relatedPaymentId: null,
    },
    {
      id: relatedPaymentId + 1,
      memberId,
      amount: 25,
      reason: 'PREMIUM plan refund (15 unused days)',
      status,
      type: 'REFUND',
      relatedPaymentId,
    },
  ];
}

function buildPaymentsHistory(memberId) {
  return [
    {
      id: 1,
      memberId,
      amount: 49.99,
      reason: 'PREMIUM plan renewal',
      status: 'SUCCESS',
    },
    {
      id: 2,
      memberId,
      amount: 49.99,
      reason: 'PREMIUM plan renewal',
      status: 'SUCCESS',
    },
  ];
}

describe('POST /api/members/:id/renew', () => {
  it('starts a new member with lastPaymentId null and refundFollowUpRequired false', async () => {
    const created = await request(app).post('/api/members').send(validMember);

    expect(created.body.lastPaymentId).toBeNull();
    expect(created.body.refundFollowUpRequired).toBe(false);

    const fetched = await request(app).get(`/api/members/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.lastPaymentId).toBeNull();
    expect(fetched.body.refundFollowUpRequired).toBe(false);

    const listed = await request(app).get('/api/members');
    expect(listed.status).toBe(200);
    expect(listed.body[0].lastPaymentId).toBeNull();
    expect(listed.body[0].refundFollowUpRequired).toBe(false);
  });

  it('stores the charge payment id as lastPaymentId alongside the new renewalDate', async () => {
    const created = await request(app).post('/api/members').send(validMember);
    paymentClient.charge.mockResolvedValue({
      id: 4242,
      memberId: created.body.id,
      amount: 49.99,
      reason: 'PREMIUM plan renewal',
      status: 'SUCCESS',
    });

    const renewed = await request(app).post(`/api/members/${created.body.id}/renew`);
    expect(renewed.status).toBe(200);

    const stored = await request(app).get(`/api/members/${created.body.id}`);
    expect(stored.body.lastPaymentId).toBe(4242);
    expect(stored.body.renewalDate).toBe(expectedRenewalDate());
  });

  it('leaves lastPaymentId null when the charge is declined', async () => {
    const created = await request(app).post('/api/members').send(validMember);
    paymentClient.charge.mockRejectedValue(
      new ApiError(402, 'Payment was declined. The payment did not go through.')
    );

    const res = await request(app).post(`/api/members/${created.body.id}/renew`);
    expect(res.status).toBe(402);

    const stored = await request(app).get(`/api/members/${created.body.id}`);
    expect(stored.status).toBe(200);
    expect(stored.body.lastPaymentId).toBeNull();
    expect(stored.body.renewalDate).toBeNull();
    expect(stored.body.refundFollowUpRequired).toBe(false);
  });

  it('leaves lastPaymentId and renewalDate unchanged when the payments service is unreachable', async () => {
    const created = await request(app).post('/api/members').send(validMember);
    paymentClient.charge.mockResolvedValueOnce({
      id: 51,
      memberId: created.body.id,
      amount: 49.99,
      reason: 'PREMIUM plan renewal',
      status: 'SUCCESS',
    });

    const firstRenew = await request(app).post(`/api/members/${created.body.id}/renew`);
    expect(firstRenew.status).toBe(200);

    const afterFirst = await request(app).get(`/api/members/${created.body.id}`);
    expect(afterFirst.body.lastPaymentId).toBe(51);

    paymentClient.charge.mockRejectedValueOnce(
      new ApiError(503, 'Payment service is unavailable. Please try again later.')
    );

    const secondRenew = await request(app).post(`/api/members/${created.body.id}/renew`);
    expect(secondRenew.status).toBe(503);

    const stored = await request(app).get(`/api/members/${created.body.id}`);
    expect(stored.status).toBe(200);
    expect(stored.body.lastPaymentId).toBe(51);
    expect(stored.body.renewalDate).toBe(afterFirst.body.renewalDate);
  });

  it('charges the plan price and sets renewalDate to today + 30 days', async () => {
    const created = await request(app).post('/api/members').send(validMember);
    paymentClient.charge.mockResolvedValue({
      id: 1,
      memberId: created.body.id,
      amount: 49.99,
      reason: 'PREMIUM plan renewal',
      status: 'SUCCESS',
    });

    const res = await request(app).post(`/api/members/${created.body.id}/renew`);

    expect(res.status).toBe(200);
    expect(paymentClient.charge).toHaveBeenCalledTimes(1);
    expect(paymentClient.charge).toHaveBeenCalledWith({
      memberId: created.body.id,
      amount: 49.99,
      reason: 'PREMIUM plan renewal',
    });
    expect(res.body.renewalDate).toBe(expectedRenewalDate());

    const stored = await request(app).get(`/api/members/${created.body.id}`);
    expect(stored.body.renewalDate).toBe(expectedRenewalDate());
  });

  it("charges the price of the member's current plan", async () => {
    const basic = await request(app).post('/api/members').send({
      firstName: 'Amy',
      lastName: 'Basic',
      email: 'amy@example.com',
    });
    paymentClient.charge.mockResolvedValue({ id: 1, status: 'SUCCESS' });

    const basicRenew = await request(app).post(`/api/members/${basic.body.id}/renew`);

    expect(basicRenew.status).toBe(200);
    expect(paymentClient.charge).toHaveBeenLastCalledWith({
      memberId: basic.body.id,
      amount: 29.99,
      reason: 'BASIC plan renewal',
    });

    const standard = await request(app).post('/api/members').send({
      firstName: 'Sam',
      lastName: 'Standard',
      email: 'sam@example.com',
      membershipPlan: 'STANDARD',
    });

    const standardRenew = await request(app).post(`/api/members/${standard.body.id}/renew`);

    expect(standardRenew.status).toBe(200);
    expect(paymentClient.charge).toHaveBeenLastCalledWith({
      memberId: standard.body.id,
      amount: 39.99,
      reason: 'STANDARD plan renewal',
    });
  });

  it('returns 402 and leaves renewalDate null when the charge is declined', async () => {
    const created = await request(app).post('/api/members').send(validMember);
    paymentClient.charge.mockRejectedValue(
      new ApiError(402, 'Payment was declined. The payment did not go through.')
    );

    const res = await request(app).post(`/api/members/${created.body.id}/renew`);

    expect(res.status).toBe(402);
    expect(res.body.message).toMatch(/did not go through/i);

    const stored = await request(app).get(`/api/members/${created.body.id}`);
    expect(stored.status).toBe(200);
    expect(stored.body.renewalDate).toBeNull();
  });

  it('returns 503 with a try-again-later message when the payments service is unreachable', async () => {
    const created = await request(app).post('/api/members').send(validMember);
    paymentClient.charge.mockRejectedValue(
      new ApiError(503, 'Payment service is unavailable. Please try again later.')
    );

    const res = await request(app).post(`/api/members/${created.body.id}/renew`);

    expect(res.status).toBe(503);
    expect(res.body.message).toContain('try again later');

    const stored = await request(app).get(`/api/members/${created.body.id}`);
    expect(stored.status).toBe(200);
    expect(stored.body.renewalDate).toBeNull();
  });

  it('returns 404 and does not call the payments client for an unknown member', async () => {
    const res = await request(app).post('/api/members/999999/renew');

    expect(res.status).toBe(404);
    expect(paymentClient.charge).not.toHaveBeenCalled();
  });
});

describe('POST /api/members/:id/cancel', () => {
  const planPrices = { BASIC: 29.99, STANDARD: 39.99, PREMIUM: 49.99 };

  async function createRenewedMember({ membershipPlan = 'PREMIUM', chargeId, email }) {
    const created = await request(app).post('/api/members').send({
      firstName: 'Cancel',
      lastName: 'Member',
      email,
      membershipPlan,
    });
    expect(created.status).toBe(201);

    paymentClient.charge.mockResolvedValue({
      id: chargeId,
      memberId: created.body.id,
      amount: planPrices[membershipPlan],
      reason: `${membershipPlan} plan renewal`,
      status: 'SUCCESS',
      type: 'CHARGE',
    });

    const renewed = await request(app).post(`/api/members/${created.body.id}/renew`);
    expect(renewed.status).toBe(200);
    expect(renewed.body.lastPaymentId).toBe(chargeId);

    return created.body.id;
  }

  it('cancels the member and refunds the unused days of the current period', async () => {
    const id = await createRenewedMember({ chargeId: 101, email: 'cancel-full@example.com' });
    paymentClient.refund.mockResolvedValue({
      id: 501,
      memberId: id,
      amount: 49.99,
      reason: 'PREMIUM plan refund (30 unused days)',
      status: 'SUCCESS',
      type: 'REFUND',
      relatedPaymentId: 101,
    });

    const res = await request(app).post(`/api/members/${id}/cancel`);

    expect(res.status).toBe(200);
    expect(res.body.member.status).toBe('INACTIVE');
    expect(res.body.member.refundFollowUpRequired).toBe(false);
    expect(res.body.refund).toMatchObject({ status: 'SUCCESS', amount: 49.99, paymentId: 501 });
    expect(paymentClient.refund).toHaveBeenCalledTimes(1);
    expect(paymentClient.refund).toHaveBeenCalledWith({
      memberId: id,
      amount: 49.99,
      reason: 'PREMIUM plan refund (30 unused days)',
      relatedPaymentId: 101,
    });

    const stored = await request(app).get(`/api/members/${id}`);
    expect(stored.status).toBe(200);
    expect(stored.body.status).toBe('INACTIVE');
  });

  it('refunds the unused portion proportionally to the days remaining', async () => {
    const id = await createRenewedMember({ chargeId: 202, email: 'cancel-partial@example.com' });
    await request(app).put(`/api/members/${id}`).send({ renewalDate: dateInDays(15) });
    paymentClient.refund.mockResolvedValue({
      id: 502,
      memberId: id,
      amount: 25,
      status: 'SUCCESS',
      type: 'REFUND',
      relatedPaymentId: 202,
    });

    const res = await request(app).post(`/api/members/${id}/cancel`);

    expect(res.status).toBe(200);
    // 49.99 x 15 / 30 = 24.995, rounded half-up to 25.00.
    expect(res.body.refund.amount).toBe(25);
    expect(paymentClient.refund).toHaveBeenCalledTimes(1);
    expect(paymentClient.refund.mock.calls[0][0]).toMatchObject({
      memberId: id,
      amount: 25,
      relatedPaymentId: 202,
    });
  });

  it('never refunds more than the price paid and rounds the amount to cents', async () => {
    const fullId = await createRenewedMember({
      membershipPlan: 'BASIC',
      chargeId: 303,
      email: 'cancel-basic-full@example.com',
    });
    paymentClient.refund.mockResolvedValue({
      id: 503,
      memberId: fullId,
      amount: 29.99,
      status: 'SUCCESS',
      type: 'REFUND',
      relatedPaymentId: 303,
    });

    const fullRes = await request(app).post(`/api/members/${fullId}/cancel`);

    expect(fullRes.status).toBe(200);
    expect(fullRes.body.refund.amount).toBe(29.99);
    expect(paymentClient.refund).toHaveBeenLastCalledWith({
      memberId: fullId,
      amount: 29.99,
      reason: 'BASIC plan refund (30 unused days)',
      relatedPaymentId: 303,
    });

    const oneDayId = await createRenewedMember({
      membershipPlan: 'BASIC',
      chargeId: 304,
      email: 'cancel-basic-one-day@example.com',
    });
    await request(app).put(`/api/members/${oneDayId}`).send({ renewalDate: dateInDays(1) });
    paymentClient.refund.mockResolvedValue({
      id: 504,
      memberId: oneDayId,
      amount: 1,
      status: 'SUCCESS',
      type: 'REFUND',
      relatedPaymentId: 304,
    });

    const oneDayRes = await request(app).post(`/api/members/${oneDayId}/cancel`);

    expect(oneDayRes.status).toBe(200);
    // 29.99 x 1 / 30 = 0.9996..., rounded half-up to 1.00.
    expect(oneDayRes.body.refund.amount).toBe(1);
  });

  it('does not refund when the renewal date is today or already past', async () => {
    const todayId = await createRenewedMember({
      chargeId: 401,
      email: 'cancel-due-today@example.com',
    });
    await request(app).put(`/api/members/${todayId}`).send({ renewalDate: dateInDays(0) });

    const todayRes = await request(app).post(`/api/members/${todayId}/cancel`);

    expect(todayRes.status).toBe(200);
    expect(todayRes.body.member.status).toBe('INACTIVE');
    expect(todayRes.body.refund).toMatchObject({ status: 'NOT_ELIGIBLE', amount: null });
    expect(paymentClient.refund).not.toHaveBeenCalled();

    const pastId = await createRenewedMember({ chargeId: 402, email: 'cancel-past@example.com' });
    await request(app).put(`/api/members/${pastId}`).send({ renewalDate: dateInDays(-3) });

    const pastRes = await request(app).post(`/api/members/${pastId}/cancel`);

    expect(pastRes.status).toBe(200);
    expect(pastRes.body.refund).toMatchObject({ status: 'NOT_ELIGIBLE', amount: null });
    expect(paymentClient.refund).not.toHaveBeenCalled();
  });

  it('cancels without a refund when nothing was paid for the current period', async () => {
    const created = await request(app).post('/api/members').send({
      firstName: 'No',
      lastName: 'Payment',
      email: 'cancel-no-payment@example.com',
      membershipPlan: 'PREMIUM',
    });

    const res = await request(app).post(`/api/members/${created.body.id}/cancel`);

    expect(res.status).toBe(200);
    expect(res.body.member.status).toBe('INACTIVE');
    expect(res.body.refund).toMatchObject({ status: 'NOT_ELIGIBLE', amount: null });
    expect(paymentClient.refund).not.toHaveBeenCalled();

    const stored = await request(app).get(`/api/members/${created.body.id}`);
    expect(stored.body.status).toBe('INACTIVE');
  });

  it('cancels and flags staff follow-up when the refund cannot be processed', async () => {
    const id = await createRenewedMember({ chargeId: 601, email: 'cancel-refund-down@example.com' });
    paymentClient.refund.mockRejectedValue(
      new ApiError(503, 'Payment service is unavailable. Please try again later.')
    );

    const res = await request(app).post(`/api/members/${id}/cancel`);

    expect(res.status).toBe(200);
    expect(paymentClient.refund).toHaveBeenCalledTimes(1);
    expect(res.body.member.status).toBe('INACTIVE');
    expect(res.body.member.refundFollowUpRequired).toBe(true);
    expect(res.body.refund.amount).toBe(49.99);
    expect(res.body.refund.message).toMatch(/pending/i);

    const stored = await request(app).get(`/api/members/${id}`);
    expect(stored.body.status).toBe('INACTIVE');
    expect(stored.body.refundFollowUpRequired).toBe(true);
  });

  it('keeps the follow-up flag clear when the refund is only pending at the payments service', async () => {
    const id = await createRenewedMember({ chargeId: 701, email: 'cancel-pending@example.com' });
    paymentClient.refund.mockResolvedValue({
      id: 505,
      memberId: id,
      amount: 49.99,
      status: 'PENDING',
      type: 'REFUND',
      relatedPaymentId: 701,
    });

    const res = await request(app).post(`/api/members/${id}/cancel`);

    expect(res.status).toBe(200);
    expect(res.body.member.status).toBe('INACTIVE');
    expect(res.body.member.refundFollowUpRequired).toBe(false);
    expect(res.body.refund.status).toBe('PENDING');
    expect(res.body.refund.paymentId).toBe(505);
    expect(res.body.refund.message).toMatch(/pending/i);
  });

  it('does not refund a second time when the member is already inactive', async () => {
    const id = await createRenewedMember({ chargeId: 801, email: 'cancel-twice@example.com' });
    paymentClient.refund.mockResolvedValue({
      id: 506,
      memberId: id,
      amount: 49.99,
      status: 'SUCCESS',
      type: 'REFUND',
      relatedPaymentId: 801,
    });

    const first = await request(app).post(`/api/members/${id}/cancel`);
    expect(first.status).toBe(200);
    expect(paymentClient.refund).toHaveBeenCalledTimes(1);

    const second = await request(app).post(`/api/members/${id}/cancel`);

    expect(second.status).toBe(200);
    expect(second.body.member.status).toBe('INACTIVE');
    expect(second.body.refund).toMatchObject({ status: 'NOT_ELIGIBLE', amount: null });
    expect(paymentClient.refund).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for an unknown member without calling the payments client', async () => {
    const res = await request(app).post('/api/members/999999/cancel');

    expect(res.status).toBe(404);
    expect(paymentClient.refund).not.toHaveBeenCalled();
    expect(paymentClient.charge).not.toHaveBeenCalled();
  });
});

describe('GET /api/members/:id/payments', () => {
  it('proxies the raw payments history array from the payments service', async () => {
    const created = await request(app).post('/api/members').send(validMember);
    const history = buildPaymentsHistory(created.body.id);
    paymentClient.getMemberPayments.mockResolvedValue(history);

    const res = await request(app).get(`/api/members/${created.body.id}/payments`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(history);
    expect(paymentClient.getMemberPayments).toHaveBeenCalledWith(created.body.id);
  });

  it('returns 503 with a try-again-later message when the payments service is unreachable', async () => {
    const created = await request(app).post('/api/members').send(validMember);
    paymentClient.getMemberPayments.mockRejectedValue(
      new ApiError(503, 'Payment service is unavailable. Please try again later.')
    );

    const res = await request(app).get(`/api/members/${created.body.id}/payments`);

    expect(res.status).toBe(503);
    expect(res.body.message).toContain('try again later');
  });

  it('returns 404 and does not call the payments client for an unknown member', async () => {
    const res = await request(app).get('/api/members/999999/payments');

    expect(res.status).toBe(404);
    expect(paymentClient.getMemberPayments).not.toHaveBeenCalled();
  });

  it('reports the refund outcome recorded by the payments service', async () => {
    const created = await request(app).post('/api/members').send(validMember);
    const memberId = created.body.id;

    paymentClient.getMemberPayments.mockResolvedValue(
      buildRefundHistory(memberId, 'PENDING')
    );
    const pending = await request(app).get(`/api/members/${memberId}/payments`);
    expect(pending.status).toBe(200);
    const pendingRefund = pending.body.find((payment) => payment.type === 'REFUND');
    expect(pendingRefund.status).toBe('PENDING');
    expect(pendingRefund.relatedPaymentId).toBe(REFUND_CHARGE_ID);

    paymentClient.getMemberPayments.mockResolvedValue(
      buildRefundHistory(memberId, 'SUCCESS')
    );
    const completed = await request(app).get(`/api/members/${memberId}/payments`);
    expect(completed.status).toBe(200);
    const completedRefund = completed.body.find((payment) => payment.type === 'REFUND');
    expect(completedRefund.status).toBe('SUCCESS');

    paymentClient.getMemberPayments.mockResolvedValue(
      buildRefundHistory(memberId, 'FAILED')
    );
    const failed = await request(app).get(`/api/members/${memberId}/payments`);
    expect(failed.status).toBe(200);
    const failedRefund = failed.body.find((payment) => payment.type === 'REFUND');
    expect(failedRefund.status).toBe('FAILED');
  });

  it('ties each refund to the renewal charge it gives money back from, never for more', async () => {
    const created = await request(app).post('/api/members').send(validMember);
    paymentClient.getMemberPayments.mockResolvedValue(
      buildRefundHistory(created.body.id, 'SUCCESS')
    );

    const res = await request(app).get(`/api/members/${created.body.id}/payments`);

    expect(res.status).toBe(200);
    const refundRow = res.body.find((payment) => payment.type === 'REFUND');
    const chargeRow = res.body.find((payment) => payment.id === refundRow.relatedPaymentId);
    expect(chargeRow).toBeDefined();
    expect(chargeRow.type).toBe('CHARGE');
    expect(refundRow.amount).toBeLessThanOrEqual(chargeRow.amount);
  });

  it('reports a cancellation refund as pending until the payments service settles it', async () => {
    const created = await request(app).post('/api/members').send(validMember);
    const memberId = created.body.id;

    paymentClient.charge.mockResolvedValue({
      id: REFUND_CHARGE_ID,
      memberId,
      amount: 49.99,
      reason: 'PREMIUM plan renewal',
      status: 'SUCCESS',
      type: 'CHARGE',
      relatedPaymentId: null,
    });
    const renewed = await request(app).post(`/api/members/${memberId}/renew`);
    expect(renewed.status).toBe(200);

    paymentClient.refund.mockResolvedValue({
      id: REFUND_CHARGE_ID + 1,
      memberId,
      amount: 49.99,
      reason: 'PREMIUM plan refund (30 unused days)',
      status: 'PENDING',
      type: 'REFUND',
      relatedPaymentId: REFUND_CHARGE_ID,
    });
    const cancelled = await request(app).post(`/api/members/${memberId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.refund.status).toBe('PENDING');

    paymentClient.getMemberPayments.mockResolvedValue(
      buildRefundHistory(memberId, 'PENDING')
    );
    const pending = await request(app).get(`/api/members/${memberId}/payments`);
    expect(pending.status).toBe(200);
    expect(pending.body.find((payment) => payment.type === 'REFUND').status).toBe('PENDING');

    // The settle call lives in the payments service; the membership service only
    // has to report whatever outcome the history now carries.
    paymentClient.getMemberPayments.mockResolvedValue(
      buildRefundHistory(memberId, 'SUCCESS')
    );
    const settled = await request(app).get(`/api/members/${memberId}/payments`);
    expect(settled.status).toBe(200);
    expect(settled.body.find((payment) => payment.type === 'REFUND').status).toBe('SUCCESS');
  });

  it('returns an empty history for a member who has no payments yet', async () => {
    const created = await request(app).post('/api/members').send(validMember);
    paymentClient.getMemberPayments.mockResolvedValue([]);

    const res = await request(app).get(`/api/members/${created.body.id}/payments`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
