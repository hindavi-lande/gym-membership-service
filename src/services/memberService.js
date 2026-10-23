const { Member } = require('../models');
const ApiError = require('../utils/ApiError');
const { getPlanPrice } = require('../config/planPrices');
const paymentsClient = require('../clients/paymentsClient');
const { oneYearFrom } = require('../utils/dateUtils');

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

async function renewMember(id) {
  const member = await getMemberById(id);
  const amount = getPlanPrice(member.membershipPlan);

  const payment = await paymentsClient.charge({
    memberId: member.id,
    amount,
    reason: `Membership renewal - ${member.membershipPlan}`,
  });

  if (!payment || payment.status !== 'SUCCESS') {
    throw new ApiError(402, 'Payment did not go through. Your renewal was not applied.');
  }

  const updatedMember = await member.update({ renewalDate: oneYearFrom(new Date()) });

  return { member: updatedMember, payment };
}

async function getMemberPayments(id) {
  const member = await getMemberById(id);
  return paymentsClient.getHistoryForMember(member.id);
}

module.exports = {
  listMembers,
  getMemberById,
  createMember,
  updateMember,
  deleteMember,
  renewMember,
  getMemberPayments,
};
