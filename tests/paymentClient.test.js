process.env.NODE_ENV = 'test';

const http = require('http');

const paymentClient = require('../src/clients/paymentClient');
const ApiError = require('../src/utils/ApiError');

// The client is required above, before PAYMENTS_SERVICE_URL is set: every test
// below sets or clears the env var afterwards, which proves the base URL is
// resolved per call rather than once at import time.
const openServers = [];

function startStubServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    openServers.push(server);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    server.close(() => resolve());
  });
}

async function captureError(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('Expected the promise to reject, but it resolved');
}

let originalUrl;

beforeEach(() => {
  originalUrl = process.env.PAYMENTS_SERVICE_URL;
});

afterEach(async () => {
  if (originalUrl === undefined) {
    delete process.env.PAYMENTS_SERVICE_URL;
  } else {
    process.env.PAYMENTS_SERVICE_URL = originalUrl;
  }
  await Promise.all(openServers.splice(0).map(closeServer));
});

describe('paymentClient.getBaseUrl', () => {
  it('defaults to http://localhost:3001 when PAYMENTS_SERVICE_URL is unset', () => {
    delete process.env.PAYMENTS_SERVICE_URL;

    expect(paymentClient.getBaseUrl()).toBe('http://localhost:3001');
  });

  it('honours PAYMENTS_SERVICE_URL and strips a trailing slash', async () => {
    const { url } = await startStubServer((req, res) => res.end('{}'));
    process.env.PAYMENTS_SERVICE_URL = `${url}/`;

    expect(paymentClient.getBaseUrl()).toBe(url);
  });
});

describe('paymentClient.charge', () => {
  it('POSTs the charge and resolves with the persisted payment on 201', async () => {
    let received;
    const { url } = await startStubServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        received = { method: req.method, url: req.url, body: JSON.parse(raw) };
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 7,
            memberId: 1,
            amount: 20,
            reason: 'test charge',
            status: 'SUCCESS',
          })
        );
      });
    });
    process.env.PAYMENTS_SERVICE_URL = url;

    const payment = await paymentClient.charge({
      memberId: 1,
      amount: 20,
      reason: 'test charge',
    });

    expect(received.method).toBe('POST');
    expect(received.url).toBe('/api/payments/charge');
    expect(received.body).toEqual({
      memberId: 1,
      amount: 20,
      reason: 'test charge',
    });
    expect(payment).toEqual({
      id: 7,
      memberId: 1,
      amount: 20,
      reason: 'test charge',
      status: 'SUCCESS',
    });
  });

  it('rejects with ApiError 402 when the charge is declined', async () => {
    const { url } = await startStubServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 9, memberId: 1, amount: 12.5, status: 'FAILED' }));
      });
    });
    process.env.PAYMENTS_SERVICE_URL = url;

    const error = await captureError(
      paymentClient.charge({ memberId: 1, amount: 12.5, reason: 'test charge' })
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.statusCode).toBe(402);
    expect(error.message).toMatch(/declined/i);
  });

  it('rejects with ApiError 503 when the connection is refused', async () => {
    const { server, url } = await startStubServer((req, res) => res.end('{}'));
    await closeServer(server);
    process.env.PAYMENTS_SERVICE_URL = url;

    const error = await captureError(
      paymentClient.charge({ memberId: 1, amount: 12.5, reason: 'test charge' })
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.statusCode).toBe(503);
    expect(error.message).toContain('try again later');
  });
});

describe('paymentClient.getMemberPayments', () => {
  it('resolves with the raw history array from the payments service', async () => {
    const history = [
      { id: 1, memberId: 4, amount: 20, reason: 'test charge', status: 'SUCCESS' },
      { id: 2, memberId: 4, amount: 20, reason: 'test charge', status: 'FAILED' },
    ];
    let receivedUrl;
    const { url } = await startStubServer((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(history));
    });
    process.env.PAYMENTS_SERVICE_URL = url;

    const payments = await paymentClient.getMemberPayments(4);

    expect(receivedUrl).toBe('/api/payments/member/4');
    expect(payments).toEqual(history);
  });

  it('rejects with ApiError 503 when the payments service cannot be reached', async () => {
    const { server, url } = await startStubServer((req, res) => res.end('[]'));
    await closeServer(server);
    process.env.PAYMENTS_SERVICE_URL = url;

    const error = await captureError(paymentClient.getMemberPayments(4));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.statusCode).toBe(503);
    expect(error.message).toContain('try again later');
  });
});
