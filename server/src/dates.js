// Time-zone aware calendar-day helpers. All "days" in StudyTrack are days in STUDYTRACK_TIMEZONE.
export function createClock(timeZone = "Asia/Kolkata", nowFn = () => new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const localDate = (date = nowFn()) => {
    const parts = Object.fromEntries(fmt.formatToParts(date).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const shift = (dateString, days) => {
    const d = new Date(`${dateString}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  // ISO weekday: Monday = 1 ... Sunday = 7
  const weekday = dateString => { const d = new Date(`${dateString}T12:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };
  const startOfWeek = (dateString = localDate()) => shift(dateString, -(weekday(dateString) - 1));
  const daysBetween = (from, to) => Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86400000);
  const weekDates = (dateString = localDate()) => { const s = startOfWeek(dateString); return Array.from({ length: 7 }, (_, i) => shift(s, i)); };
  return {
    timeZone,
    now: nowFn,
    nowIso: () => nowFn().toISOString(),
    today: () => localDate(),
    localDate, shift, weekday, startOfWeek, daysBetween, weekDates,
    daysAgo: n => shift(localDate(), -n),
    previousWeekStart: () => shift(startOfWeek(), -7),
  };
}
export const minutesToHours = m => Number((Number(m || 0) / 60).toFixed(1));
export const pct = (value, max) => (max ? Number((value * 100 / max).toFixed(1)) : 0);
export function trend(current, previous) {
  if (!previous) return current > 0 ? "new" : "stable";
  const change = (current - previous) / previous * 100;
  return change > 5 ? "improving" : change < -5 ? "declining" : "stable";
}
