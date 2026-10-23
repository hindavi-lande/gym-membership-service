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

describe('GET /api/members/:id/payments', () => {
  it('returns the payments service history unchanged', async () => {
    const created = await createMember();
    const history = [
      { id: 3, memberId: created.id, amount: 79.99, type: 'CHARGE', status: 'SUCCESS' },
      { id: 1, memberId: created.id, amount: 79.99, type: 'CHARGE', status: 'SUCCESS' },
    ];
    paymentServiceClient.getMemberPayments.mockResolvedValue({ status: 200, body: history });

    const res = await request(app).get(`/api/members/${created.id}/payments`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(history);
    expect(res.body.map((payment) => payment.id)).toEqual([3, 1]);
    expect(paymentServiceClient.getMemberPayments).toHaveBeenCalledTimes(1);
    expect(paymentServiceClient.getMemberPayments).toHaveBeenCalledWith(String(created.id));
  });

  it('returns an empty list when the member has no charges yet', async () => {
    const created = await createMember();
    paymentServiceClient.getMemberPayments.mockResolvedValue({ status: 200, body: [] });

    const res = await request(app).get(`/api/members/${created.id}/payments`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 404 for an unknown member and does not call the payments service', async () => {
    const res = await request(app).get('/api/members/999999/payments');

    expect(res.status).toBe(404);
    expect(paymentServiceClient.getMemberPayments).not.toHaveBeenCalled();
  });

  it('returns 503 rather than an empty list when the payments service is unreachable', async () => {
    const created = await createMember();
    const unavailable = new Error('connect ECONNREFUSED');
    unavailable.code = PAYMENTS_UNAVAILABLE;
    paymentServiceClient.getMemberPayments.mockRejectedValue(unavailable);

    const res = await request(app).get(`/api/members/${created.id}/payments`);

    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/try again later/i);
    expect(Array.isArray(res.body)).toBe(false);
  });

  it('returns 502 when the payments service answers with a non-2xx status', async () => {
    const created = await createMember();
    paymentServiceClient.getMemberPayments.mockResolvedValue({
      status: 500,
      body: { message: 'boom' },
    });

    const res = await request(app).get(`/api/members/${created.id}/payments`);

    expect(res.status).toBe(502);
    expect(Array.isArray(res.body)).toBe(false);
  });
});
