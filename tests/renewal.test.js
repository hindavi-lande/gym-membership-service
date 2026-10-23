process.env.DB_STORAGE = ':memory:';
process.env.NODE_ENV = 'test';
process.env.PAYMENTS_SERVICE_URL = 'http://payments.test';

const request = require('supertest');
const app = require('../src/app');
const { sequelize, Member } = require('../src/models');

const PAYMENTS_BASE_URL = 'http://payments.test';
const originalFetch = global.fetch;

const validMember = {
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
  membershipPlan: 'PREMIUM',
};

// Minimal stand-in for a fetch Response as used by src/clients/paymentsClient.
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function todayDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

// Expected one-month advance of a 'YYYY-MM-DD' date, day clamped to the
// target month's last day.
function expectedRenewalDate(baseDateOnly) {
  const [year, month, day] = baseDateOnly.split('-').map(Number);
  const nextMonth = new Date(Date.UTC(year, month, 1));
  const targetYear = nextMonth.getUTCFullYear();
  const targetMonth = nextMonth.getUTCMonth() + 1;
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const pad = (value) => String(value).padStart(2, '0');

  return `${targetYear}-${pad(targetMonth)}-${pad(Math.min(day, daysInTargetMonth))}`;
}

async function createMember(overrides = {}) {
  const res = await request(app)
    .post('/api/members')
    .send({ ...validMember, ...overrides });
  return res.body;
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(async () => {
  await Member.destroy({ where: {}, truncate: true });
  global.fetch = originalFetch;
});

afterAll(async () => {
  global.fetch = originalFetch;
  await sequelize.close();
});

describe('POST /api/members/:id/renew', () => {
  it('charges the plan price and advances the renewal date by one month', async () => {
    const member = await createMember();
    const charge = {
      id: 1,
      memberId: member.id,
      amount: 79.99,
      reason: 'PREMIUM plan renewal',
      type: 'CHARGE',
      status: 'SUCCESS',
    };
    global.fetch.mockResolvedValue(jsonResponse(charge, 201));

    const res = await request(app).post(`/api/members/${member.id}/renew`);

    expect(res.status).toBe(200);
    expect(res.body.payment).toEqual(charge);

    const expectedRenewal = expectedRenewalDate(todayDateOnly());
    expect(res.body.member.renewalDate).toBe(expectedRenewal);

    const after = await request(app).get(`/api/members/${member.id}`);
    expect(after.body.renewalDate).toBe(expectedRenewal);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(`${PAYMENTS_BASE_URL}/api/payments/charge`);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toMatchObject({ memberId: member.id, amount: 79.99 });
  });

  it('advances from the existing renewal date on a second renewal', async () => {
    const member = await createMember();
    const updated = await request(app)
      .put(`/api/members/${member.id}`)
      .send({ renewalDate: '2024-01-31' });
    expect(updated.status).toBe(200);
    expect(updated.body.renewalDate).toBe('2024-01-31');

    global.fetch.mockResolvedValue(
      jsonResponse({ id: 1, memberId: member.id, amount: 79.99, type: 'CHARGE', status: 'SUCCESS' }, 201)
    );

    const first = await request(app).post(`/api/members/${member.id}/renew`);
    expect(first.status).toBe(200);
    expect(first.body.member.renewalDate).toBe('2024-02-29');

    const second = await request(app).post(`/api/members/${member.id}/renew`);
    expect(second.status).toBe(200);
    expect(second.body.member.renewalDate).toBe('2024-03-29');

    const after = await request(app).get(`/api/members/${member.id}`);
    expect(after.body.renewalDate).toBe('2024-03-29');
  });

  it('does not apply the renewal when the charge is declined', async () => {
    const member = await createMember();
    global.fetch.mockResolvedValue(jsonResponse({ message: 'Payment declined' }, 402));

    const res = await request(app).post(`/api/members/${member.id}/renew`);

    expect(res.status).toBe(402);
    expect(res.body.message).toMatch(/declin/i);

    const after = await request(app).get(`/api/members/${member.id}`);
    expect(after.body.renewalDate).toBeNull();
  });

  it('asks the member to try again later when the payments service cannot be reached', async () => {
    const member = await createMember();
    global.fetch.mockRejectedValue(new TypeError('fetch failed'));

    const res = await request(app).post(`/api/members/${member.id}/renew`);

    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/try again later/i);

    const after = await request(app).get(`/api/members/${member.id}`);
    expect(after.body.renewalDate).toBeNull();
  });

  it('returns 404 for an unknown member without requesting a charge', async () => {
    const res = await request(app).post('/api/members/999999/renew');

    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('GET /api/members/:id/renewals', () => {
  it('proxies the payments history unchanged, including refunds', async () => {
    const member = await createMember();
    const history = [
      { id: 2, memberId: member.id, amount: 79.99, type: 'REFUND', status: 'SUCCESS' },
      { id: 1, memberId: member.id, amount: 79.99, type: 'CHARGE', status: 'SUCCESS' },
    ];
    global.fetch.mockResolvedValue(jsonResponse(history));

    const res = await request(app).get(`/api/members/${member.id}/renewals`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(history);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(`${PAYMENTS_BASE_URL}/api/payments/member/${member.id}`);
    expect(options.method).toBe('GET');
  });

  it('responds 503 when the payments service cannot be reached', async () => {
    const member = await createMember();
    global.fetch.mockRejectedValue(new TypeError('fetch failed'));

    const res = await request(app).get(`/api/members/${member.id}/renewals`);

    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/try again later/i);
  });
});
