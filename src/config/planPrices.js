const ApiError = require('../utils/ApiError');

const PLAN_PRICES = {
  BASIC: 20,
  STANDARD: 40,
  PREMIUM: 60,
};

function getPlanPrice(plan) {
  const price = PLAN_PRICES[plan];

  if (price === undefined) {
    throw new ApiError(422, `No price configured for plan ${plan}`);
  }

  return price;
}

module.exports = {
  PLAN_PRICES,
  getPlanPrice,
};
