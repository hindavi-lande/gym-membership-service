// Renewal price per membership plan, in the currency the payments service charges in.
// Keys must match the Member.membershipPlan enum values exactly.
const PLAN_PRICING = Object.freeze({
  BASIC: 29.99,
  STANDARD: 49.99,
  PREMIUM: 79.99,
});

module.exports = { PLAN_PRICING };
