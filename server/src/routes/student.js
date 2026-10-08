// Student side: multiple classes, join requests, dashboard, homework, study logs, attendance, syllabus.
import { HttpError, v } from "../validate.js";
import { inList, studentClasses, getClassByCode, isActiveMember, notify, isUniqueViolation, getClass } from "../repo.js";
import { trend, pct } from "../dates.js";
import { buildActivity } from "../activity.js";

const DAY = 86400000;

export function studentRoutes(ctx, r) {
  const { db, clock, auth, role, limiters } = ctx;
  const guard = [auth, role("student")];

  // Which classes does a request look at? One (must be the student's own and available) or all available ones.
  async function scope(req) {
    const all = await studentClasses(db, req.user.id);
    const available = all.filter(c => c.available);
    if (req.query.classId !== undefined && req.query.classId !== "") {
      const wanted = v.id(req.query.classId, "class");
      const found = available.find(c => c.id === wanted);
      if (!found) throw new HttpError(404, "Class not found");
      return { all, classes: [found], ids: [found.id] };
    }
    return { all, classes: available, ids: available.map(c => c.id) };
  }
  const sumMinutes = async (studentId, from, toExclusive = null) => {
    const params = [studentId, from];
    let sql = "SELECT COALESCE(SUM(minutes),0) AS n FROM study_logs WHERE student_id=$1 AND study_date>=$2";
    if (toExclusive) { params.push(toExclusive); sql += " AND study_date<$3"; }
    return (await db.one(sql, params)).n;
  };

  // ---- Classes & join requests ----
  r.get("/api/student/classes", ...guard, async (req, res) => {
    const classes = (await studentClasses(db, req.user.id)).map(c => ({ id: c.id, name: c.name, teacher_name: c.teacher_name, institute_name: c.institute_name, available: c.available, unavailable_reason: c.unavailable_reason, joined_at: c.joined_at }));
    const since = new Date(clock.now().getTime() - 7 * DAY).toISOString();
    const rows = await db.many(`SELECT jr.id,jr.status,jr.created_at,jr.resolved_at,c.name AS class_name,t.name AS teacher_name
      FROM join_requests jr JOIN classes c ON c.id=jr.class_id JOIN users t ON t.id=c.teacher_id
      WHERE jr.student_id=$1 AND (jr.status='pending' OR (jr.status IN ('denied','blocked') AND jr.resolved_at>=$2)) ORDER BY jr.id DESC`, [req.user.id, since]);
    const shape = x => ({ id: x.id, className: x.class_name, teacherName: x.teacher_name, createdAt: x.created_at, resolvedAt: x.resolved_at });
    res.json({
      classes,
      pending: rows.filter(x => x.status === "pending").map(shape),
      declined: rows.filter(x => x.status !== "pending").map(x => ({ ...shape(x), status: x.status })),
    });
  });

  r.post("/api/student/join-request", ...guard, limiters.joinIp.guard, limiters.join.guard, async (req, res) => {
    const code = v.code(req.body?.classCode, "Class code");
    const cls = await getClassByCode(db, code);
    if (!cls) throw new HttpError(404, "No class found with that code. Check the code with your teacher.");
    const me = await db.one("SELECT id,name,email FROM users WHERE id=$1", [req.user.id]);
    if (await db.one("SELECT 1 AS x FROM teacher_blocks WHERE teacher_id=$1 AND (student_email=$2 OR student_id=$3)", [cls.teacher_id, me.email, me.id])) {
      throw new HttpError(403, `${cls.teacher_name} didn't allow you to join their class.`, "BLOCKED");
    }
    if (!cls.available) throw new HttpError(403, "This class isn't accepting students right now.", "CLASS_UNAVAILABLE");
    if (await isActiveMember(db, me.id, cls.id)) throw new HttpError(409, "You are already in this class.");
    if (await db.one("SELECT 1 AS x FROM join_requests WHERE student_id=$1 AND class_id=$2 AND status='pending'", [me.id, cls.id])) {
      throw new HttpError(409, "You already have a pending request for this class.");
    }
    // Spam protection: a cool-down after a decline, a cap on open requests and a daily cap.
    const dayAgo = new Date(clock.now().getTime() - DAY).toISOString();
    if (await db.one("SELECT 1 AS x FROM join_requests WHERE student_id=$1 AND class_id=$2 AND status='denied' AND resolved_at>=$3", [me.id, cls.id, dayAgo])) {
      throw new HttpError(429, "Your last request to this class was declined. Please wait 24 hours before asking again.", "COOLDOWN");
    }
    if ((await db.one("SELECT COUNT(*) AS n FROM join_requests WHERE student_id=$1 AND status='pending'", [me.id])).n >= 10) {
      throw new HttpError(429, "You have too many pending requests. Cancel some first.", "TOO_MANY_PENDING");
    }
    if ((await db.one("SELECT COUNT(*) AS n FROM join_requests WHERE student_id=$1 AND created_at>=$2", [me.id, dayAgo])).n >= 20) {
      throw new HttpError(429, "You have sent too many requests today. Please try again tomorrow.", "DAILY_LIMIT");
    }
    let id;
    try {
      id = (await db.one("INSERT INTO join_requests(student_id,class_id,created_at) VALUES($1,$2,$3) RETURNING id", [me.id, cls.id, clock.nowIso()])).id;
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, "You already have a pending request for this class.");
      throw error;
    }
    await notify(db, clock, [cls.teacher_id], { type: "join_request", title: `${me.name} wants to join ${cls.name}`, body: "Open Requests to allow or deny.", classId: cls.id, refType: "join_request", refId: id });
    res.status(201).json({ request: { id, teacherName: cls.teacher_name, className: cls.name } });
  });

  r.post("/api/student/join-requests/:id/cancel", ...guard, async (req, res) => {
    const id = v.id(req.params.id);
    const n = await db.exec("UPDATE join_requests SET status='cancelled',resolved_at=$1 WHERE id=$2 AND student_id=$3 AND status='pending'", [clock.nowIso(), id, req.user.id]);
    if (!n) throw new HttpError(404, "You have no such pending request");
    res.json({ ok: true });
  });

  r.post("/api/student/classes/:id/leave", ...guard, async (req, res) => {
    const classId = v.id(req.params.id, "class");
    const n = await db.exec("UPDATE student_class_memberships SET status='removed',removed_at=$1 WHERE student_id=$2 AND class_id=$3 AND status='active'", [clock.nowIso(), req.user.id, classId]);
    if (!n) throw new HttpError(404, "You are not in this class");
    const cls = await getClass(db, classId);
    if (cls) await notify(db, clock, [cls.teacher_id], { type: "student_left", title: `${req.user.name} left ${cls.name}`, classId });
    res.json({ ok: true });
  });

  // ---- Dashboard ----
  r.get("/api/student/dashboard", ...guard, async (req, res) => {
    const { all, ids } = await scope(req);
    const today = clock.today(), weekStart = clock.startOfWeek(), prevStart = clock.previousWeekStart();
    const uid = req.user.id;
    let homework = [], tests = [], attendance = { total: 0, present: 0 }, syllabus = { total: 0, completed: 0 };
    if (ids.length) {
      let p = [today, uid];
      homework = (await db.many(`SELECT h.id,h.class_id,c.name AS class_name,h.title,h.description,h.due_date,h.file_name,h.file_size,(h.file_path IS NOT NULL) AS has_file,h.created_at,
        hs.note AS submission_note,hs.submitted_at,hs.feedback,hs.reviewed_at,
        CASE WHEN hs.status IS NOT NULL THEN hs.status WHEN h.due_date IS NOT NULL AND h.due_date<$1 THEN 'late' ELSE 'pending' END AS status
        FROM homework h JOIN classes c ON c.id=h.class_id LEFT JOIN homework_submissions hs ON hs.homework_id=h.id AND hs.student_id=$2
        WHERE h.class_id IN (${inList(p, ids)}) ORDER BY h.created_at DESC`, p)).map(h => ({ ...h, has_file: Boolean(h.has_file) }));
      p = [uid];
      tests = (await db.many(`SELECT t.id,t.class_id,c.name AS class_name,t.title,t.subject,t.max_marks,t.solution,t.test_date,t.file_name,(t.file_path IS NOT NULL) AS has_file,t.created_at,m.marks,m.remark
        FROM tests t JOIN classes c ON c.id=t.class_id LEFT JOIN marks m ON m.test_id=t.id AND m.student_id=$1
        WHERE t.class_id IN (${inList(p, ids)}) ORDER BY CASE WHEN t.test_date IS NULL THEN 1 ELSE 0 END, t.test_date DESC, t.created_at DESC`, p))
        .map(t => ({ ...t, has_file: Boolean(t.has_file), percentage: t.marks == null ? null : pct(t.marks, t.max_marks) }));
      p = [uid];
      attendance = await db.one(`SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN status='present' THEN 1 ELSE 0 END),0) AS present FROM attendance WHERE student_id=$1 AND class_id IN (${inList(p, ids)})`, p);
      p = [];
      syllabus = await db.one(`SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0) AS completed FROM syllabus_chapters WHERE class_id IN (${inList(p, ids)})`, p);
    }
    const graded = tests.filter(t => t.marks != null);
    const avg = graded.length ? graded.reduce((a, t) => a + t.percentage, 0) / graded.length : 0;
    const logs = await db.many("SELECT * FROM study_logs WHERE student_id=$1 ORDER BY study_date DESC,id DESC LIMIT 300", [uid]);
    const week = await sumMinutes(uid, weekStart), prev = await sumMinutes(uid, prevStart, weekStart);
    res.json({
      student: { id: uid, name: req.user.name, email: req.user.email },
      classes: all.map(c => ({ id: c.id, name: c.name, teacher_name: c.teacher_name, available: c.available, unavailable_reason: c.unavailable_reason })),
      homework, tests, logs,
      stats: {
        tests_taken: graded.length, average_percentage: Number(avg.toFixed(1)),
        total_study_minutes: (await db.one("SELECT COALESCE(SUM(minutes),0) AS n FROM study_logs WHERE student_id=$1", [uid])).n,
        week_minutes: week, previous_week_minutes: prev, study_trend: trend(week, prev),
        attendance_percentage: attendance.total ? Number((attendance.present * 100 / attendance.total).toFixed(1)) : 0,
        syllabus_percentage: syllabus.total ? Math.round(syllabus.completed * 100 / syllabus.total) : 0,
      },
      daily: await db.many("SELECT study_date,SUM(minutes) AS minutes FROM study_logs WHERE student_id=$1 AND study_date>=$2 GROUP BY study_date ORDER BY study_date", [uid, clock.daysAgo(13)]),
      subjects: await db.many("SELECT subject,SUM(minutes) AS minutes FROM study_logs WHERE student_id=$1 GROUP BY subject ORDER BY SUM(minutes) DESC, subject", [uid]),
      categories: await db.many("SELECT category,SUM(minutes) AS minutes FROM study_logs WHERE student_id=$1 GROUP BY category", [uid]),
    });
  });

  r.post("/api/student/homework/:id/submit", ...guard, async (req, res) => {
    const id = v.id(req.params.id, "homework");
    const h = await db.one("SELECT id,class_id,due_date FROM homework WHERE id=$1", [id]);
    // IDOR guard: the homework must belong to a class this student is actively in.
    const cls = h && (await studentClasses(db, req.user.id)).find(c => c.id === h.class_id);
    if (!cls) throw new HttpError(404, "Homework not found");
    if (!cls.available) throw new HttpError(403, cls.unavailable_reason, "CLASS_UNAVAILABLE");
    if (cls.read_only) throw new HttpError(403, "This institute is in read-only mode right now.", "READ_ONLY");
    const note = v.optStr(req.body?.note, "Note", { max: 5000, multiline: true });
    const status = h.due_date && clock.today() > h.due_date ? "late" : "submitted";
    await db.exec(`INSERT INTO homework_submissions(homework_id,student_id,note,status,submitted_at) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(homework_id,student_id) DO UPDATE SET note=excluded.note,submitted_at=excluded.submitted_at,status=excluded.status`, [h.id, req.user.id, note, status, clock.nowIso()]);
    await notify(db, clock, [cls.teacher_id], { type: "homework_submitted", title: `${req.user.name} submitted homework`, classId: cls.id, refType: "homework", refId: h.id });
    res.json({ ok: true, status });
  });

  // ---- Study logs ----
  r.post("/api/student/study-log", ...guard, limiters.heavy.guard, async (req, res) => {
    const b = req.body || {};
    const category = v.oneOf(b.category, "Study type", ["tuition", "self-study", "outside"]);
    const subject = v.str(b.subject, "Subject", { max: 100 });
    const minutes = Math.round(v.num(b.minutes, "Minutes", { min: 1, max: 1440 }));
    const studyDate = v.date(b.studyDate, "Date");
    const note = v.optStr(b.note, "Note", { max: 2000, multiline: true });
    if (studyDate > clock.shift(clock.today(), 1)) throw new HttpError(400, "Study date cannot be in the future");
    const already = (await db.one("SELECT COALESCE(SUM(minutes),0) AS n FROM study_logs WHERE student_id=$1 AND study_date=$2", [req.user.id, studyDate])).n;
    if (already + minutes > 1440) throw new HttpError(400, "That would be more than 24 hours of study on one day");
    const row = await db.one("INSERT INTO study_logs(student_id,category,subject,minutes,study_date,note,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *", [req.user.id, category, subject, minutes, studyDate, note, clock.nowIso()]);
    res.status(201).json(row);
  });
  r.delete("/api/student/study-log/:id", ...guard, async (req, res) => {
    const n = await db.exec("DELETE FROM study_logs WHERE id=$1 AND student_id=$2", [v.id(req.params.id), req.user.id]);
    if (!n) throw new HttpError(404, "Study log not found");
    res.json({ ok: true });
  });

  // ---- Attendance, syllabus, activity ----
  r.get("/api/student/attendance", ...guard, async (req, res) => {
    const { ids } = await scope(req);
    let rows = [];
    if (ids.length) {
      const p = [req.user.id];
      rows = await db.many(`SELECT a.attendance_date,a.status,a.class_id FROM attendance a WHERE a.student_id=$1 AND a.class_id IN (${inList(p, ids)}) ORDER BY a.attendance_date DESC`, p);
    }
    const present = rows.filter(x => x.status === "present").length;
    // Streaks are counted per calendar day: a day counts as attended if the student was present in any class that day.
    const byDate = new Map();
    for (const x of rows) byDate.set(x.attendance_date, byDate.get(x.attendance_date) || x.status === "present");
    const days = [...byDate.entries()].map(([date, ok]) => ({ date, ok })).sort((a, b) => b.date.localeCompare(a.date));
    let current = 0;
    for (let i = 0; i < days.length; i++) {
      if (!days[i].ok || (i > 0 && clock.shift(days[i - 1].date, -1) !== days[i].date)) break;
      current++;
    }
    let longest = 0, run = 0;
    const asc = [...days].reverse();
    for (let i = 0; i < asc.length; i++) {
      if (asc[i].ok && i > 0 && asc[i - 1].ok && clock.shift(asc[i - 1].date, 1) === asc[i].date) run++;
      else run = asc[i].ok ? 1 : 0;
      longest = Math.max(longest, run);
    }
    res.json({ records: rows, percentage: rows.length ? Number((present * 100 / rows.length).toFixed(1)) : 0, present, absent: rows.length - present, currentStreak: current, longestStreak: longest, recordedDays: rows.length });
  });

  r.get("/api/student/syllabus", ...guard, async (req, res) => {
    const { classes, ids } = await scope(req);
    if (!ids.length) return res.json({ subjects: [] });
    const p = [];
    const rows = await db.many(`SELECT * FROM syllabus_chapters WHERE class_id IN (${inList(p, ids)}) ORDER BY class_id,subject,id`, p);
    const names = new Map(classes.map(c => [c.id, c.name]));
    const groups = new Map();
    for (const row of rows) { const key = `${row.class_id}|${row.subject}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
    const subjects = [...groups.values()].map(x => {
      const completed = x.filter(c => c.status === "completed").length;
      return { class_id: x[0].class_id, class_name: names.get(x[0].class_id), subject: x[0].subject, total: x.length, completed, inProgress: x.filter(c => c.status === "in-progress").length, percentage: Math.round(completed * 100 / x.length), chapters: x };
    });
    res.json({ subjects });
  });

  r.get("/api/student/activity", ...guard, async (req, res) => {
    const { ids } = await scope(req);
    res.json({ activity: await buildActivity(db, { classIds: ids, studentId: req.user.id, limit: 50 }) });
  });
}
