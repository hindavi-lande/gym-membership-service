const memberService = require('./memberService');
const paymentsClient = require('./paymentsClient');
const { getPlanPrice } = require('../config/planPricing');
const ApiError = require('../utils/ApiError');

const RENEWAL_PERIOD_DAYS = 30;

function computeRenewalDate(from = new Date()) {
  const date = new Date(from.getTime());
  date.setDate(date.getDate() + RENEWAL_PERIOD_DAYS);
  return date.toISOString().slice(0, 10);
}

async function renewMembership(memberId) {
  // An unknown id is a 404 before any money is discussed.
  const member = await memberService.getMemberById(memberId);

  const amount = getPlanPrice(member.membershipPlan);

  const payment = await paymentsClient.charge({
    memberId: member.id,
    amount,
    reason: `${member.membershipPlan} plan renewal`,
  });

  if (payment.status !== 'SUCCESS') {
    throw new ApiError(402, 'Payment did not go through, please try again later');
  }

  // Status is deliberately left untouched: renewal only stamps the date.
  await member.update({ renewalDate: computeRenewalDate() });

  return { member, payment };
}

module.exports = {
  computeRenewalDate,
  renewMembership,
};
