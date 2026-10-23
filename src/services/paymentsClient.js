const ApiError = require('../utils/ApiError');

const DEFAULT_BASE_URL = 'http://localhost:3001';
const REQUEST_TIMEOUT_MS = 5000;

const TRY_AGAIN_LATER = 'please try again later';

// Read at call time so tests and environments can change the target.
function baseUrl() {
  const url = process.env.PAYMENTS_SERVICE_URL || DEFAULT_BASE_URL;
  return url.replace(/\/+$/, '');
}

async function request(path, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    // global fetch (Node 18+) is looked up at call time so it can be stubbed.
    response = await fetch(`${baseUrl()}${path}`, {
      ...options,
      signal: controller.signal,
    });
  } catch (err) {
    // Connection refused, DNS failure, aborted timeout: the service is unreachable.
    throw new ApiError(503, `Payments service is unavailable, ${TRY_AGAIN_LATER}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new ApiError(502, `Payments service returned an error, ${TRY_AGAIN_LATER}`);
  }

  return response.json();
}

async function charge({ memberId, amount, reason }) {
  return request('/api/payments/charge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, amount, reason }),
  });
}

async function listForMember(memberId) {
  return request(`/api/payments/member/${memberId}`, { method: 'GET' });
}

module.exports = {
  baseUrl,
  charge,
  listForMember,
};
