// Fair weekly trend: the COMPLETED days of this week (Monday up to yesterday) against the same days of last week.
// Comparing a half-finished week with a whole one would make every student look "declining" early in the week.
import { trend } from "./dates.js";

export async function weekTrend(db, clock, studentId) {
  const today = clock.today(), weekStart = clock.startOfWeek(), prevStart = clock.previousWeekStart();
  const days = clock.weekday(today) - 1; // completed days so far this week
  if (days === 0) return { current: 0, previous: 0, trend: "stable", days };
  const sum = async (from, to) => (await db.one("SELECT COALESCE(SUM(minutes),0) AS n FROM study_logs WHERE student_id=$1 AND study_date>=$2 AND study_date<$3", [studentId, from, to])).n;
  const current = await sum(weekStart, today), previous = await sum(prevStart, clock.shift(prevStart, days));
  return { current, previous, trend: trend(current, previous), days };
}
