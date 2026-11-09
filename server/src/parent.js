// The read-only weekly summary a student can share with a parent or guardian.
// It deliberately leaves out anything private or identifying: no e-mail, phone, class codes, teacher feedback text,
// notes, or the titles of the student's own goals (only how many are open or finished).
import { studentClasses, inList } from "./repo.js";
import { goalProgress } from "./goals.js";
import { pct } from "./dates.js";

export async function buildParentSummary(db, clock, studentId) {
  const student = await db.one("SELECT id,name,first_name,parent_name FROM users WHERE id=$1 AND role='student' AND banned=FALSE", [studentId]);
  if (!student) return null;
  const today = clock.today(), weekDates = clock.weekDates(today), start = weekDates[0], end = weekDates[6];
  const prevWeek = weekDates.map(d => clock.shift(d, -7));
  const classes = (await studentClasses(db, studentId)).filter(c => c.available);
  const classIds = classes.map(c => c.id);

  const minutes = await db.many("SELECT study_date,SUM(minutes) AS m FROM study_logs WHERE student_id=$1 AND study_date>=$2 AND study_date<=$3 GROUP BY study_date", [studentId, clock.shift(today, -70), today]);
  const minutesByDate = Object.fromEntries(minutes.map(r => [r.study_date, Number(r.m)]));
  const goal = await db.one("SELECT daily_minutes,weekly_minutes FROM student_goals WHERE student_id=$1", [studentId]);
  const progress = goalProgress({ goal, minutesByDate, today, weekDates, shift: clock.shift });
  const lastWeekMinutes = prevWeek.reduce((sum, d) => sum + (minutesByDate[d] || 0), 0);
  const subjects = await db.many("SELECT subject,SUM(minutes) AS m FROM study_logs WHERE student_id=$1 AND study_date>=$2 AND study_date<=$3 GROUP BY subject ORDER BY m DESC LIMIT 6", [studentId, start, end]);

  let homework = { open: 0, overdue: 0, submitted_this_week: 0, pending: [] }, tests = { recent: [], average: null }, upcoming = [];
  if (classIds.length) {
    const p = [studentId, clock.shift(today, -21)];
    const open = await db.many(`SELECT h.id,h.title,h.due_date,c.name AS class_name FROM homework h JOIN classes c ON c.id=h.class_id LEFT JOIN homework_submissions s ON s.homework_id=h.id AND s.student_id=$1
      WHERE s.id IS NULL AND h.class_id IN (${inList(p, classIds)}) AND (h.due_date IS NULL OR h.due_date>=$2) ORDER BY CASE WHEN h.due_date IS NULL THEN 1 ELSE 0 END,h.due_date`, p);
    const submitted = await db.one(`SELECT COUNT(*) AS n FROM homework_submissions s JOIN homework h ON h.id=s.homework_id WHERE s.student_id=$1 AND s.submitted_at>=$2 AND h.class_id IN (${inList([studentId, `${start}T00:00:00.000Z`], classIds)})`, [studentId, `${start}T00:00:00.000Z`, ...classIds]);
    homework = {
      open: open.length, overdue: open.filter(h => h.due_date && h.due_date < today).length, submitted_this_week: submitted.n,
      pending: open.slice(0, 8).map(h => ({ title: h.title, class_name: h.class_name, due_date: h.due_date, overdue: Boolean(h.due_date && h.due_date < today) })),
    };
    const tp = [studentId];
    const marks = await db.many(`SELECT t.title,t.subject,t.max_marks,t.test_date,m.marks FROM marks m JOIN tests t ON t.id=m.test_id WHERE m.student_id=$1 AND t.class_id IN (${inList(tp, classIds)}) ORDER BY CASE WHEN t.test_date IS NULL THEN 1 ELSE 0 END,t.test_date DESC,m.id DESC`, tp);
    const percentages = marks.map(m => pct(m.marks, m.max_marks));
    tests = {
      average: percentages.length ? Number((percentages.reduce((a, b) => a + b, 0) / percentages.length).toFixed(1)) : null,
      recent: marks.slice(0, 5).map(m => ({ title: m.title, subject: m.subject, marks: m.marks, max_marks: m.max_marks, percentage: pct(m.marks, m.max_marks), test_date: m.test_date })),
    };
    const horizon = clock.shift(today, 7);
    const up = [studentId, today, horizon];
    const dueSoon = await db.many(`SELECT h.title,h.due_date FROM homework h LEFT JOIN homework_submissions s ON s.homework_id=h.id AND s.student_id=$1 WHERE s.id IS NULL AND h.due_date>=$2 AND h.due_date<=$3 AND h.class_id IN (${inList(up, classIds)})`, up);
    const tp2 = [today, horizon];
    const testsSoon = await db.many(`SELECT title,test_date FROM tests WHERE test_date>=$1 AND test_date<=$2 AND class_id IN (${inList(tp2, classIds)})`, tp2);
    upcoming = [...dueSoon.map(h => ({ kind: "homework", title: h.title, date: h.due_date })), ...testsSoon.map(t => ({ kind: "test", title: t.title, date: t.test_date }))];
  }
  const exams = await db.many("SELECT title,exam_date FROM student_exams WHERE student_id=$1 AND exam_date>=$2 AND exam_date<=$3", [studentId, today, clock.shift(today, 7)]);
  upcoming = [...upcoming, ...exams.map(e => ({ kind: "exam", title: e.title, date: e.exam_date }))].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8);

  const attendanceRows = classIds.length ? await db.many(`SELECT status,COUNT(*) AS n FROM attendance WHERE student_id=$1 AND attendance_date>=$2 AND attendance_date<=$3 AND class_id IN (${inList([studentId, clock.shift(today, -30), today], classIds)}) GROUP BY status`, [studentId, clock.shift(today, -30), today, ...classIds]) : [];
  const present = attendanceRows.find(r => r.status === "present")?.n || 0, absent = attendanceRows.find(r => r.status === "absent")?.n || 0;
  const plan = await db.many("SELECT done_at FROM student_plan_items WHERE student_id=$1 AND (done_at IS NULL OR done_at>=$2)", [studentId, `${start}T00:00:00.000Z`]);

  return {
    student: { first_name: student.first_name || student.name.split(" ")[0], parent_name: student.parent_name || "", classes: classes.map(c => c.name) },
    week: { start, end, today },
    study: {
      week_minutes: progress.weekly.minutes, last_week_minutes: lastWeekMinutes, today_minutes: progress.daily.minutes,
      goal: progress.goal, weekly_percent: progress.weekly.percent, streak: progress.streak,
      days: progress.days.map(d => ({ date: d.date, minutes: d.minutes, status: d.status })),
      subjects: subjects.map(s => ({ subject: s.subject, minutes: Number(s.m) })),
    },
    homework, tests, upcoming,
    attendance: { present, absent, percentage: present + absent ? Number((present * 100 / (present + absent)).toFixed(1)) : null, days: 30 },
    own_goals: { open: plan.filter(x => !x.done_at).length, finished_this_week: plan.filter(x => x.done_at).length },
  };
}
