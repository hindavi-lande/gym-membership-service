// Plan prices are intentionally hardcoded here: neither service stores pricing
// and plan CRUD is out of scope. This is the only place a plan price may live.
const PLAN_PRICES = Object.freeze({
  BASIC: 29.99,
  STANDARD: 39.99,
  PREMIUM: 49.99,
});

module.exports = { PLAN_PRICES };
