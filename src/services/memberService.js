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
  // lastPaymentId declares no model default, so a value omitted from create()
  // never reaches dataValues and would be missing (undefined) from the response
  // rather than reported as null.
  return Member.create({ lastPaymentId: null, ...data });
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
  const charge = await paymentClient.charge({
    memberId: member.id,
    amount: price,
    reason: `${member.membershipPlan} plan renewal`,
  });

  // Remember which charge paid for the current period so a cancellation can be
  // refunded against it. A response without an id leaves lastPaymentId null.
  return member.update({
    renewalDate: computeRenewalDate(),
    lastPaymentId: charge && charge.id != null ? charge.id : null,
  });
}

async function getMemberPayments(id) {
  const member = await getMemberById(id);
  return paymentClient.getMemberPayments(member.id);
}

// A cancellation refunds the unused part of the current period, which is the
// period that started this many days before renewalDate.
const REFUND_PERIOD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const ALREADY_CANCELLED_MESSAGE = 'This membership is already cancelled.';
const REFUND_NOT_ELIGIBLE_MESSAGE =
  'No refund is due: the current period has no unused days left to refund.';
const REFUND_COMPLETED_MESSAGE =
  'Your membership has been cancelled and the unused days have been refunded.';
const REFUND_PENDING_MESSAGE =
  'Your membership has been cancelled. The refund is pending.';

function toUtcDay(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

// Whole UTC calendar days from today to renewalDate, never negative and never
// more than one full period.
function computeRemainingDays(renewalDate, today = new Date()) {
  const renewal = toUtcDay(renewalDate);
  const current = toUtcDay(today);
  if (!renewal || !current) {
    return 0;
  }
  const days = Math.round((renewal.getTime() - current.getTime()) / DAY_MS);
  if (days <= 0) {
    return 0;
  }
  return Math.min(days, REFUND_PERIOD_DAYS);
}

function computeRefundAmount(price, remainingDays) {
  if (!remainingDays || remainingDays <= 0) {
    return 0;
  }
  // Round half-up to whole cents (24.995 -> 25.00) and never return more than
  // the price that was actually paid for the period.
  const rounded = Math.round((price * remainingDays * 100) / REFUND_PERIOD_DAYS + 1e-9) / 100;
  return Math.min(rounded, price);
}

async function cancelMembership(id) {
  const member = await getMemberById(id);

  // Cancelling is idempotent: an already INACTIVE member is never refunded twice.
  if (member.status === 'INACTIVE') {
    return {
      member,
      refund: {
        status: 'NOT_ELIGIBLE',
        amount: null,
        paymentId: null,
        message: ALREADY_CANCELLED_MESSAGE,
      },
    };
  }

  const remainingDays = computeRemainingDays(member.renewalDate);
  const price = PLAN_PRICES[member.membershipPlan];
  const refundable = member.lastPaymentId != null && remainingDays > 0 && price !== undefined;
  const amount = refundable ? computeRefundAmount(price, remainingDays) : 0;

  // Nothing was paid for the current period (or it has already run out), so the
  // cancellation goes through without asking the payments service for money back.
  if (!refundable || amount <= 0) {
    const cancelled = await member.update({ status: 'INACTIVE', refundFollowUpRequired: false });
    return {
      member: cancelled,
      refund: {
        status: 'NOT_ELIGIBLE',
        amount: null,
        paymentId: null,
        message: REFUND_NOT_ELIGIBLE_MESSAGE,
      },
    };
  }

  try {
    const refundPayment = await paymentClient.refund({
      memberId: member.id,
      amount,
      reason: `${member.membershipPlan} plan refund (${remainingDays} unused days)`,
      relatedPaymentId: member.lastPaymentId,
    });

    const refundStatus = refundPayment && refundPayment.status === 'PENDING' ? 'PENDING' : 'SUCCESS';
    const cancelled = await member.update({ status: 'INACTIVE', refundFollowUpRequired: false });

    return {
      member: cancelled,
      refund: {
        status: refundStatus,
        amount,
        paymentId: refundPayment && refundPayment.id != null ? refundPayment.id : null,
        message: refundStatus === 'PENDING' ? REFUND_PENDING_MESSAGE : REFUND_COMPLETED_MESSAGE,
      },
    };
  } catch (err) {
    // The cancellation still goes through when the refund cannot be processed,
    // but it is flagged so staff can follow the refund up.
    const cancelled = await member.update({ status: 'INACTIVE', refundFollowUpRequired: true });
    return {
      member: cancelled,
      refund: {
        status: 'FAILED',
        amount,
        paymentId: null,
        message: `${REFUND_PENDING_MESSAGE} Our staff will follow up.`,
      },
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
  getMemberPayments,
  REFUND_PERIOD_DAYS,
  computeRemainingDays,
  computeRefundAmount,
  cancelMembership,
};
