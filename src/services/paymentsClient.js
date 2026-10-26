const DEFAULT_PAYMENTS_SERVICE_URL = 'http://localhost:3001';
const REQUEST_TIMEOUT_MS = 3000;

function getBaseUrl() {
  return process.env.PAYMENTS_SERVICE_URL || DEFAULT_PAYMENTS_SERVICE_URL;
}

async function getMemberSpend(memberId) {
  const url = `${getBaseUrl()}/api/payments/member/${memberId}/spend`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Payments service responded with status ${response.status}`);
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw new Error(`Payments service returned an unreadable body: ${err.message}`);
  }

  const spend = body && body.spend;
  if (typeof spend !== 'number' || !Number.isFinite(spend)) {
    throw new Error('Payments service response did not contain a finite spend value');
  }

  return spend;
}

module.exports = {
  getMemberSpend,
};
