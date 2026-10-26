const http = require('http');
const https = require('https');
const { URL } = require('url');

const ApiError = require('../utils/ApiError');

const PAYMENTS_UNAVAILABLE_MESSAGE =
  'Payment service is unavailable. Please try again later.';
const PAYMENT_DECLINED_MESSAGE =
  'Payment was declined by the payments service. The charge did not go through.';

const DEFAULT_BASE_URL = 'http://localhost:3001';
const REQUEST_TIMEOUT_MS = 5000;

// Read at call time (not import time) so tests can point the client at a stub
// server or a closed port after the module has been loaded.
function getBaseUrl() {
  const configured = process.env.PAYMENTS_SERVICE_URL || DEFAULT_BASE_URL;
  return configured.replace(/\/+$/, '');
}

function request(path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(`${getBaseUrl()}${path}`);
    } catch (err) {
      reject(new ApiError(503, PAYMENTS_UNAVAILABLE_MESSAGE));
      return;
    }

    const transport = url.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : JSON.stringify(body);

    const headers = { Accept: 'application/json' };
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          if (raw) {
            try {
              parsed = JSON.parse(raw);
            } catch (err) {
              parsed = null;
            }
          }

          if (res.statusCode === 402) {
            reject(new ApiError(402, PAYMENT_DECLINED_MESSAGE));
            return;
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
            return;
          }

          reject(new ApiError(503, PAYMENTS_UNAVAILABLE_MESSAGE));
        });
      }
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Payments service request timed out'));
    });

    req.on('error', () => {
      reject(new ApiError(503, PAYMENTS_UNAVAILABLE_MESSAGE));
    });

    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

function charge({ memberId, amount, reason }) {
  return request('/api/payments/charge', {
    method: 'POST',
    body: { memberId, amount, reason },
  });
}

function getMemberPayments(memberId) {
  return request(`/api/payments/member/${encodeURIComponent(memberId)}`);
}

module.exports = {
  PAYMENTS_UNAVAILABLE_MESSAGE,
  PAYMENT_DECLINED_MESSAGE,
  getBaseUrl,
  request,
  charge,
  getMemberPayments,
};
