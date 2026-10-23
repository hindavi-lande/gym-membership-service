const ApiError = require('../utils/ApiError');

const DEFAULT_BASE_URL = 'http://localhost:3001';

// Read at call time (not module load) so tests can point the client elsewhere.
function getBaseUrl() {
  const baseUrl = process.env.PAYMENTS_SERVICE_URL || DEFAULT_BASE_URL;
  return baseUrl.replace(/\/+$/, '');
}

async function request(url, options) {
  try {
    return await fetch(url, options);
  } catch (err) {
    throw new ApiError(503, 'Payments service is unavailable, please try again later');
  }
}

async function readBody(response) {
  try {
    return await response.json();
  } catch (err) {
    return null;
  }
}

async function createCharge({ memberId, amount, reason }) {
  const response = await request(`${getBaseUrl()}/api/payments/charge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ memberId, amount, reason }),
  });

  const body = await readBody(response);

  if (response.status === 402) {
    const message = body && body.message ? body.message : 'Payment declined';
    throw new ApiError(402, message);
  }

  if (!response.ok) {
    const message = body && body.message
      ? body.message
      : 'Payments service returned an unexpected response, please try again later';
    throw new ApiError(502, message);
  }

  return body;
}

async function getMemberPayments(memberId) {
  const response = await request(`${getBaseUrl()}/api/payments/member/${memberId}`, {
    method: 'GET',
  });

  const body = await readBody(response);

  if (!response.ok) {
    const message = body && body.message
      ? body.message
      : 'Payments service returned an unexpected response, please try again later';
    throw new ApiError(502, message);
  }

  return body;
}

module.exports = {
  getBaseUrl,
  createCharge,
  getMemberPayments,
};
