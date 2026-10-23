process.env.NODE_ENV = 'test';

const http = require('node:http');
const {
  oneMonthBefore,
  daysBetween,
  proratedRefundAmount,
} = require('../src/utils/refundCalculation');
const paymentServiceClient = require('../src/clients/paymentServiceClient');

const { PAYMENTS_UNAVAILABLE } = paymentServiceClient;

describe('oneMonthBefore', () => {
  it('subtracts one UTC month keeping the day of the month', () => {
    expect(oneMonthBefore('2024-04-15')).toBe('2024-03-15');
    expect(oneMonthBefore('2024-01-10')).toBe('2023-12-10');
  });

  it('rolls a month-end date back exactly like the renewal month arithmetic', () => {
    // Mirrors oneMonthFromToday's Date.UTC + setUTCMonth arithmetic in
    // memberService, so period start and period end roll the same way.
    const utcMonthShift = (dateOnly, months) => {
      const [year, month, day] = dateOnly.split('-').map(Number);
      const shifted = new Date(Date.UTC(year, month - 1, day));
      shifted.setUTCMonth(shifted.getUTCMonth() + months);
      return shifted.toISOString().slice(0, 10);
    };

    expect(oneMonthBefore('2024-03-31')).toBe(utcMonthShift('2024-03-31', -1));
    expect(oneMonthBefore('2024-03-31')).toBe('2024-03-02');
  });
});

describe('daysBetween', () => {
  it('counts whole UTC days between two dates', () => {
    expect(daysBetween('2024-04-01', '2024-05-01')).toBe(30);
    expect(daysBetween('2024-03-01', '2024-04-01')).toBe(31);
  });

  it('is zero for the same date', () => {
    expect(daysBetween('2024-04-01', '2024-04-01')).toBe(0);
  });

  it('is negative when the second date is earlier', () => {
    expect(daysBetween('2024-05-01', '2024-04-01')).toBe(-30);
  });
});

describe('proratedRefundAmount', () => {
  it('refunds the unused share of a 30 day period', () => {
    const amount = proratedRefundAmount({
      chargeAmount: 79.99,
      renewalDate: '2024-05-01',
      today: '2024-04-21',
    });

    expect(amount).toBe(26.66);
  });

  it('refunds the whole charge when no day of the period was used', () => {
    const amount = proratedRefundAmount({
      chargeAmount: 79.99,
      renewalDate: '2024-05-01',
      today: '2024-04-01',
    });

    expect(amount).toBe(79.99);
  });

  it('refunds nothing when no days remain or the period has already ended', () => {
    const renewalDate = '2024-05-01';

    expect(
      proratedRefundAmount({ chargeAmount: 79.99, renewalDate, today: '2024-05-01' }),
    ).toBe(0);
    expect(
      proratedRefundAmount({ chargeAmount: 79.99, renewalDate, today: '2024-05-10' }),
    ).toBe(0);
  });

  it('never returns more than the charge amount, even when rounding would', () => {
    const chargeAmount = 1.005;

    const amount = proratedRefundAmount({
      chargeAmount,
      renewalDate: '2024-05-01',
      today: '2024-04-01',
    });

    expect(amount).toBeGreaterThanOrEqual(0);
    expect(amount).toBeLessThanOrEqual(chargeAmount);
  });
});

let server;
let handler;
let received;

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function listen(serverToStart) {
  await new Promise((resolve) => serverToStart.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${serverToStart.address().port}`;
}

async function stop(serverToStop) {
  if (typeof serverToStop.closeAllConnections === 'function') {
    serverToStop.closeAllConnections();
  }
  await new Promise((resolve) => serverToStop.close(resolve));
}

async function unusedPort() {
  const throwaway = http.createServer();
  await new Promise((resolve) => throwaway.listen(0, '127.0.0.1', resolve));
  const { port } = throwaway.address();
  await stop(throwaway);
  return port;
}

beforeEach(async () => {
  received = [];
  handler = (req, res) => sendJson(res, 200, {});

  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'],
        body: raw ? JSON.parse(raw) : null,
      });
      handler(req, res);
    });
  });

  process.env.PAYMENTS_SERVICE_URL = await listen(server);
});

afterEach(async () => {
  if (server) {
    await stop(server);
    server = null;
  }
  delete process.env.PAYMENTS_SERVICE_URL;
  delete process.env.PAYMENTS_SERVICE_TIMEOUT_MS;
});

describe('paymentServiceClient.refund', () => {
  const refundRequest = {
    memberId: 7,
    amount: 26.66,
    reason: 'PREMIUM plan cancellation refund',
    relatedPaymentId: 12,
  };

  it('posts the refund to /api/payments/refund and resolves the 201 response', async () => {
    const created = {
      id: 20,
      memberId: 7,
      amount: 26.66,
      type: 'REFUND',
      status: 'SUCCESS',
      relatedPaymentId: 12,
    };
    handler = (req, res) => sendJson(res, 201, created);

    const result = await paymentServiceClient.refund(refundRequest);

    expect(result).toEqual({ status: 201, body: created });
    expect(received).toHaveLength(1);
    expect(received[0].method).toBe('POST');
    expect(received[0].url).toBe('/api/payments/refund');
    expect(received[0].contentType).toBe('application/json');
    expect(received[0].body).toEqual(refundRequest);
  });

  it('resolves an already refunded 409 instead of throwing', async () => {
    handler = (req, res) => sendJson(res, 409, { message: 'Payment 12 has already been refunded' });

    const result = await paymentServiceClient.refund(refundRequest);

    expect(result.status).toBe(409);
    expect(result.body.message).toMatch(/already been refunded/i);
  });

  it('resolves a 422 over-charge response instead of throwing', async () => {
    handler = (req, res) => sendJson(res, 422, { message: 'Refund exceeds payment 12' });

    const result = await paymentServiceClient.refund(refundRequest);

    expect(result).toEqual({ status: 422, body: { message: 'Refund exceeds payment 12' } });
  });

  it('rejects with code PAYMENTS_SERVICE_UNAVAILABLE when nothing is listening', async () => {
    const port = await unusedPort();
    process.env.PAYMENTS_SERVICE_URL = `http://127.0.0.1:${port}`;

    await expect(paymentServiceClient.refund(refundRequest)).rejects.toMatchObject({
      code: PAYMENTS_UNAVAILABLE,
    });
  });

  it('rejects with code PAYMENTS_SERVICE_UNAVAILABLE when the request times out', async () => {
    process.env.PAYMENTS_SERVICE_TIMEOUT_MS = '50';
    handler = () => {};

    await expect(paymentServiceClient.refund(refundRequest)).rejects.toMatchObject({
      code: PAYMENTS_UNAVAILABLE,
    });
  });
});
