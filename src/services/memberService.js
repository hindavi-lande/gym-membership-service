const { Member, sequelize } = require('../models');
const ApiError = require('../utils/ApiError');
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

async function mergeMembers(keepId, duplicateId) {
  if (String(keepId) === String(duplicateId)) {
    throw new ApiError(400, 'A member cannot be merged into itself');
  }

  await getMemberById(keepId);
  await getMemberById(duplicateId);

  return sequelize.transaction(async (t) => {
    const kept = await Member.findByPk(keepId, { transaction: t });
    const duplicate = await Member.findByPk(duplicateId, { transaction: t });

    if (!kept) {
      throw new ApiError(404, `Member with id ${keepId} not found`);
    }
    if (!duplicate) {
      throw new ApiError(404, `Member with id ${duplicateId} not found`);
    }

    await duplicate.destroy({ transaction: t });
    await paymentsClient.movePayments(duplicate.id, kept.id);

    return kept;
  });
}

module.exports = {
  listMembers,
  getMemberById,
  createMember,
  updateMember,
  deleteMember,
  mergeMembers,
};
