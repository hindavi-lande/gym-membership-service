const { Member } = require('../models');
const ApiError = require('../utils/ApiError');
const paymentsClient = require('./paymentsClient');
const { computeTier, UNAVAILABLE } = require('./tierService');

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

async function getMemberProfileById(id) {
  const member = await getMemberById(id);
  const profile = member.toJSON();

  try {
    const spend = await paymentsClient.getMemberSpend(id);
    return {
      ...profile,
      spend,
      tier: computeTier(spend),
    };
  } catch (err) {
    return {
      ...profile,
      spend: null,
      tier: UNAVAILABLE,
    };
  }
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

module.exports = {
  listMembers,
  getMemberById,
  getMemberProfileById,
  createMember,
  updateMember,
  deleteMember,
};
