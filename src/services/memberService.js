const { Member } = require('../models');
const ApiError = require('../utils/ApiError');
const { PLAN_PRICING } = require('../constants/planPricing');
const { proratedRefundAmount } = require('../utils/refundCalculation');
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

// Today as a UTC DATEONLY, so it compares directly against renewalDate.
function todayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

function refundSummary(status, amount, relatedPaymentId, message) {
  return { status, amount, relatedPaymentId, message };
}

// The refund could not be confirmed, so the member is cancelled and the refund is
// left pending for staff to follow up.
async function cancelWithPendingRefund(member, amount, relatedPaymentId) {
  const cancelled = await member.update({
    status: 'CANCELLED',
    refundStatus: 'PENDING',
    refundNeedsFollowUp: true,
  });

  return {
    member: cancelled,
    refund: refundSummary(
      'PENDING',
      amount,
      relatedPaymentId,
      'Membership cancelled; the refund is pending and staff will follow it up',
    ),
  };
}

// Cancelling partway through a paid period gives back the unused portion of the
// member's most recent renewal charge. The cancellation itself still goes through
// when the refund cannot be confirmed; only an unknown member, an already
// cancelled membership and a payment the payments service says has already been
// refunded are turned away.
async function cancelMembership(id) {
  const member = await getMemberById(id);

  if (member.status === 'CANCELLED') {
    throw new ApiError(409, 'Membership is already cancelled');
  }

  const today = todayUtc();

  // On or after the renewal date the period is used up, so there is nothing to
  // give back.
  if (today >= member.renewalDate) {
    const cancelled = await member.update({ status: 'CANCELLED' });
    return {
      member: cancelled,
      refund: refundSummary(null, null, null, 'No refund is due for this membership'),
    };
  }

  let history;
  try {
    history = await getMemberPayments(id);
  } catch (err) {
    // Without the history the refund cannot be tied to a charge; the cancellation
    // still goes through and staff pick the refund up.
    return cancelWithPendingRefund(member, null, null);
  }

  // The history is ordered most recent first, so the first CHARGE is the renewal
  // payment the refund gives money back from.
  const charge = Array.isArray(history)
    ? history.find((payment) => payment && payment.type === 'CHARGE')
    : undefined;

  if (!charge) {
    const cancelled = await member.update({ status: 'CANCELLED' });
    return {
      member: cancelled,
      refund: refundSummary(
        null,
        null,
        null,
        'No refund is due because no renewal payment was found',
      ),
    };
  }

  // Never give back more than the payment being reversed.
  const amount = Math.min(
    proratedRefundAmount({
      chargeAmount: charge.amount,
      renewalDate: member.renewalDate,
      today,
    }),
    charge.amount,
  );

  let response;
  try {
    response = await paymentServiceClient.refund({
      memberId: member.id,
      amount,
      reason: `${member.membershipPlan} plan cancellation refund`,
      relatedPaymentId: charge.id,
    });
  } catch (err) {
    if (err && err.code === paymentServiceClient.PAYMENTS_UNAVAILABLE) {
      return cancelWithPendingRefund(member, amount, charge.id);
    }
    throw err;
  }

  if (response.status === 409) {
    // The payments service refused outright because that renewal payment has
    // already been refunded, so nothing is cancelled.
    const message =
      response.body && response.body.message
        ? response.body.message
        : 'That renewal payment has already been refunded';
    throw new ApiError(409, message);
  }

  if (response.status < 200 || response.status >= 300) {
    return cancelWithPendingRefund(member, amount, charge.id);
  }

  const outcome = response.body && response.body.status;

  if (outcome === 'SUCCESS') {
    const cancelled = await member.update({
      status: 'CANCELLED',
      refundStatus: 'COMPLETED',
      refundNeedsFollowUp: false,
    });
    return {
      member: cancelled,
      refund: refundSummary('COMPLETED', amount, charge.id, `Refund of ${amount} completed`),
    };
  }

  if (outcome === 'FAILED') {
    const cancelled = await member.update({
      status: 'CANCELLED',
      refundStatus: 'FAILED',
      refundNeedsFollowUp: true,
    });
    return {
      member: cancelled,
      refund: refundSummary('FAILED', amount, charge.id, 'The refund failed and needs follow-up'),
    };
  }

  return cancelWithPendingRefund(member, amount, charge.id);
}

// The payment history (renewal charges and the refunds against them) lives in the
// payments service; this only proxies it, so an outage is surfaced as an error
// rather than an empty list.
async function getMemberPayments(id) {
  const member = await getMemberById(id);

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

  // This proxy is the live source of truth, so a refund that was pending at
  // cancellation time moves the stored member-facing outcome along once the
  // payments service shows it settled. The history is ordered most recent first,
  // so the first REFUND is the one the member is waiting on.
  if (member.refundStatus === 'PENDING' && Array.isArray(response.body)) {
    const latestRefund = response.body.find((payment) => payment && payment.type === 'REFUND');

    if (latestRefund && latestRefund.status === 'SUCCESS') {
      await member.update({ refundStatus: 'COMPLETED', refundNeedsFollowUp: false });
    } else if (latestRefund && latestRefund.status === 'FAILED') {
      await member.update({ refundStatus: 'FAILED', refundNeedsFollowUp: false });
    }
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
  cancelMembership,
  getMemberPayments,
};
