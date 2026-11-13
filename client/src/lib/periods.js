// Report periods in Pakistan time (update 063). Pakistan keeps one offset
// all year, so a Pakistan day is UTC+5. Weeks run Sunday to Saturday.
const DAY = 86400000;
export const pkDay = (ms = Date.now()) =>
  new Date(ms + 5 * 3600000).toISOString().slice(0, 10);
const addDays = (day, n) =>
  new Date(Date.parse(day + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
export const periods = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["this_week", "This week"],
  ["last_week", "Last week"],
  ["this_month", "This month"],
  ["last_month", "Last month"],
];
// The first and last day (inclusive) of a named period.
export function periodDays(period, now = Date.now()) {
  const today = pkDay(now);
  const sunday = addDays(today, -new Date(today + "T00:00:00Z").getUTCDay());
  const first = today.slice(0, 8) + "01";
  switch (period) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case "this_week":
      return { from: sunday, to: today };
    case "last_week":
      return { from: addDays(sunday, -7), to: addDays(sunday, -1) };
    case "this_month":
      return { from: first, to: today };
    case "last_month": {
      const end = addDays(first, -1);
      return { from: end.slice(0, 8) + "01", to: end };
    }
    default:
      return null;
  }
}
// Which named period two days make, or "custom".
export function periodOf(from, to, now = Date.now()) {
  const match = periods.find(([key]) => {
    const p = periodDays(key, now);
    return p.from === from && p.to === to;
  });
  return match ? match[0] : "custom";
}
// The instants a range of Pakistan days covers: from the first day's
// midnight to the midnight after the last day.
export const dayRange = (from, to) => ({
  from: new Date(from + "T00:00:00+05:00").toISOString(),
  to: new Date(Date.parse(to + "T00:00:00+05:00") + DAY).toISOString(),
});
