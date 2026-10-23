process.env.DB_STORAGE = ':memory:';
process.env.NODE_ENV = 'test';

jest.mock('../src/clients/paymentServiceClient', () => ({
  charge: jest.fn(),
  refund: jest.fn(),
  getMemberPayments: jest.fn(),
  PAYMENTS_UNAVAILABLE: 'PAYMENTS_SERVICE_UNAVAILABLE',
}));

const request = require('supertest');
const app = require('../src/app');
const { sequelize, Member } = require('../src/models');
const paymentServiceClient = require('../src/clients/paymentServiceClient');

const { PAYMENTS_UNAVAILABLE } = paymentServiceClient;

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

afterEach(async () => {
  await Member.destroy({ where: {}, truncate: true });
  jest.clearAllMocks();
});

afterAll(async () => {
  await sequelize.close();
});

function utcToday() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

function shiftDays(dateOnly, days) {
  return new Date(Date.parse(`${dateOnly}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function shiftMonths(dateOnly, months) {
  const shifted = new Date(`${dateOnly}T00:00:00Z`);
  shifted.setUTCMonth(shifted.getUTCMonth() + months);
  return shifted.toISOString().slice(0, 10);
}

// Independently mirrors the proration the service applies, so the expectation does
// not depend on the util under test but still follows the real calendar.
function expectedRefund(chargeAmount, renewalDate, today) {
  const totalDays = Math.round(
    (Date.parse(`${renewalDate}T00:00:00Z`) - Date.parse(`${shiftMonths(renewalDate, -1)}T00:00:00Z`)) /
      DAY_MS,
  );
  const remainingDays = Math.round(
    (Date.parse(`${renewalDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
  );

  if (remainingDays <= 0 || totalDays <= 0) {
    return 0;
  }

  const amount = Math.round(((chargeAmount * remainingDays) / totalDays + Number.EPSILON) * 100) / 100;
  return Math.min(Math.max(amount, 0), chargeAmount);
}

const validMember = {
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
  membershipPlan: 'PREMIUM',
};

async function createMember(overrides = {}) {
  const res = await request(app).post('/api/members').send({ ...validMember, ...overrides });
  expect(res.status).toBe(201);
  return res.body;
}

function upcomingRenewalDate() {
  return shiftDays(utcToday(), 10);
}

beforeEach(() => {
  paymentServiceClient.getMemberPayments.mockResolvedValue({
    status: 200,
    body: [
      { id: 12, amount: 79.99, type: 'CHARGE', status: 'SUCCESS' },
      { id: 5, amount: 79.99, type: 'CHARGE', status: 'SUCCESS' },
    ],
  });

  paymentServiceClient.refund.mockResolvedValue({
    status: 201,
    body: { id: 20, amount: 26.66, type: 'REFUND', status: 'SUCCESS', relatedPaymentId: 12 },
  });
});

describe('POST /api/members/:id/cancel', () => {
  it('refunds the unused part of the latest charge and cancels the member', async () => {
    const today = utcToday();
    const renewalDate = upcomingRenewalDate();
    const created = await createMember({ renewalDate });
    const expected = expectedRefund(79.99, renewalDate, today);

    const res = await request(app).post(`/api/members/${created.id}/cancel`).send({});

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.id);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.refundStatus).toBe('COMPLETED');
    expect(res.body.refundNeedsFollowUp).toBe(false);
    expect(res.body.refund).toMatchObject({
      status: 'COMPLETED',
      amount: expected,
      relatedPaymentId: 12,
    });

    // 10 days remaining out of a month is a positive, partial refund.
    expect(expected).toBeGreaterThan(0);
    expect(expected).toBeLessThan(79.99);

    expect(paymentServiceClient.refund).toHaveBeenCalledTimes(1);
    expect(paymentServiceClient.refund).toHaveBeenCalledWith({
      memberId: created.id,
      amount: expected,
      reason: 'PREMIUM plan cancellation refund',
      relatedPaymentId: 12,
    });

    const after = await request(app).get(`/api/members/${created.id}`);
    expect(after.status).toBe(200);
    expect(after.body.status).toBe('CANCELLED');
    expect(after.body.refundStatus).toBe('COMPLETED');
    expect(after.body.refundNeedsFollowUp).toBe(false);
  });

  it('never asks for more than the charge it refunds', async () => {
    // Cancelling before the current period has even started leaves more "remaining"
    // days than the period has, so the proration has to be clamped to the charge.
    const created = await createMember({ renewalDate: shiftDays(utcToday(), 45) });

    const res = await request(app).post(`/api/members/${created.id}/cancel`).send({});

    expect(res.status).toBe(200);
    expect(res.body.refund.amount).toBe(79.99);
    expect(paymentServiceClient.refund).toHaveBeenCalledTimes(1);
    expect(paymentServiceClient.refund.mock.calls[0][0].amount).toBe(79.99);
    expect(paymentServiceClient.refund.mock.calls[0][0].amount).toBeLessThanOrEqual(79.99);
  });

  it('cancels without a refund when the renewal date is today', async () => {
    const created = await createMember({ renewalDate: utcToday() });

    const res = await request(app).post(`/api/members/${created.id}/cancel`).send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.refundStatus).toBeNull();
    expect(res.body.refundNeedsFollowUp).toBe(false);
    expect(res.body.refund).toMatchObject({ status: null, amount: null, relatedPaymentId: null });
    expect(paymentServiceClient.refund).not.toHaveBeenCalled();
    expect(paymentServiceClient.getMemberPayments).not.toHaveBeenCalled();
  });

  it('cancels without a refund when the renewal date has already passed', async () => {
    const created = await createMember({ renewalDate: shiftDays(utcToday(), -5) });

    const res = await request(app).post(`/api/members/${created.id}/cancel`).send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.refund).toMatchObject({ status: null, amount: null, relatedPaymentId: null });
    expect(paymentServiceClient.refund).not.toHaveBeenCalled();
  });

  it('cancels without a refund when the history contains no charge', async () => {
    const created = await createMember({ renewalDate: upcomingRenewalDate() });
    paymentServiceClient.getMemberPayments.mockResolvedValue({
      status: 200,
      body: [
        { id: 20, amount: 12.5, type: 'REFUND', status: 'SUCCESS', relatedPaymentId: 12 },
      ],
    });

    const res = await request(app).post(`/api/members/${created.id}/cancel`).send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.refund).toMatchObject({ status: null, amount: null, relatedPaymentId: null });
    expect(paymentServiceClient.refund).not.toHaveBeenCalled();
  });

  it('returns 409 and sends no refund when the membership is already cancelled', async () => {
    const created = await createMember({ renewalDate: upcomingRenewalDate() });
    await request(app).put(`/api/members/${created.id}`).send({ status: 'CANCELLED' });

    const res = await request(app).post(`/api/members/${created.id}/cancel`).send({});

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already cancelled/i);
    expect(paymentServiceClient.refund).not.toHaveBeenCalled();
    expect(paymentServiceClient.getMemberPayments).not.toHaveBeenCalled();
  });

  it('returns 409 and does not cancel when that payment was already refunded', async () => {
    const created = await createMember({ renewalDate: upcomingRenewalDate() });
    paymentServiceClient.refund.mockResolvedValue({
      status: 409,
      body: { message: 'Payment 12 has already been refunded' },
    });

    const res = await request(app).post(`/api/members/${created.id}/cancel`).send({});

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already been refunded/i);
    expect(paymentServiceClient.refund).toHaveBeenCalledTimes(1);

    const after = await request(app).get(`/api/members/${created.id}`);
    expect(after.status).toBe(200);
    expect(after.body.status).toBe('ACTIVE');
    expect(after.body.refundStatus).toBeNull();
  });

  it('cancels with a pending refund when the payments service is unreachable', async () => {
    const created = await createMember({ renewalDate: upcomingRenewalDate() });
    const unavailable = new Error('connect ECONNREFUSED');
    unavailable.code = PAYMENTS_UNAVAILABLE;
    paymentServiceClient.refund.mockRejectedValue(unavailable);

    const res = await request(app).post(`/api/members/${created.id}/cancel`).send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.refundStatus).toBe('PENDING');
    expect(res.body.refundNeedsFollowUp).toBe(true);
    expect(res.body.refund.status).toBe('PENDING');
    expect(res.body.refund.message).toMatch(/pending/i);

    const after = await request(app).get(`/api/members/${created.id}`);
    expect(after.body.status).toBe('CANCELLED');
    expect(after.body.refundStatus).toBe('PENDING');
    expect(after.body.refundNeedsFollowUp).toBe(true);
  });

  it('keeps a refund the payments service records as PENDING pending and flagged', async () => {
    const created = await createMember({ renewalDate: upcomingRenewalDate() });
    paymentServiceClient.refund.mockResolvedValue({
      status: 201,
      body: { id: 20, type: 'REFUND', status: 'PENDING', relatedPaymentId: 12 },
    });

    const res = await request(app).post(`/api/members/${created.id}/cancel`).send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.refundStatus).toBe('PENDING');
    expect(res.body.refundNeedsFollowUp).toBe(true);
    expect(res.body.refund.status).toBe('PENDING');
  });

  it('cancels with a pending refund when the payments service answers with an error', async () => {
    const created = await createMember({ renewalDate: upcomingRenewalDate() });
    paymentServiceClient.refund.mockResolvedValue({
      status: 422,
      body: { message: 'Refund exceeds payment 12' },
    });

    const res = await request(app).post(`/api/members/${created.id}/cancel`).send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.refundStatus).toBe('PENDING');
    expect(res.body.refundNeedsFollowUp).toBe(true);
  });

  it('cancels with a pending refund when the history cannot be loaded', async () => {
    const created = await createMember({ renewalDate: upcomingRenewalDate() });
    const unavailable = new Error('connect ECONNREFUSED');
    unavailable.code = PAYMENTS_UNAVAILABLE;
    paymentServiceClient.getMemberPayments.mockRejectedValue(unavailable);

    const res = await request(app).post(`/api/members/${created.id}/cancel`).send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.refundStatus).toBe('PENDING');
    expect(res.body.refundNeedsFollowUp).toBe(true);
    expect(paymentServiceClient.refund).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown member and sends no refund', async () => {
    const res = await request(app).post('/api/members/999999/cancel').send({});

    expect(res.status).toBe(404);
    expect(paymentServiceClient.refund).not.toHaveBeenCalled();
    expect(paymentServiceClient.getMemberPayments).not.toHaveBeenCalled();
  });
});
