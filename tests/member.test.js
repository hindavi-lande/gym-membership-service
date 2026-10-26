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
});
