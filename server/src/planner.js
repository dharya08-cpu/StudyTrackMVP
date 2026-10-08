// Smart study planner: pure, deterministic functions (no database, no clock) so they can be tested exactly.
const examPoints = d => (d == null || d < 0 ? 0 : d === 0 ? 45 : d <= 3 ? 40 : d <= 7 ? 30 : d <= 14 ? 20 : d <= 30 ? 10 : 0);
const round5 = n => Math.max(5, Math.round(n / 5) * 5);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function scoreSubject(s) {
  const parts = [];
  const add = (points, reason) => { if (points > 0) parts.push({ points, reason }); };
  const d = s.nextExamDays;
  add(examPoints(d), d === 0 ? "Exam today" : d === 1 ? "Exam tomorrow" : `Exam in ${plural(d, "day")}`);
  if (s.daysSinceStudied == null) add(s.studiedBefore === false ? 15 : 0, "Not studied yet");
  else add(Math.min(20, s.daysSinceStudied * 2), `Not studied for ${plural(s.daysSinceStudied, "day")}`);
  if (s.avgPercentage != null) add(s.avgPercentage < 50 ? 20 : s.avgPercentage < 65 ? 12 : s.avgPercentage < 80 ? 5 : 0, `Test average ${Math.round(s.avgPercentage)}%`);
  if (s.syllabusPct != null) add(Math.round((100 - s.syllabusPct) / 10), `${Math.round(100 - s.syllabusPct)}% of the syllabus is left`);
  if (s.plannedToday) add(15, "In your plan for today");
  let score = parts.reduce((sum, p) => sum + p.points, 0);
  if ((s.minutesToday || 0) >= 45) score -= 20; // already worked on it today
  return { score, reasons: parts.sort((a, b) => b.points - a.points).map(p => p.reason).slice(0, 3) };
}

// subjects: [{ subject, minutesToday, daysSinceStudied|null, studiedBefore, avgPercentage|null, syllabusPct|null, nextExamDays|null, plannedToday }]
// homework: { dueSoon, overdue }   goal: { dailyMinutes|null, todayMinutes }
export function buildSuggestions({ subjects = [], homework = { dueSoon: 0, overdue: 0 }, goal = { dailyMinutes: null, todayMinutes: 0 } }) {
  const items = [];
  for (const s of subjects) {
    const { score, reasons } = scoreSubject(s);
    if (score > 0) items.push({ type: "subject", subject: s.subject, title: `Study ${s.subject}`, score, reasons });
  }
  if (homework.dueSoon > 0) {
    const score = Math.min(60, 35 + homework.overdue * 10);
    items.push({
      type: "homework", subject: "Homework", score,
      title: `Finish ${plural(homework.dueSoon, "pending homework")}`.replace("homeworks", "homework"),
      reasons: [homework.overdue > 0 ? `${homework.overdue} overdue` : "Due within 2 days"],
      fixedMinutes: Math.min(90, 30 * homework.dueSoon),
    });
  }
  items.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  const remaining = goal.dailyMinutes ? Math.max(0, goal.dailyMinutes - goal.todayMinutes) : 90;
  const goalReached = Boolean(goal.dailyMinutes) && remaining === 0;
  const budget = goalReached ? 30 : remaining;
  const top = items.slice(0, budget >= 120 ? 4 : 3);
  const total = top.reduce((sum, i) => sum + i.score, 0) || 1;
  const result = top.map(i => {
    const minutes = Math.min(120, i.fixedMinutes ? Math.min(i.fixedMinutes, Math.max(15, budget)) : Math.max(15, round5(budget * i.score / total)));
    const { fixedMinutes, ...rest } = i;
    return { ...rest, minutes };
  });
  let hint = "";
  if (!items.length) hint = "Log a study session, add subjects to your weekly plan or add an exam to get personalised suggestions.";
  else if (goalReached) hint = "Your daily goal is already reached. Here is optional extra revision.";
  return { items: result, hint, remainingMinutes: remaining, goalReached };
}

export function examCountdown(exam, today, clock) {
  return { ...exam, days_left: clock.daysBetween(today, exam.exam_date) };
}
