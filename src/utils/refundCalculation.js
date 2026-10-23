// Refund proration for a cancellation partway through a paid period.
//
// The current period starts one month before the member's renewalDate and ends
// on the renewalDate itself, using the same UTC month arithmetic as
// memberService.oneMonthFromToday so both ends of a period agree — including the
// month-end rollover (a 31st renewing into a shorter month).

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseDateOnly(dateOnly) {
  const [year, month, day] = dateOnly.split('-').map(Number);
  return { year, month, day };
}

function oneMonthBefore(dateOnly) {
  const { year, month, day } = parseDateOnly(dateOnly);
  const start = new Date(Date.UTC(year, month - 1, day));
  start.setUTCMonth(start.getUTCMonth() - 1);
  return start.toISOString().slice(0, 10);
}

// Whole UTC days between two DATEONLY values; negative when `to` is before `from`.
function daysBetween(fromDateOnly, toDateOnly) {
  const { year: fromYear, month: fromMonth, day: fromDay } = parseDateOnly(fromDateOnly);
  const { year: toYear, month: toMonth, day: toDay } = parseDateOnly(toDateOnly);
  const from = Date.UTC(fromYear, fromMonth - 1, fromDay);
  const to = Date.UTC(toYear, toMonth - 1, toDay);
  return Math.round((to - from) / MS_PER_DAY);
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// The unused share of the current period: chargeAmount * remainingDays / totalDays,
// never more than the charge and never negative.
function proratedRefundAmount({ chargeAmount, renewalDate, today }) {
  const totalDays = daysBetween(oneMonthBefore(renewalDate), renewalDate);
  const remainingDays = daysBetween(today, renewalDate);

  if (remainingDays <= 0 || totalDays <= 0) {
    return 0;
  }

  const amount = round2((chargeAmount * remainingDays) / totalDays);
  return Math.min(Math.max(amount, 0), chargeAmount);
}

module.exports = {
  oneMonthBefore,
  daysBetween,
  proratedRefundAmount,
};
