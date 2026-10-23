process.env.DB_STORAGE = ':memory:';

const request = require('supertest');
const app = require('../src/app');
const { sequelize, Member } = require('../src/models');
const paymentsClient = require('../src/clients/paymentsClient');
const ApiError = require('../src/utils/ApiError');

jest.mock('../src/clients/paymentsClient');

const UNAVAILABLE_MESSAGE = 'Payment service is unavailable. Please try again later.';

let emailCounter = 0;

async function createMember(overrides = {}) {
  emailCounter += 1;
  return Member.create({
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: `history.${emailCounter}@example.com`,
    membershipPlan: 'STANDARD',
    ...overrides,
  });
}

beforeEach(async () => {
  await sequelize.sync({ force: true });
  jest.clearAllMocks();
});

afterAll(async () => {
  await sequelize.close();
});

describe('GET /api/members/:id/payments', () => {
  it('returns the payment history from the payments service unmodified', async () => {
    const member = await createMember();
    const history = [
      {
        id: 2,
        memberId: member.id,
        amount: 49.99,
        type: 'CHARGE',
        status: 'FAILED',
        reason: 'Membership renewal - STANDARD',
        createdAt: '2025-02-01T10:00:00.000Z',
      },
      {
        id: 1,
        memberId: member.id,
        amount: 49.99,
        type: 'CHARGE',
        status: 'SUCCESS',
        reason: 'Membership renewal - STANDARD',
        createdAt: '2025-01-01T10:00:00.000Z',
      },
    ];
    paymentsClient.getHistoryForMember.mockResolvedValue(history);

    const res = await request(app).get(`/api/members/${member.id}/payments`).expect(200);

    expect(res.body).toEqual(history);
    expect(paymentsClient.getHistoryForMember).toHaveBeenCalledTimes(1);
    expect(paymentsClient.getHistoryForMember).toHaveBeenCalledWith(member.id);
  });

  it('includes charges made through the renew endpoint', async () => {
    const member = await createMember();
    const payment = {
      id: 7,
      memberId: member.id,
      amount: 49.99,
      type: 'CHARGE',
      status: 'SUCCESS',
      reason: 'Membership renewal - STANDARD',
      createdAt: '2025-03-01T10:00:00.000Z',
    };
    paymentsClient.charge.mockResolvedValue(payment);
    paymentsClient.getHistoryForMember.mockResolvedValue([payment]);

    const renewRes = await request(app).post(`/api/members/${member.id}/renew`).expect(200);
    expect(renewRes.body.payment.status).toBe('SUCCESS');

    const res = await request(app).get(`/api/members/${member.id}/payments`).expect(200);
    expect(res.body).toEqual([payment]);
  });

  it('returns 404 for an unknown member without calling the payments service', async () => {
    const res = await request(app).get('/api/members/999999/payments').expect(404);

    expect(res.body.message).toMatch(/not found/i);
    expect(paymentsClient.getHistoryForMember).not.toHaveBeenCalled();
  });

  it('returns 503 when the payments service cannot be reached', async () => {
    const member = await createMember();
    paymentsClient.getHistoryForMember.mockRejectedValue(new ApiError(503, UNAVAILABLE_MESSAGE));

    const res = await request(app).get(`/api/members/${member.id}/payments`).expect(503);

    expect(res.body.message).toBe(UNAVAILABLE_MESSAGE);
    expect(res.body.message).toMatch(/try again later/i);
  });
});
