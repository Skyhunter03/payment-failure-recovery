// Money and calendar helpers. Pure functions, no I/O.

// Razorpay amounts are in the smallest currency unit (paise for INR).
// Format with Indian digit grouping: 12,34,567.89 -> "₹12,34,567.89".
export function formatInr(paise) {
  if (paise == null || Number.isNaN(Number(paise))) return '₹0.00';
  const negative = paise < 0;
  const abs = Math.abs(Math.round(Number(paise)));
  const rupees = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  const grouped = groupIndian(String(rupees));
  return `${negative ? '-' : ''}₹${grouped}.${fraction}`;
}

// Indian grouping: last three digits, then groups of two.
// "1234567" -> "12,34,567"
export function groupIndian(digits) {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const withCommas = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${withCommas},${last3}`;
}

const WEEKEND = new Set([0, 6]); // Sunday = 0, Saturday = 6

export function isWeekend(date) {
  return WEEKEND.has(date.getUTCDay());
}

// Add N working days, skipping Saturdays and Sundays. The starting day itself
// is never counted; we step forward until we've passed N business days.
//
// NOTE: this skips weekends only. It does NOT know Indian bank holidays, so a
// real reversal can land a day or two later. The README says so plainly.
export function addWorkingDays(startDate, workingDays) {
  const d = new Date(startDate.getTime());
  let added = 0;
  while (added < workingDays) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!isWeekend(d)) added += 1;
  }
  return d;
}

// A human date like "Tue, 26 Aug 2025" in IST-agnostic terms (we render the
// UTC calendar date; good enough for a "expect it by" line).
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatDate(date) {
  return `${DAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${
    MONTHS[date.getUTCMonth()]
  } ${date.getUTCFullYear()}`;
}
