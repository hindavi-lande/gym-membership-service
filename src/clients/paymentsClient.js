const http = require('http');
const https = require('https');
const ApiError = require('../utils/ApiError');

const PAYMENTS_SERVICE_URL = process.env.PAYMENTS_SERVICE_URL || 'http://localhost:3001';

const REQUEST_TIMEOUT_MS = 5000;
const UNAVAILABLE_MESSAGE = 'Payment service is unavailable. Please try again later.';

function requestJson(pathname, { method = 'GET', body = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, PAYMENTS_SERVICE_URL);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const transport = url.protocol === 'https:' ? https : http;

    const headers = {};
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = transport.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new ApiError(503, UNAVAILABLE_MESSAGE));
            return;
          }

          try {
            resolve(data ? JSON.parse(data) : null);
          } catch (err) {
            reject(new ApiError(503, UNAVAILABLE_MESSAGE));
          }
        });
      }
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new ApiError(503, UNAVAILABLE_MESSAGE));
    });

    req.on('error', () => {
      reject(new ApiError(503, UNAVAILABLE_MESSAGE));
    });

    if (payload !== undefined) {
      req.write(payload);
    }

    req.end();
  });
}

async function charge({ memberId, amount, reason }) {
  return requestJson('/api/payments/charge', {
    method: 'POST',
    body: { memberId, amount, reason },
  });
}

async function getHistoryForMember(memberId) {
  return requestJson(`/api/payments/member/${memberId}`);
}

module.exports = {
  PAYMENTS_SERVICE_URL,
  charge,
  getHistoryForMember,
};
