const ApiError = require('../utils/ApiError');

const UNAVAILABLE_MESSAGE = 'Payments service is unavailable, please try again later';
const DECLINED_MESSAGE = 'Payment did not go through; the renewal was not applied';
const REQUEST_TIMEOUT_MS = 5000;

function getPaymentsServiceUrl() {
  return process.env.PAYMENTS_SERVICE_URL || 'http://localhost:3001';
}

async function callPaymentsService(path, options) {
  try {
    return await fetch(`${getPaymentsServiceUrl()}${path}`, {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // network error or timeout: the payments service could not be reached
    throw new ApiError(503, UNAVAILABLE_MESSAGE);
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (err) {
    throw new ApiError(503, UNAVAILABLE_MESSAGE);
  }
}

async function createCharge({ memberId, amount, reason, status = 'SUCCESS' }) {
  const response = await callPaymentsService('/api/payments/charge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, amount, reason, status }),
  });

  if (response.status === 402) {
    throw new ApiError(402, DECLINED_MESSAGE);
  }

  if (response.status !== 201) {
    throw new ApiError(503, UNAVAILABLE_MESSAGE);
  }

  return readJson(response);
}

async function getMemberPayments(memberId) {
  const response = await callPaymentsService(`/api/payments/member/${memberId}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (response.status !== 200) {
    throw new ApiError(503, UNAVAILABLE_MESSAGE);
  }

  return readJson(response);
}

module.exports = {
  createCharge,
  getMemberPayments,
  getPaymentsServiceUrl,
};
