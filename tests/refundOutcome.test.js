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

// The state a cancellation leaves behind when the refund could not be confirmed
// straight away.
async function markRefundPending(id) {
  const res = await request(app)
    .put(`/api/members/${id}`)
    .send({ refundStatus: 'PENDING', refundNeedsFollowUp: true });

  expect(res.status).toBe(200);
  return res.body;
}

describe('GET /api/members/:id refund fields', () => {
  it('reports the stored refund outcome on request', async () => {
    const created = await createMember();
    await request(app).put(`/api/members/${created.id}`).send({ refundStatus: 'COMPLETED' });

    const res = await request(app).get(`/api/members/${created.id}`);

    expect(res.status).toBe(200);
    expect(res.body.refundStatus).toBe('COMPLETED');
    expect(res.body.refundNeedsFollowUp).toBe(false);
  });

  it('reports no refund outcome for a member that has never had one', async () => {
    const created = await createMember();

    const res = await request(app).get(`/api/members/${created.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('refundStatus', null);
    expect(res.body).toHaveProperty('refundNeedsFollowUp', false);
  });
});

describe('GET /api/members/:id/payments', () => {
  it('returns REFUND entries with their pending, completed or failed status unchanged', async () => {
    const created = await createMember();
    const history = [
      { id: 30, memberId: created.id, amount: 12.5, type: 'REFUND', status: 'PENDING', relatedPaymentId: 12 },
      { id: 20, memberId: created.id, amount: 12.5, type: 'REFUND', status: 'SUCCESS', relatedPaymentId: 5 },
      { id: 10, memberId: created.id, amount: 12.5, type: 'REFUND', status: 'FAILED', relatedPaymentId: 4 },
      { id: 12, memberId: created.id, amount: 79.99, type: 'CHARGE', status: 'SUCCESS' },
    ];
    paymentServiceClient.getMemberPayments.mockResolvedValue({ status: 200, body: history });

    const res = await request(app).get(`/api/members/${created.id}/payments`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(history);
    expect(res.body.map((payment) => payment.status)).toEqual([
      'PENDING',
      'SUCCESS',
      'FAILED',
      'SUCCESS',
    ]);
  });

  it('marks a pending refund COMPLETED once the history shows it settled', async () => {
    const created = await createMember();
    await markRefundPending(created.id);
    const history = [
      { id: 20, memberId: created.id, amount: 26.66, type: 'REFUND', status: 'SUCCESS', relatedPaymentId: 12 },
      { id: 12, memberId: created.id, amount: 79.99, type: 'CHARGE', status: 'SUCCESS' },
    ];
    paymentServiceClient.getMemberPayments.mockResolvedValue({ status: 200, body: history });

    const payments = await request(app).get(`/api/members/${created.id}/payments`);
    expect(payments.status).toBe(200);
    expect(payments.body).toEqual(history);

    const after = await request(app).get(`/api/members/${created.id}`);
    expect(after.status).toBe(200);
    expect(after.body.refundStatus).toBe('COMPLETED');
    expect(after.body.refundNeedsFollowUp).toBe(false);
  });

  it('marks a pending refund FAILED once the history shows it failed', async () => {
    const created = await createMember();
    await markRefundPending(created.id);
    const history = [
      { id: 20, memberId: created.id, amount: 26.66, type: 'REFUND', status: 'FAILED', relatedPaymentId: 12 },
      { id: 12, memberId: created.id, amount: 79.99, type: 'CHARGE', status: 'SUCCESS' },
    ];
    paymentServiceClient.getMemberPayments.mockResolvedValue({ status: 200, body: history });

    const payments = await request(app).get(`/api/members/${created.id}/payments`);
    expect(payments.status).toBe(200);
    expect(payments.body).toEqual(history);

    const after = await request(app).get(`/api/members/${created.id}`);
    expect(after.status).toBe(200);
    expect(after.body.refundStatus).toBe('FAILED');
    expect(after.body.refundNeedsFollowUp).toBe(false);
  });

  it('keeps a refund PENDING while the history still shows it pending', async () => {
    const created = await createMember();
    await markRefundPending(created.id);
    const history = [
      { id: 20, memberId: created.id, amount: 26.66, type: 'REFUND', status: 'PENDING', relatedPaymentId: 12 },
      { id: 12, memberId: created.id, amount: 79.99, type: 'CHARGE', status: 'SUCCESS' },
    ];
    paymentServiceClient.getMemberPayments.mockResolvedValue({ status: 200, body: history });

    const payments = await request(app).get(`/api/members/${created.id}/payments`);
    expect(payments.status).toBe(200);

    const after = await request(app).get(`/api/members/${created.id}`);
    expect(after.status).toBe(200);
    expect(after.body.refundStatus).toBe('PENDING');
    expect(after.body.refundNeedsFollowUp).toBe(true);
  });

  it('returns 503 and leaves the stored refund outcome alone when the service is unreachable', async () => {
    const created = await createMember();
    await markRefundPending(created.id);
    const unavailable = new Error('connect ECONNREFUSED');
    unavailable.code = PAYMENTS_UNAVAILABLE;
    paymentServiceClient.getMemberPayments.mockRejectedValue(unavailable);

    const res = await request(app).get(`/api/members/${created.id}/payments`);

    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/try again later/i);

    const after = await request(app).get(`/api/members/${created.id}`);
    expect(after.status).toBe(200);
    expect(after.body.refundStatus).toBe('PENDING');
    expect(after.body.refundNeedsFollowUp).toBe(true);
  });

  it('returns 502 and leaves the stored refund outcome alone when the service answers with an error', async () => {
    const created = await createMember();
    await markRefundPending(created.id);
    paymentServiceClient.getMemberPayments.mockResolvedValue({
      status: 500,
      body: { message: 'boom' },
    });

    const res = await request(app).get(`/api/members/${created.id}/payments`);

    expect(res.status).toBe(502);

    const after = await request(app).get(`/api/members/${created.id}`);
    expect(after.status).toBe(200);
    expect(after.body.refundStatus).toBe('PENDING');
    expect(after.body.refundNeedsFollowUp).toBe(true);
  });
});
