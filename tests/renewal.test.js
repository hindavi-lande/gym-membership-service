process.env.DB_STORAGE = ':memory:';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { sequelize, Member } = require('../src/models');

const PAYMENTS_BASE_URL = 'http://payments.test:4000';

const originalFetch = global.fetch;
const originalPaymentsUrl = process.env.PAYMENTS_SERVICE_URL;

let fetchMock;

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// The membership service stamps renewalDate as today + 30 days (YYYY-MM-DD).
function renewalDateInThirtyDays() {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return date.toISOString().slice(0, 10);
}

let emailCounter = 0;
function nextEmail() {
  emailCounter += 1;
  return `renewal-${emailCounter}@example.com`;
}

async function createMember(overrides = {}) {
  const res = await request(app)
    .post('/api/members')
    .send({
      firstName: 'Jane',
      lastName: 'Doe',
      email: nextEmail(),
      ...overrides,
    });

  return res.body;
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(() => {
  process.env.PAYMENTS_SERVICE_URL = PAYMENTS_BASE_URL;
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});

afterEach(async () => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
  await Member.destroy({ where: {}, truncate: true });
});

afterAll(async () => {
  if (originalPaymentsUrl === undefined) {
    delete process.env.PAYMENTS_SERVICE_URL;
  } else {
    process.env.PAYMENTS_SERVICE_URL = originalPaymentsUrl;
  }
  await sequelize.close();
});

describe('POST /api/members/:id/renew', () => {
  it('charges the plan price and sets renewalDate 30 days out, leaving status untouched', async () => {
    const member = await createMember({ membershipPlan: 'PREMIUM' });

    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          id: 1,
          memberId: member.id,
          amount: 49.99,
          type: 'CHARGE',
          status: 'SUCCESS',
        },
        201,
      ),
    );

    const res = await request(app).post(`/api/members/${member.id}/renew`);

    expect(res.status).toBe(200);
    expect(res.body.member.renewalDate).toBe(renewalDateInThirtyDays());
    expect(res.body.member.status).toBe('ACTIVE');
    expect(res.body.payment).toMatchObject({
      type: 'CHARGE',
      status: 'SUCCESS',
      memberId: member.id,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${PAYMENTS_BASE_URL}/api/payments/charge`);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toMatchObject({
      memberId: member.id,
      amount: 49.99,
    });
  });

  it('charges 29.99 for a STANDARD member', async () => {
    const member = await createMember({ membershipPlan: 'STANDARD' });

    fetchMock.mockResolvedValue(
      jsonResponse({ id: 1, memberId: member.id, amount: 29.99, type: 'CHARGE', status: 'SUCCESS' }, 201),
    );

    const res = await request(app).post(`/api/members/${member.id}/renew`);

    expect(res.status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      memberId: member.id,
      amount: 29.99,
    });
  });

  it('charges 19.99 for a BASIC member', async () => {
    const member = await createMember({ membershipPlan: 'BASIC' });

    fetchMock.mockResolvedValue(
      jsonResponse({ id: 1, memberId: member.id, amount: 19.99, type: 'CHARGE', status: 'SUCCESS' }, 201),
    );

    const res = await request(app).post(`/api/members/${member.id}/renew`);

    expect(res.status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      memberId: member.id,
      amount: 19.99,
    });
  });

  it('does not apply the renewal when the charge is declined', async () => {
    const member = await createMember({ membershipPlan: 'PREMIUM' });

    fetchMock.mockResolvedValue(
      jsonResponse({ id: 1, memberId: member.id, amount: 49.99, type: 'CHARGE', status: 'FAILED' }, 201),
    );

    const res = await request(app).post(`/api/members/${member.id}/renew`);

    expect(res.status).toBe(402);

    const after = await request(app).get(`/api/members/${member.id}`);
    expect(after.body.renewalDate).toBeNull();
  });

  it('does not apply the renewal when the payments service is unreachable', async () => {
    const member = await createMember({ membershipPlan: 'PREMIUM' });

    const connectionError = new Error('connect ECONNREFUSED 127.0.0.1:4000');
    connectionError.code = 'ECONNREFUSED';
    fetchMock.mockRejectedValue(connectionError);

    const res = await request(app).post(`/api/members/${member.id}/renew`);

    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/try again later/i);

    const after = await request(app).get(`/api/members/${member.id}`);
    expect(after.body.renewalDate).toBeNull();
  });

  it('returns 404 for an unknown member without charging', async () => {
    const res = await request(app).post('/api/members/999999/renew');

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/members/:id/payments', () => {
  it('proxies the member payment history unchanged', async () => {
    const member = await createMember();

    const payments = [
      { id: 1, memberId: member.id, amount: 49.99, type: 'CHARGE', status: 'SUCCESS' },
      { id: 2, memberId: member.id, amount: 49.99, type: 'REFUND', status: 'SUCCESS', relatedPaymentId: 1 },
    ];

    fetchMock.mockResolvedValue(jsonResponse(payments, 200));

    const res = await request(app).get(`/api/members/${member.id}/payments`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payments);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${PAYMENTS_BASE_URL}/api/payments/member/${member.id}`);
    expect(options.method).toBe('GET');
  });

  it('returns 503 when the payments service is unreachable during the history fetch', async () => {
    const member = await createMember();

    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:4000'));

    const res = await request(app).get(`/api/members/${member.id}/payments`);

    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/try again later/i);
  });
});
