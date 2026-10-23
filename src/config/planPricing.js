const ApiError = require('../utils/ApiError');

// Authoritative renewal prices per plan. Keys must match the
// Member.membershipPlan ENUM values exactly.
const PLAN_PRICES = {
  BASIC: 19.99,
  STANDARD: 29.99,
  PREMIUM: 49.99,
};

function getPlanPrice(plan) {
  if (!Object.prototype.hasOwnProperty.call(PLAN_PRICES, plan)) {
    throw new ApiError(400, `Unknown membership plan: ${plan}`);
  }
  return PLAN_PRICES[plan];
}

module.exports = {
  PLAN_PRICES,
  getPlanPrice,
};
