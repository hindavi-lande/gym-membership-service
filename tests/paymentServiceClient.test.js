process.env.NODE_ENV = 'test';

const http = require('node:http');
const paymentServiceClient = require('../src/clients/paymentServiceClient');

const { PAYMENTS_UNAVAILABLE, PaymentsServiceUnavailableError } = paymentServiceClient;

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

describe('paymentServiceClient.charge', () => {
  it('posts a JSON body to /api/payments/charge and resolves the 201 response', async () => {
    const created = { id: 1, memberId: 7, amount: 12.5, type: 'CHARGE', status: 'SUCCESS' };
    handler = (req, res) => sendJson(res, 201, created);

    const result = await paymentServiceClient.charge({
      memberId: 7,
      amount: 12.5,
      reason: 'PREMIUM plan renewal',
    });

    expect(result).toEqual({ status: 201, body: created });
    expect(received).toHaveLength(1);
    expect(received[0].method).toBe('POST');
    expect(received[0].url).toBe('/api/payments/charge');
    expect(received[0].contentType).toBe('application/json');
    expect(received[0].body).toEqual({
      memberId: 7,
      amount: 12.5,
      reason: 'PREMIUM plan renewal',
    });
  });

  it('resolves instead of throwing when the charge is declined with a 402', async () => {
    handler = (req, res) => sendJson(res, 402, { message: 'Payment declined by issuer' });

    const result = await paymentServiceClient.charge({
      memberId: 7,
      amount: 4.25,
      reason: 'BASIC plan renewal',
    });

    expect(result).toEqual({ status: 402, body: { message: 'Payment declined by issuer' } });
  });

  it('resolves a non-JSON response body as null', async () => {
    handler = (req, res) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('bad gateway');
    };

    const result = await paymentServiceClient.charge({
      memberId: 7,
      amount: 6.5,
      reason: 'STANDARD plan renewal',
    });

    expect(result).toEqual({ status: 502, body: null });
  });
});

describe('paymentServiceClient.getMemberPayments', () => {
  it('gets the member payment history and resolves it unchanged', async () => {
    const history = [
      { id: 2, memberId: 7, amount: 9.75, type: 'CHARGE', status: 'SUCCESS' },
      { id: 1, memberId: 7, amount: 9.75, type: 'CHARGE', status: 'SUCCESS' },
    ];
    handler = (req, res) => sendJson(res, 200, history);

    const result = await paymentServiceClient.getMemberPayments(7);

    expect(result).toEqual({ status: 200, body: history });
    expect(received[0].method).toBe('GET');
    expect(received[0].url).toBe('/api/payments/member/7');
    expect(received[0].body).toBeNull();
  });

  it('resolves a non-2xx history response instead of throwing', async () => {
    handler = (req, res) => sendJson(res, 500, { message: 'boom' });

    const result = await paymentServiceClient.getMemberPayments(7);

    expect(result).toEqual({ status: 500, body: { message: 'boom' } });
  });
});

describe('paymentServiceClient transport failures', () => {
  it('rejects with code PAYMENTS_SERVICE_UNAVAILABLE when nothing is listening', async () => {
    const port = await unusedPort();
    process.env.PAYMENTS_SERVICE_URL = `http://127.0.0.1:${port}`;

    await expect(
      paymentServiceClient.charge({ memberId: 7, amount: 3.5, reason: 'BASIC plan renewal' }),
    ).rejects.toMatchObject({ code: PAYMENTS_UNAVAILABLE });

    expect(PAYMENTS_UNAVAILABLE).toBe('PAYMENTS_SERVICE_UNAVAILABLE');
    await expect(
      paymentServiceClient.charge({ memberId: 7, amount: 3.5, reason: 'BASIC plan renewal' }),
    ).rejects.toBeInstanceOf(PaymentsServiceUnavailableError);
  });

  it('rejects with code PAYMENTS_SERVICE_UNAVAILABLE when the request times out', async () => {
    process.env.PAYMENTS_SERVICE_TIMEOUT_MS = '50';
    handler = () => {};

    await expect(paymentServiceClient.getMemberPayments(7)).rejects.toMatchObject({
      code: PAYMENTS_UNAVAILABLE,
    });
  });
});

describe('paymentServiceClient base URL resolution', () => {
  it('reads PAYMENTS_SERVICE_URL on every call rather than at module load', async () => {
    const secondCalls = [];
    const secondServer = http.createServer((req, res) => {
      secondCalls.push({ method: req.method, url: req.url });
      sendJson(res, 200, []);
    });

    try {
      const secondUrl = await listen(secondServer);

      await paymentServiceClient.getMemberPayments(1);
      process.env.PAYMENTS_SERVICE_URL = secondUrl;
      await paymentServiceClient.getMemberPayments(2);

      expect(received.map((call) => call.url)).toEqual(['/api/payments/member/1']);
      expect(secondCalls).toEqual([{ method: 'GET', url: '/api/payments/member/2' }]);
    } finally {
      await stop(secondServer);
    }
  });
});
