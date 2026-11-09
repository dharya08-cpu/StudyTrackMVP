// The class report a teacher can download: summary, test results, attendance and homework, one row per student.
// Deliberately leaves out e-mail addresses, phone numbers and parent details: a report is for marking and records.
import { inList, studentsForClass } from "./repo.js";
import { pct } from "./dates.js";

const round1 = n => Number(n.toFixed(1));
const avg = list => (list.length ? round1(list.reduce((a, b) => a + b, 0) / list.length) : null);

export async function buildClassReport(db, clock, cls, { from, to } = {}) {
  const today = clock.today();
  const students = await studentsForClass(db, cls.id);
  const ids = students.map(s => s.id);
  const grades = new Map();
  if (ids.length) { const p = []; for (const r of await db.many(`SELECT id,grade FROM users WHERE id IN (${inList(p, ids)})`, p)) grades.set(r.id, r.grade || ""); }

  const tests = await db.many("SELECT id,title,subject,max_marks,test_date FROM tests WHERE class_id=$1 ORDER BY CASE WHEN test_date IS NULL THEN 1 ELSE 0 END,test_date,id", [cls.id]);
  const marks = await db.many("SELECT m.test_id,m.student_id,m.marks FROM marks m JOIN tests t ON t.id=m.test_id WHERE t.class_id=$1", [cls.id]);
  const markOf = new Map(marks.map(m => [`${m.test_id}:${m.student_id}`, m.marks]));
  const testPct = (testId, max, sid) => { const m = markOf.get(`${testId}:${sid}`); return m == null ? null : pct(m, max); };

  const dateFrom = from || clock.shift(today, -90), dateTo = to || today;
  const att = await db.many("SELECT student_id,attendance_date,status FROM attendance WHERE class_id=$1 AND attendance_date>=$2 AND attendance_date<=$3 ORDER BY attendance_date", [cls.id, dateFrom, dateTo]);
  const dates = [...new Set(att.map(a => a.attendance_date))].sort();
  const attOf = new Map(att.map(a => [`${a.attendance_date}:${a.student_id}`, a.status]));

  const homework = await db.many("SELECT id,title,due_date FROM homework WHERE class_id=$1 ORDER BY created_at,id", [cls.id]);
  const subs = await db.many("SELECT hs.homework_id,hs.student_id,hs.status FROM homework_submissions hs JOIN homework h ON h.id=hs.homework_id WHERE h.class_id=$1", [cls.id]);
  const subOf = new Map(subs.map(s => [`${s.homework_id}:${s.student_id}`, s.status]));

  const logs = new Map();
  if (ids.length) {
    const p = [clock.shift(today, -29)];
    for (const r of await db.many(`SELECT student_id,study_date,SUM(minutes) AS m FROM study_logs WHERE study_date>=$1 AND student_id IN (${inList(p, ids)}) GROUP BY student_id,study_date`, p)) logs.set(`${r.student_id}:${r.study_date}`, Number(r.m));
  }
  const studyMinutes = (sid, days) => { let n = 0; for (let i = 0; i < days; i++) n += logs.get(`${sid}:${clock.shift(today, -i)}`) || 0; return n; };

  const summary = [["Student", "Grade", "Tests taken", "Test average %", "Attendance %", "Days present", "Days absent", "Homework submitted", "Homework total", "Late submissions", "Study minutes (7 days)", "Study minutes (30 days)"]];
  const results = [["Student", ...tests.map(t => `${t.title} (${t.subject}, out of ${t.max_marks}${t.test_date ? `, ${t.test_date}` : ""})`), "Average %"]];
  const attendance = [["Student", ...dates, "Days present", "Days absent", "Attendance %"]];
  const hw = [["Student", ...homework.map(h => `${h.title}${h.due_date ? ` (due ${h.due_date})` : ""}`), "Submitted", "Missing"]];

  for (const s of students) {
    const pcts = tests.map(t => testPct(t.id, t.max_marks, s.id));
    const taken = pcts.filter(x => x !== null);
    const present = dates.filter(d => attOf.get(`${d}:${s.id}`) === "present").length, absent = dates.filter(d => attOf.get(`${d}:${s.id}`) === "absent").length;
    const status = homework.map(h => subOf.get(`${h.id}:${s.id}`) || null);
    const submitted = status.filter(Boolean).length;
    summary.push([s.name, grades.get(s.id) || "", taken.length, avg(taken), present + absent ? round1(present * 100 / (present + absent)) : null, present, absent, submitted, homework.length, status.filter(x => x === "late").length, studyMinutes(s.id, 7), studyMinutes(s.id, 30)]);
    results.push([s.name, ...tests.map((t, i) => (markOf.get(`${t.id}:${s.id}`) ?? null)), avg(taken)]);
    attendance.push([s.name, ...dates.map(d => ({ present: "P", absent: "A" }[attOf.get(`${d}:${s.id}`)] || "")), present, absent, present + absent ? round1(present * 100 / (present + absent)) : null]);
    hw.push([s.name, ...homework.map((h, i) => ({ reviewed: "Reviewed", submitted: "Submitted", late: "Late" }[status[i]] || (h.due_date && h.due_date < today ? "Missing" : "Pending"))), submitted, homework.filter((h, i) => !status[i] && h.due_date && h.due_date < today).length]);
  }
  const about = [["About this report", ""], ["Class", cls.name], ["Students", students.length], ["Created", `${today} (${clock.timeZone})`], ["Attendance range", `${dateFrom} to ${dateTo}`], ["Results", "Marks are shown out of each test's maximum. Blank means no mark entered."], ["Attendance", "P = present, A = absent. Blank = not recorded that day."], ["Homework", "Missing = past its due date with no submission. Pending = not due yet."], ["Privacy", "This report holds students' records. Keep it safe and do not share it widely."]];
  return { summary, results, attendance, homework: hw, about };
}
