const { Member } = require('../models');
const ApiError = require('../utils/ApiError');
const { getPlanPrice } = require('../config/planPrices');
const paymentsClient = require('../clients/paymentsClient');

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

function addOneMonth(date) {
  const nextDate = new Date(date);
  nextDate.setMonth(nextDate.getMonth() + 1);

  const year = nextDate.getFullYear();
  const month = String(nextDate.getMonth() + 1).padStart(2, '0');
  const day = String(nextDate.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

async function renewMember(id) {
  const member = await getMemberById(id);
  const amount = getPlanPrice(member.membershipPlan);

  const payment = await paymentsClient.createCharge({
    memberId: member.id,
    amount,
    reason: `Renewal - ${member.membershipPlan} plan`,
  });

  const updatedMember = await member.update({ renewalDate: addOneMonth(new Date()) });

  return { member: updatedMember, payment };
}

async function getMemberPayments(id) {
  await getMemberById(id);
  return paymentsClient.getMemberPayments(id);
}

module.exports = {
  listMembers,
  getMemberById,
  createMember,
  updateMember,
  deleteMember,
  renewMember,
  addOneMonth,
  getMemberPayments,
};
