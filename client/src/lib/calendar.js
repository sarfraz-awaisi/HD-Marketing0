// Calendar dates are Pakistan dates ("YYYY-MM-DD"); Pakistan has no daylight
// saving, so a Pakistan day starts at 19:00 UTC the evening before.
const offset = 5 * 3600000,
  dayMs = 86400000;
const utc = (day) => Date.parse(day + "T00:00:00Z");
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
export const pkDate = (value) => iso(Date.parse(value) + offset);
export const todayPk = () => pkDate(new Date().toISOString());
export const addDays = (day, n) => iso(utc(day) + n * dayMs);
// 0 = Monday … 6 = Sunday
export const weekday = (day) => (new Date(utc(day)).getUTCDay() + 6) % 7;
export const startOfWeek = (day) => addDays(day, -weekday(day));
export const startOfMonth = (day) => day.slice(0, 8) + "01";
export function addMonths(day, n) {
  const [y, m] = day.split("-").map(Number);
  return iso(Date.UTC(y, m - 1 + n, 1));
}
// The moment a Pakistan day begins, for API ranges.
export const dayStartIso = (day) => new Date(utc(day) - offset).toISOString();
const timeFormatter = new Intl.DateTimeFormat("en-PK", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Karachi",
});
export const visitTime = (value) => timeFormatter.format(new Date(value));
const shortDay = new Intl.DateTimeFormat("en-PK", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const longDay = new Intl.DateTimeFormat("en-PK", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const monthYear = new Intl.DateTimeFormat("en-PK", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const dayMonthYear = new Intl.DateTimeFormat("en-PK", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
export const dayLabel = (day) => shortDay.format(new Date(utc(day)));
export const fullDayLabel = (day) => longDay.format(new Date(utc(day)));
export const monthLabel = (day) => monthYear.format(new Date(utc(day)));
// Target periods: a day, a week starting Monday, or a calendar month.
export function periodStart(period, day) {
  return period === "week"
    ? startOfWeek(day)
    : period === "month"
      ? startOfMonth(day)
      : day;
}
export function shiftPeriod(period, start, n) {
  return period === "week"
    ? addDays(start, 7 * n)
    : period === "month"
      ? addMonths(start, n)
      : addDays(start, n);
}
export const periodEnd = (period, start) => shiftPeriod(period, start, 1);
export function periodRange(period, start) {
  return {
    from: dayStartIso(start),
    to: dayStartIso(periodEnd(period, start)),
  };
}
export function periodLabel(period, start) {
  return period === "week"
    ? `Week of ${dayMonthYear.format(new Date(utc(start)))}`
    : period === "month"
      ? monthLabel(start)
      : fullDayLabel(start);
}
