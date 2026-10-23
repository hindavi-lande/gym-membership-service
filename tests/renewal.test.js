process.env.DB_STORAGE = ':memory:';
process.env.NODE_ENV = 'test';

jest.mock('../src/clients/paymentServiceClient', () => ({
  charge: jest.fn(),
  getMemberPayments: jest.fn(),
  PAYMENTS_UNAVAILABLE: 'PAYMENTS_SERVICE_UNAVAILABLE',
}));

const request = require('supertest');
const app = require('../src/app');
const { sequelize, Member } = require('../src/models');
const paymentServiceClient = require('../src/clients/paymentServiceClient');

const { PAYMENTS_UNAVAILABLE } = paymentServiceClient;

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

beforeEach(() => {
  paymentServiceClient.charge.mockResolvedValue({
    status: 201,
    body: { id: 1, memberId: 1, amount: 79.99, type: 'CHARGE', status: 'SUCCESS' },
  });
});

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Mirrors the UTC month arithmetic used by the service so the expectation does
// not drift for runs that happen near midnight or a month end.
function oneMonthFromToday() {
  const now = new Date();
  const renewal = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  renewal.setUTCMonth(renewal.getUTCMonth() + 1);
  return renewal.toISOString().slice(0, 10);
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

describe('POST /api/members/:id/renew', () => {
  it('charges the plan price and advances renewalDate by one month', async () => {
    const created = await createMember();

    const res = await request(app).post(`/api/members/${created.id}/renew`).send({});

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.id);
    expect(res.body.renewalDate).toBe(oneMonthFromToday());

    const after = await request(app).get(`/api/members/${created.id}`);
    expect(after.status).toBe(200);
    expect(after.body.renewalDate).toBe(oneMonthFromToday());
  });

  it('sends the charge for the member and their plan price', async () => {
    const created = await createMember();

    await request(app).post(`/api/members/${created.id}/renew`).send({});

    expect(paymentServiceClient.charge).toHaveBeenCalledTimes(1);
    expect(paymentServiceClient.charge).toHaveBeenCalledWith({
      memberId: created.id,
      amount: 79.99,
      reason: 'PREMIUM plan renewal',
    });
  });

  it.each([
    ['BASIC', 29.99],
    ['STANDARD', 49.99],
    ['PREMIUM', 79.99],
  ])('charges %s members %s', async (plan, price) => {
    const created = await createMember({ membershipPlan: plan, email: `${plan.toLowerCase()}@example.com` });

    const res = await request(app).post(`/api/members/${created.id}/renew`).send({});

    expect(res.status).toBe(200);
    expect(paymentServiceClient.charge).toHaveBeenCalledWith({
      memberId: created.id,
      amount: price,
      reason: `${plan} plan renewal`,
    });
  });

  it('returns 402 and leaves renewalDate untouched when the charge is declined', async () => {
    const created = await createMember();
    paymentServiceClient.charge.mockResolvedValue({
      status: 402,
      body: { message: 'Payment declined by issuer' },
    });

    const res = await request(app).post(`/api/members/${created.id}/renew`).send({});

    expect(res.status).toBe(402);
    expect(res.body.message).toMatch(/payment did not go through/i);

    const after = await request(app).get(`/api/members/${created.id}`);
    expect(after.status).toBe(200);
    expect(after.body.renewalDate).toBe(today());
    expect(after.body).toMatchObject({
      firstName: validMember.firstName,
      lastName: validMember.lastName,
      email: validMember.email,
      membershipPlan: 'PREMIUM',
      status: 'ACTIVE',
    });
  });

  it('returns 402 for any non-2xx payments response', async () => {
    const created = await createMember();
    paymentServiceClient.charge.mockResolvedValue({ status: 500, body: { message: 'boom' } });

    const res = await request(app).post(`/api/members/${created.id}/renew`).send({});

    expect(res.status).toBe(402);
    expect(res.body.message).toMatch(/payment did not go through/i);
  });

  it('returns 503 and leaves renewalDate untouched when the payments service is unreachable', async () => {
    const created = await createMember();
    const unavailable = new Error('connect ECONNREFUSED');
    unavailable.code = PAYMENTS_UNAVAILABLE;
    paymentServiceClient.charge.mockRejectedValue(unavailable);

    const res = await request(app).post(`/api/members/${created.id}/renew`).send({});

    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/try again later/i);

    const after = await request(app).get(`/api/members/${created.id}`);
    expect(after.body.renewalDate).toBe(today());
  });

  it('returns 404 for an unknown member and does not charge', async () => {
    const res = await request(app).post('/api/members/999999/renew').send({});

    expect(res.status).toBe(404);
    expect(paymentServiceClient.charge).not.toHaveBeenCalled();
  });
});
