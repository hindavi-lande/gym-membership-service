const http = require('node:http');
const https = require('node:https');

const PAYMENTS_UNAVAILABLE = 'PAYMENTS_SERVICE_UNAVAILABLE';

const DEFAULT_BASE_URL = 'http://localhost:3001';
const DEFAULT_TIMEOUT_MS = 5000;

// Thrown only when the payments service cannot be reached at all (connection
// refused, socket error, timeout). Callers detect it via err.code.
class PaymentsServiceUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PaymentsServiceUnavailableError';
    this.code = PAYMENTS_UNAVAILABLE;
  }
}

// Read on every call so tests and other environments can point the client at
// a stub without reloading the module.
function baseUrl() {
  return (process.env.PAYMENTS_SERVICE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function timeoutMs() {
  const configured = Number(process.env.PAYMENTS_SERVICE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

function parseBody(text) {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

// Resolves { status, body } for every HTTP response, including non-2xx ones.
// Rejects with a PaymentsServiceUnavailableError on transport failure or timeout.
function requestJson(method, requestPath, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload);

    let url;
    try {
      url = new URL(`${baseUrl()}${requestPath}`);
    } catch (err) {
      reject(new PaymentsServiceUnavailableError(`Invalid payments service URL: ${err.message}`));
      return;
    }

    const client = url.protocol === 'https:' ? https : http;
    const headers = { accept: 'application/json' };
    if (body !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }

    let settled = false;
    const fail = (message) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new PaymentsServiceUnavailableError(message));
    };

    const req = client.request(
      {
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve({
            status: res.statusCode,
            body: parseBody(Buffer.concat(chunks).toString('utf8')),
          });
        });
        res.on('error', (err) => fail(`Payments service request failed: ${err.message}`));
      },
    );

    req.setTimeout(timeoutMs(), () => {
      req.destroy(new PaymentsServiceUnavailableError('Payments service request timed out'));
    });

    req.on('error', (err) => {
      fail(
        err && err.code === PAYMENTS_UNAVAILABLE
          ? err.message
          : `Payments service is unavailable: ${err.message}`,
      );
    });

    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
}

async function charge({ memberId, amount, reason }) {
  return requestJson('POST', '/api/payments/charge', { memberId, amount, reason });
}

async function getMemberPayments(memberId) {
  return requestJson('GET', `/api/payments/member/${encodeURIComponent(memberId)}`);
}

module.exports = {
  charge,
  getMemberPayments,
  PaymentsServiceUnavailableError,
  PAYMENTS_UNAVAILABLE,
};
