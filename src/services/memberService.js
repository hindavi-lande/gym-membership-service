const { Member } = require('../models');
const ApiError = require('../utils/ApiError');
const { PLAN_PRICING } = require('../constants/planPricing');
const paymentServiceClient = require('../clients/paymentServiceClient');

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

// Renewal dates are DATEONLY values, so they are computed in UTC to avoid the
// stored day shifting with the server's timezone.
function oneMonthFromToday() {
  const now = new Date();
  const renewal = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  renewal.setUTCMonth(renewal.getUTCMonth() + 1);
  return renewal.toISOString().slice(0, 10);
}

async function renewMember(id) {
  const member = await getMemberById(id);

  const price = PLAN_PRICING[member.membershipPlan];
  if (price === undefined) {
    throw new ApiError(422, `No renewal price configured for plan ${member.membershipPlan}`);
  }

  let charge;
  try {
    charge = await paymentServiceClient.charge({
      memberId: member.id,
      amount: price,
      reason: `${member.membershipPlan} plan renewal`,
    });
  } catch (err) {
    if (err && err.code === paymentServiceClient.PAYMENTS_UNAVAILABLE) {
      throw new ApiError(503, 'Payments service is unavailable, please try again later');
    }
    throw err;
  }

  if (charge.status < 200 || charge.status >= 300) {
    throw new ApiError(402, 'Payment did not go through');
  }

  return member.update({ renewalDate: oneMonthFromToday() });
}

// The renewal charge history lives in the payments service; this only proxies
// it, so an outage is surfaced as an error rather than an empty list.
async function getMemberPayments(id) {
  await getMemberById(id);

  let response;
  try {
    response = await paymentServiceClient.getMemberPayments(id);
  } catch (err) {
    if (err && err.code === paymentServiceClient.PAYMENTS_UNAVAILABLE) {
      throw new ApiError(503, 'Payments service is unavailable, please try again later');
    }
    throw err;
  }

  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(502, 'Could not load payment history from the payments service');
  }

  return response.body;
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
