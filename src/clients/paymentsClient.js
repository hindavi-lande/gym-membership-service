const ApiError = require('../utils/ApiError');

const DEFAULT_PAYMENTS_SERVICE_URL = 'http://localhost:3001';
const REQUEST_TIMEOUT_MS = 10000;

function baseUrl() {
  const url = process.env.PAYMENTS_SERVICE_URL || DEFAULT_PAYMENTS_SERVICE_URL;
  return url.replace(/\/+$/, '');
}

async function movePayments(fromMemberId, toMemberId) {
  const url = `${baseUrl()}/api/payments/merge`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromMemberId, toMemberId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiError(502, `Unable to move payments: ${err.message}`);
  }

  if (!response.ok) {
    throw new ApiError(502, `Unable to move payments: payments service responded with ${response.status}`);
  }

  try {
    return await response.json();
  } catch (err) {
    throw new ApiError(502, `Unable to move payments: invalid response from payments service`);
  }
}

module.exports = {
  movePayments,
};
