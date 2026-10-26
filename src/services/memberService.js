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

// Sums, in whole cents, the amount of every REFUND row into the charge it points
// at via relatedPaymentId, then hands the totals back in currency units with no
// floating-point tail (2000 + 2000 cents -> 40, never 40.000000000000006).
function sumRefundedByCharge(payments) {
  const centsByCharge = new Map();

  payments.forEach((payment) => {
    if (!payment || payment.type !== 'REFUND' || payment.relatedPaymentId == null) {
      return;
    }
    const cents = Math.round(Number(payment.amount) * 100);
    if (!Number.isFinite(cents)) {
      return;
    }
    centsByCharge.set(payment.relatedPaymentId, (centsByCharge.get(payment.relatedPaymentId) || 0) + cents);
  });

  const refundedByCharge = new Map();
  centsByCharge.forEach((cents, chargeId) => {
    refundedByCharge.set(chargeId, Math.round(cents) / 100);
  });
  return refundedByCharge;
}

function paymentTime(payment) {
  const time = payment && payment.createdAt ? new Date(payment.createdAt).getTime() : NaN;
  return Number.isFinite(time) ? time : 0;
}

// Annotates the payments-service history into the combined view's `payments` list:
// CHARGE rows gain refundedAmount, REFUND rows (and FAILED charges) keep their own
// fields and are listed as events in their own right. The result is a new array,
// most recent first, so the endpoint's ordering never depends on the caller.
function buildPaymentHistory(payments) {
  const history = Array.isArray(payments) ? payments : [];
  const refundedByCharge = sumRefundedByCharge(history);

  const annotated = history.map((payment) => {
    if (!payment || payment.type !== 'CHARGE') {
      return { ...payment };
    }
    return {
      ...payment,
      refundedAmount: refundedByCharge.get(payment.id) ?? 0,
    };
  });

  return annotated.sort((a, b) => {
    const byDate = paymentTime(b) - paymentTime(a);
    if (byDate !== 0) {
      return byDate;
    }
    return (b && b.id ? b.id : 0) - (a && a.id ? a.id : 0);
  });
}

// Member details and payment history in one view. An unknown member is a 404
// before the payments service is consulted; an outage degrades to the combined
// 200 with an empty history plus an error notice, never a failed request.
async function getMemberPaymentHistory(id) {
  const member = await getMemberById(id);

  try {
    const payments = await paymentClient.getMemberPayments(member.id);
    return { member, payments: buildPaymentHistory(payments) };
  } catch (err) {
    return {
      member,
      payments: [],
      paymentHistoryError:
        err instanceof ApiError ? err.message : paymentClient.PAYMENTS_UNAVAILABLE_MESSAGE,
    };
  }
}

module.exports = {
  listMembers,
  getMemberById,
  createMember,
  updateMember,
  deleteMember,
  renewMember,
  computeRenewalDate,
  getMemberPaymentHistory,
};
