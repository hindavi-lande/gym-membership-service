const memberService = require('./memberService');
const paymentsClient = require('../clients/paymentsClient');
const { getPlanPrice } = require('../constants/planPrices');

function toDateOnlyString(value) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function todayDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

// Base is the existing renewal date (or today), advanced by exactly one calendar
// month with the day clamped to the target month's last day so DATEONLY stays valid.
function computeNextRenewalDate(currentRenewalDate, today) {
  const base = toDateOnlyString(currentRenewalDate || today);
  const [year, month, day] = base.split('-').map(Number);

  const targetMonthIndex = month;
  const daysInTargetMonth = new Date(Date.UTC(year, targetMonthIndex + 1, 0)).getUTCDate();
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = (targetMonthIndex % 12) + 1;

  const pad = (value) => String(value).padStart(2, '0');

  return `${targetYear}-${pad(targetMonth)}-${pad(Math.min(day, daysInTargetMonth))}`;
}

async function renewMember(id) {
  const member = await memberService.getMemberById(id);
  const amount = getPlanPrice(member.membershipPlan);

  const payment = await paymentsClient.createCharge({
    memberId: member.id,
    amount,
    reason: `${member.membershipPlan} plan renewal`,
  });

  const renewalDate = computeNextRenewalDate(member.renewalDate, todayDateOnly());
  await member.update({ renewalDate });

  return { member, payment };
}

async function listRenewals(id) {
  return paymentsClient.getMemberPayments(id);
}

module.exports = {
  computeNextRenewalDate,
  renewMember,
  listRenewals,
};
