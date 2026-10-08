// Student goals and the smart study planner (weekly timetable, exam countdowns, "what to study today").
import { HttpError, v } from "../validate.js";
import { inList, studentClasses } from "../repo.js";
import { goalProgress, validateGoals } from "../goals.js";
import { buildSuggestions } from "../planner.js";
import { pct } from "../dates.js";

const MAX_PLAN_SLOTS = 60, MAX_EXAMS = 30, LOOKBACK_DAYS = 60;

export function plannerRoutes(ctx, r) {
  const { db, clock, auth, role } = ctx;
  const guard = [auth, role("student")];
  const key = s => String(s || "").trim().toLowerCase();

  async function goalState(studentId) {
    const today = clock.today();
    const goal = await db.one("SELECT daily_minutes,weekly_minutes FROM student_goals WHERE student_id=$1", [studentId]);
    const logs = await db.many("SELECT study_date,SUM(minutes) AS minutes FROM study_logs WHERE student_id=$1 AND study_date>=$2 GROUP BY study_date", [studentId, clock.shift(today, -LOOKBACK_DAYS)]);
    return goalProgress({ goal, minutesByDate: Object.fromEntries(logs.map(l => [l.study_date, l.minutes])), today, weekDates: clock.weekDates(today), shift: clock.shift });
  }

  r.get("/api/student/goals", ...guard, async (req, res) => res.json(await goalState(req.user.id)));
  r.put("/api/student/goals", ...guard, async (req, res) => {
    const daily = v.int(req.body?.dailyMinutes, "Daily goal", { min: 0, max: 100000 }), weekly = v.int(req.body?.weeklyMinutes, "Weekly goal", { min: 0, max: 100000 });
    const problem = validateGoals(daily, weekly);
    if (problem) throw new HttpError(400, problem);
    await db.exec(`INSERT INTO student_goals(student_id,daily_minutes,weekly_minutes,updated_at) VALUES($1,$2,$3,$4)
      ON CONFLICT(student_id) DO UPDATE SET daily_minutes=excluded.daily_minutes,weekly_minutes=excluded.weekly_minutes,updated_at=excluded.updated_at`, [req.user.id, daily, weekly, clock.nowIso()]);
    res.json(await goalState(req.user.id));
  });
  r.delete("/api/student/goals", ...guard, async (req, res) => {
    await db.exec("DELETE FROM student_goals WHERE student_id=$1", [req.user.id]);
    res.json(await goalState(req.user.id));
  });

  r.post("/api/student/plan-slots", ...guard, async (req, res) => {
    const b = req.body || {};
    const weekday = v.int(b.weekday, "Weekday", { min: 1, max: 7 }), start = v.time(b.startTime, "Start time"), end = v.time(b.endTime, "End time");
    if (end <= start) throw new HttpError(400, "End time must be after start time");
    const subject = v.str(b.subject, "Subject", { max: 100 }), note = v.optStr(b.note, "Note", { max: 200 });
    if ((await db.one("SELECT COUNT(*) AS n FROM study_plan_slots WHERE student_id=$1", [req.user.id])).n >= MAX_PLAN_SLOTS) throw new HttpError(400, `You can have up to ${MAX_PLAN_SLOTS} weekly slots`);
    const row = await db.one("INSERT INTO study_plan_slots(student_id,weekday,start_time,end_time,subject,note,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id", [req.user.id, weekday, start, end, subject, note, clock.nowIso()]);
    res.status(201).json({ id: row.id });
  });
  r.delete("/api/student/plan-slots/:id", ...guard, async (req, res) => {
    if (!await db.exec("DELETE FROM study_plan_slots WHERE id=$1 AND student_id=$2", [v.id(req.params.id), req.user.id])) throw new HttpError(404, "Slot not found");
    res.json({ ok: true });
  });
  r.post("/api/student/exams", ...guard, async (req, res) => {
    const b = req.body || {};
    const subject = v.str(b.subject, "Subject", { max: 100 }), title = v.str(b.title, "Exam name", { max: 120 }), date = v.date(b.examDate, "Exam date"), notes = v.optStr(b.notes, "Notes", { max: 500 });
    if (date < clock.today()) throw new HttpError(400, "Exam date cannot be in the past");
    if ((await db.one("SELECT COUNT(*) AS n FROM student_exams WHERE student_id=$1 AND exam_date>=$2", [req.user.id, clock.today()])).n >= MAX_EXAMS) throw new HttpError(400, `You can track up to ${MAX_EXAMS} upcoming exams`);
    const row = await db.one("INSERT INTO student_exams(student_id,subject,title,exam_date,notes,created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id", [req.user.id, subject, title, date, notes, clock.nowIso()]);
    res.status(201).json({ id: row.id });
  });
  r.delete("/api/student/exams/:id", ...guard, async (req, res) => {
    if (!await db.exec("DELETE FROM student_exams WHERE id=$1 AND student_id=$2", [v.id(req.params.id), req.user.id])) throw new HttpError(404, "Exam not found");
    res.json({ ok: true });
  });

  r.get("/api/student/planner", ...guard, async (req, res) => {
    const uid = req.user.id, today = clock.today(), todayWeekday = clock.weekday(today);
    const classes = (await studentClasses(db, uid)).filter(c => c.available);
    const ids = classes.map(c => c.id);
    const progress = await goalState(uid);
    const slots = await db.many("SELECT id,weekday,start_time,end_time,subject,note FROM study_plan_slots WHERE student_id=$1 ORDER BY weekday,start_time,id", [uid]);
    const personalExams = await db.many("SELECT id,subject,title,exam_date FROM student_exams WHERE student_id=$1 AND exam_date>=$2 ORDER BY exam_date,id", [uid, today]);
    let classSlots = [], tests = [], marks = [], syllabus = [], homework = [];
    if (ids.length) {
      let p = [];
      classSlots = await db.many(`SELECT id,class_id,weekday,start_time,end_time,subject,room FROM class_schedule WHERE class_id IN (${inList(p, ids)}) ORDER BY weekday,start_time`, p);
      p = [today];
      tests = await db.many(`SELECT id,class_id,title,subject,test_date FROM tests WHERE test_date>=$1 AND class_id IN (${inList(p, ids)}) ORDER BY test_date,id`, p);
      p = [uid];
      marks = await db.many(`SELECT t.subject,m.marks,t.max_marks FROM marks m JOIN tests t ON t.id=m.test_id WHERE m.student_id=$1 AND t.class_id IN (${inList(p, ids)})`, p);
      p = [];
      syllabus = await db.many(`SELECT subject,status FROM syllabus_chapters WHERE class_id IN (${inList(p, ids)})`, p);
      p = [uid, clock.shift(today, -14), clock.shift(today, 2)];
      homework = await db.many(`SELECT h.id,h.due_date FROM homework h LEFT JOIN homework_submissions hs ON hs.homework_id=h.id AND hs.student_id=$1
        WHERE hs.id IS NULL AND h.due_date IS NOT NULL AND h.due_date>=$2 AND h.due_date<=$3 AND h.class_id IN (${inList(p, ids)})`, p);
    }
    const logs = await db.many(`SELECT subject,SUM(minutes) AS total,MAX(study_date) AS last_date,
      SUM(CASE WHEN study_date=$2 THEN minutes ELSE 0 END) AS today_minutes FROM study_logs WHERE student_id=$1 AND study_date>=$3 GROUP BY subject`, [uid, today, clock.shift(today, -LOOKBACK_DAYS)]);

    // Exam countdowns: personal exams plus upcoming class tests.
    const countdown = [
      ...personalExams.map(e => ({ id: e.id, source: "personal", subject: e.subject, title: e.title, exam_date: e.exam_date })),
      ...tests.map(t => ({ id: t.id, source: "test", subject: t.subject, title: t.title, exam_date: t.test_date })),
    ].map(e => ({ ...e, days_left: clock.daysBetween(today, e.exam_date) })).sort((a, b) => a.days_left - b.days_left || a.title.localeCompare(b.title));

    // One record per subject (matched case-insensitively) with every signal the suggestion engine uses.
    const subjects = new Map();
    const slot = name => { const k = key(name); if (!k) return null; if (!subjects.has(k)) subjects.set(k, { subject: String(name).trim(), minutesToday: 0, daysSinceStudied: null, studiedBefore: false, avgPercentage: null, syllabusPct: null, nextExamDays: null, plannedToday: false, _marks: [], _syl: { total: 0, done: 0 } }); return subjects.get(k); };
    for (const l of logs) { const s = slot(l.subject); s.minutesToday += l.today_minutes; s.daysSinceStudied = clock.daysBetween(l.last_date, today); s.studiedBefore = true; }
    for (const m of marks) slot(m.subject)?._marks.push(pct(m.marks, m.max_marks));
    for (const c of syllabus) { const s = slot(c.subject); s._syl.total++; if (c.status === "completed") s._syl.done++; }
    for (const e of countdown) { const s = slot(e.subject); if (s && (s.nextExamDays == null || e.days_left < s.nextExamDays)) s.nextExamDays = e.days_left; }
    for (const p of slots.filter(x => x.weekday === todayWeekday)) { const s = slot(p.subject); if (s) s.plannedToday = true; }
    for (const s of subjects.values()) {
      if (s._marks.length) s.avgPercentage = s._marks.reduce((a, x) => a + x, 0) / s._marks.length;
      if (s._syl.total) s.syllabusPct = s._syl.done * 100 / s._syl.total;
      delete s._marks; delete s._syl;
    }
    const suggestions = buildSuggestions({
      subjects: [...subjects.values()],
      homework: { dueSoon: homework.length, overdue: homework.filter(h => h.due_date < today).length },
      goal: { dailyMinutes: progress.goal?.daily_minutes ?? null, todayMinutes: progress.daily.minutes },
    });

    const timetable = clock.weekDates(today).map((date, i) => ({
      weekday: i + 1, date, is_today: date === today,
      items: [
        ...classSlots.filter(c => c.weekday === i + 1).map(c => ({ source: "class", id: c.id, start_time: c.start_time, end_time: c.end_time, subject: c.subject, class_name: classes.find(k => k.id === c.class_id)?.name || "", note: c.room })),
        ...slots.filter(s => s.weekday === i + 1).map(s => ({ source: "plan", id: s.id, start_time: s.start_time, end_time: s.end_time, subject: s.subject, class_name: "", note: s.note })),
      ].sort((a, b) => a.start_time.localeCompare(b.start_time) || a.subject.localeCompare(b.subject)),
    }));
    res.json({ today, timetable, exams: countdown, suggestions, goal: progress });
  });
}
