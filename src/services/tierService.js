const SILVER_MIN_SPEND = 100;
const GOLD_MIN_SPEND = 500;
const UNAVAILABLE = 'UNAVAILABLE';

function computeTier(spend) {
  const rounded = Math.round(spend * 100) / 100;

  if (rounded >= GOLD_MIN_SPEND) {
    return 'GOLD';
  }

  if (rounded >= SILVER_MIN_SPEND) {
    return 'SILVER';
  }

  return 'BRONZE';
}

module.exports = {
  SILVER_MIN_SPEND,
  GOLD_MIN_SPEND,
  UNAVAILABLE,
  computeTier,
};
