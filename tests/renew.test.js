process.env.DB_STORAGE = ':memory:';

const request = require('supertest');
const app = require('../src/app');
const { sequelize, Member } = require('../src/models');
const paymentsClient = require('../src/clients/paymentsClient');
const ApiError = require('../src/utils/ApiError');

jest.mock('../src/clients/paymentsClient');

const STALE_RENEWAL_DATE = '2020-01-01';
const UNAVAILABLE_MESSAGE = 'Payment service is unavailable. Please try again later.';

let emailCounter = 0;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function oneYearFromToday() {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 1);
  return date.toISOString().slice(0, 10);
}

async function createMember(overrides = {}) {
  emailCounter += 1;
  return Member.create({
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: `ada.${emailCounter}@example.com`,
    membershipPlan: 'STANDARD',
    renewalDate: STALE_RENEWAL_DATE,
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

describe('POST /api/members/:id/renew', () => {
  it.each([
    ['BASIC', 29.99],
    ['STANDARD', 49.99],
    ['PREMIUM', 79.99],
  ])('charges the %s plan price of %s and moves renewalDate one year forward', async (plan, price) => {
    const member = await createMember({ membershipPlan: plan });
    paymentsClient.charge.mockResolvedValue({
      id: 1,
      memberId: member.id,
      amount: price,
      reason: `Membership renewal - ${plan}`,
      type: 'CHARGE',
      status: 'SUCCESS',
    });

    const res = await request(app).post(`/api/members/${member.id}/renew`).expect(200);

    expect(paymentsClient.charge).toHaveBeenCalledTimes(1);
    expect(paymentsClient.charge).toHaveBeenCalledWith({
      memberId: member.id,
      amount: price,
      reason: expect.stringMatching(/renewal/i),
    });

    expect(res.body.payment.status).toBe('SUCCESS');
    expect(res.body.payment.amount).toBe(price);
    expect(res.body.payment.memberId).toBe(member.id);
    expect(res.body.member.renewalDate).toBe(oneYearFromToday());

    const reloaded = await Member.findByPk(member.id);
    expect(reloaded.renewalDate).toBe(oneYearFromToday());

    const fetched = await request(app).get(`/api/members/${member.id}`).expect(200);
    expect(fetched.body.renewalDate).toBe(oneYearFromToday());
  });

  it('returns 503 and leaves renewalDate untouched when the payments service cannot be reached', async () => {
    const member = await createMember();
    paymentsClient.charge.mockRejectedValue(new ApiError(503, UNAVAILABLE_MESSAGE));

    const res = await request(app).post(`/api/members/${member.id}/renew`).expect(503);

    expect(res.body.message).toMatch(/try again later/i);

    const reloaded = await Member.findByPk(member.id);
    expect(reloaded.renewalDate).toBe(STALE_RENEWAL_DATE);
  });

  it('returns 402 and leaves renewalDate untouched when the charge is declined', async () => {
    const member = await createMember();
    paymentsClient.charge.mockResolvedValue({
      id: 2,
      memberId: member.id,
      amount: 49.99,
      reason: 'Membership renewal - STANDARD',
      type: 'CHARGE',
      status: 'FAILED',
    });

    const res = await request(app).post(`/api/members/${member.id}/renew`).expect(402);

    expect(res.body.message).toMatch(/did not go through/i);

    const reloaded = await Member.findByPk(member.id);
    expect(reloaded.renewalDate).toBe(STALE_RENEWAL_DATE);
  });

  it('returns 402 and leaves renewalDate untouched when the charge is only pending', async () => {
    const member = await createMember();
    paymentsClient.charge.mockResolvedValue({
      id: 3,
      memberId: member.id,
      amount: 49.99,
      reason: 'Membership renewal - STANDARD',
      type: 'CHARGE',
      status: 'PENDING',
    });

    const res = await request(app).post(`/api/members/${member.id}/renew`).expect(402);

    expect(res.body.message).toMatch(/did not go through/i);

    const reloaded = await Member.findByPk(member.id);
    expect(reloaded.renewalDate).toBe(STALE_RENEWAL_DATE);
  });

  it('returns 404 for an unknown member and attempts no charge', async () => {
    const res = await request(app).post('/api/members/999999/renew').expect(404);

    expect(res.body.message).toMatch(/not found/i);
    expect(paymentsClient.charge).not.toHaveBeenCalled();
  });
});

describe('member CRUD', () => {
  it('defaults renewalDate to today when a member is created without one', async () => {
    const res = await request(app)
      .post('/api/members')
      .send({ firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.com' })
      .expect(201);

    expect(res.body.firstName).toBe('Grace');
    expect(res.body.membershipPlan).toBe('BASIC');
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body).toHaveProperty('renewalDate');

    const fetched = await request(app).get(`/api/members/${res.body.id}`).expect(200);
    expect(fetched.body.renewalDate.slice(0, 10)).toBe(today());
  });

  it('rejects an explicit null renewalDate with 400', async () => {
    const res = await request(app)
      .post('/api/members')
      .send({
        firstName: 'Grace',
        lastName: 'Hopper',
        email: 'grace.null@example.com',
        renewalDate: null,
      })
      .expect(400);

    expect(res.body.message).toBeTruthy();
  });

  it('includes renewalDate when listing and fetching members', async () => {
    const member = await createMember();

    const list = await request(app).get('/api/members').expect(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body.find((entry) => entry.id === member.id).renewalDate).toBe(STALE_RENEWAL_DATE);

    const fetched = await request(app).get(`/api/members/${member.id}`).expect(200);
    expect(fetched.body.renewalDate).toBe(STALE_RENEWAL_DATE);
  });
});
