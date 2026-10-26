const { Member } = require('../models');
const { PLAN_PRICES } = require('../config/planPricing');
const paymentClient = require('../clients/paymentClient');
const ApiError = require('../utils/ApiError');

async function listMembers() {
  return Member.findAll();
}

async function getMemberById(id) {
  const member = await Member.findByPk(id);
  if (!member) {
    throw new ApiError(404, `Member with id ${id} not found`);
  }
  return member;
}

async function createMember(data) {
  return Member.create(data);
}

async function updateMember(id, data) {
  const member = await getMemberById(id);
  return member.update(data);
}

async function deleteMember(id) {
  const member = await getMemberById(id);
  await member.destroy();
}

// Every plan renews for the same period: today + 30 days.
const RENEWAL_PERIOD_DAYS = 30;

function computeRenewalDate(from = new Date()) {
  const renewal = new Date(from.getTime());
  renewal.setUTCDate(renewal.getUTCDate() + RENEWAL_PERIOD_DAYS);
  return renewal.toISOString().slice(0, 10);
}

async function renewMember(id) {
  const member = await getMemberById(id);
  const price = PLAN_PRICES[member.membershipPlan];
  if (price === undefined) {
    throw new ApiError(400, `No price configured for plan ${member.membershipPlan}`);
  }

  // Charge first: a declined charge (402) or an unreachable payments service (503)
  // must leave the member untouched, so nothing is persisted until the charge resolves.
  await paymentClient.charge({
    memberId: member.id,
    amount: price,
    reason: `${member.membershipPlan} plan renewal`,
  });

  return member.update({ renewalDate: computeRenewalDate() });
}

async function getMemberPayments(id) {
  const member = await getMemberById(id);
  return paymentClient.getMemberPayments(member.id);
}

module.exports = {
  listMembers,
  getMemberById,
  createMember,
  updateMember,
  deleteMember,
  renewMember,
  computeRenewalDate,
  getMemberPayments,
};
