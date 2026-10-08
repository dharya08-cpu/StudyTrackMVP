// Teacher: overview, student analytics, homework (create + file), tests, marks, attendance, syllabus, activity.
import { HttpError, v } from "../validate.js";
import { classForReq, assertClassActive } from "../classctx.js";
import { studentsForClass, studentForTeacher, inList, notify } from "../repo.js";
import { trend, pct, minutesToHours } from "../dates.js";
import { buildActivity } from "../activity.js";
import { inspectRequestFile, assertStorageQuota, putFile, removeFiles, requireStorage } from "../uploads.js";

const STATUS = ["not-started", "in-progress", "completed"];

export function teacherAcademicRoutes(ctx, r) {
  const { db, clock, auth, role, limiters, uploadMw } = ctx;
  const guard = [auth, role("teacher")];
  const uploadGuard = (req, res, next) => (req.file ? limiters.upload.guard(req, res, next) : next());

  const filterDates = query => {
    const from = v.optDate(query.from, "Start date"), to = v.optDate(query.to, "End date");
    if (from && to && from > to) throw new HttpError(400, "Start date cannot be after end date");
    return { from, to };
  };
  const testDay = t => String(t.test_date || (t.created_at ? clock.localDate(new Date(t.created_at)) : "")).slice(0, 10);
  const lateCount = (subs, due) => (due ? subs.filter(s => s.submitted_at && clock.localDate(new Date(s.submitted_at)) > due).length : 0);

  async function homeworkForClass(classId) {
    const rows = await db.many(`SELECT h.id,h.class_id,h.title,h.description,h.due_date,h.file_name,h.file_size,(h.file_path IS NOT NULL) AS has_file,h.created_at
      FROM homework h WHERE h.class_id=$1 ORDER BY h.created_at DESC,h.id DESC`, [classId]);
    const subs = await db.many(`SELECT hs.homework_id,hs.student_id,hs.status,hs.submitted_at FROM homework_submissions hs
      JOIN homework h ON h.id=hs.homework_id JOIN student_class_memberships m ON m.student_id=hs.student_id AND m.class_id=h.class_id AND m.status='active' WHERE h.class_id=$1`, [classId]);
    const by = new Map();
    for (const s of subs) { if (!by.has(s.homework_id)) by.set(s.homework_id, []); by.get(s.homework_id).push(s); }
    return rows.map(h => {
      const list = by.get(h.id) || [];
      return { ...h, has_file: Boolean(h.has_file), submitted_count: list.length, reviewed_count: list.filter(s => s.status === "reviewed").length, late_count: lateCount(list, h.due_date) };
    });
  }
  async function testResultsForClass(classId) {
    const tests = await db.many(`SELECT t.id,t.class_id,t.title,t.subject,t.max_marks,t.test_date,t.created_at,t.file_name,(t.file_path IS NOT NULL) AS has_file
      FROM tests t WHERE t.class_id=$1 ORDER BY CASE WHEN t.test_date IS NULL THEN 1 ELSE 0 END,t.test_date DESC,t.created_at DESC`, [classId]);
    const marks = await db.many(`SELECT m.test_id,m.marks FROM marks m JOIN tests t ON t.id=m.test_id JOIN student_class_memberships mm ON mm.student_id=m.student_id AND mm.class_id=t.class_id AND mm.status='active' WHERE t.class_id=$1`, [classId]);
    return tests.map(t => {
      const own = marks.filter(m => m.test_id === t.id);
      const avg = own.length ? own.reduce((a, m) => a + m.marks * 100 / t.max_marks, 0) / own.length : null;
      return { ...t, has_file: Boolean(t.has_file), result_count: own.length, average_percentage: avg == null ? null : Number(avg.toFixed(1)) };
    });
  }

  r.get("/api/teacher/overview", ...guard, async (req, res) => {
    const cls = await classForReq(db, req, { required: false });
    if (!cls) return res.json({ class: null, students: [], homework: [], tests: [], metrics: {}, studentSummary: [], activity: [] });
    const today = clock.today(), weekStart = clock.startOfWeek(), prevStart = clock.previousWeekStart();
    const students = await studentsForClass(db, cls.id);
    const homework = await homeworkForClass(cls.id), tests = await testResultsForClass(cls.id);
    const memberJoin = "JOIN student_class_memberships m ON m.student_id=s.student_id AND m.class_id=$1 AND m.status='active'";
    const activeToday = (await db.one(`SELECT COUNT(DISTINCT s.student_id) AS n FROM study_logs s ${memberJoin} WHERE s.study_date=$2`, [cls.id, today])).n;
    const todayMin = (await db.one(`SELECT COALESCE(SUM(s.minutes),0) AS n FROM study_logs s ${memberJoin} WHERE s.study_date=$2`, [cls.id, today])).n;
    const weekMin = (await db.one(`SELECT COALESCE(SUM(s.minutes),0) AS n FROM study_logs s ${memberJoin} WHERE s.study_date>=$2`, [cls.id, weekStart])).n;
    const openHomework = (await db.one("SELECT COUNT(*) AS n FROM homework h WHERE h.class_id=$1 AND (h.due_date IS NULL OR h.due_date>=$2)", [cls.id, today])).n;
    const pendingReviews = (await db.one("SELECT COUNT(*) AS n FROM homework_submissions hs JOIN homework h ON h.id=hs.homework_id WHERE h.class_id=$1 AND hs.status IN ('submitted','late')", [cls.id])).n;
    // Per-student summary in three batched queries instead of one set per student.
    const study = await db.many(`SELECT s.student_id,
      SUM(CASE WHEN s.study_date=$2 THEN s.minutes ELSE 0 END) AS today,
      SUM(CASE WHEN s.study_date>=$3 THEN s.minutes ELSE 0 END) AS week,
      SUM(CASE WHEN s.study_date>=$4 AND s.study_date<$3 THEN s.minutes ELSE 0 END) AS prevweek
      FROM study_logs s ${memberJoin} WHERE s.study_date>=$4 GROUP BY s.student_id`, [cls.id, today, weekStart, prevStart]);
    const scores = await db.many("SELECT m.student_id,m.marks,t.max_marks,t.test_date,t.created_at,t.id AS test_id FROM marks m JOIN tests t ON t.id=m.test_id WHERE t.class_id=$1", [cls.id]);
    const submitted = await db.many("SELECT hs.student_id,COUNT(*) AS n FROM homework_submissions hs JOIN homework h ON h.id=hs.homework_id WHERE h.class_id=$1 GROUP BY hs.student_id", [cls.id]);
    const studentSummary = students.map(s => {
      const st = study.find(x => x.student_id === s.id) || { today: 0, week: 0, prevweek: 0 };
      const own = scores.filter(x => x.student_id === s.id).sort((a, b) => String(b.test_date || b.created_at).localeCompare(String(a.test_date || a.created_at)) || b.test_id - a.test_id);
      const avg = own.length ? own.reduce((a, x) => a + x.marks * 100 / x.max_marks, 0) / own.length : 0;
      const latest = own.length ? Number((own[0].marks * 100 / own[0].max_marks).toFixed(1)) : null;
      const hwSubmitted = submitted.find(x => x.student_id === s.id)?.n || 0;
      const rate = homework.length ? hwSubmitted / homework.length : 1;
      const studyTrend = trend(st.week, st.prevweek);
      let status = "on-track";
      if (st.week === 0 || (studyTrend === "declining" && avg < 60) || rate < 0.5) status = "needs-attention";
      if ((st.week === 0 && avg < 50) || (studyTrend === "declining" && avg < 45) || rate < 0.25) status = "at-risk";
      return { ...s, today_hours: minutesToHours(st.today), week_hours: minutesToHours(st.week), prevweek_hours: minutesToHours(st.prevweek), study_trend: studyTrend, average_percentage: avg.toFixed(1), latest_percentage: latest, homework_total: homework.length, homework_submitted: hwSubmitted, status };
    });
    res.json({
      class: cls, students, homework, tests,
      metrics: { students: students.length, active_today: activeToday, today_minutes: todayMin, week_minutes: weekMin, open_homework: openHomework, pending_reviews: pendingReviews, today_hours: minutesToHours(todayMin), week_hours: minutesToHours(weekMin), inactive_today: students.length - activeToday },
      studentSummary, activity: await buildActivity(db, { classIds: [cls.id], limit: 20 }),
    });
  });

  // The student must belong to the teacher's current class (or, with no class header, any class of the teacher).
  async function studentFor(req) {
    const id = v.id(req.params.id, "student");
    const header = req.get("x-class-id");
    const cls = header ? await classForReq(db, req) : null;
    const s = await studentForTeacher(db, id, req.user.id, cls?.id ?? null);
    if (!s) throw new HttpError(404, "Student not found");
    const classRow = cls || await db.one(`SELECT c.id FROM classes c JOIN student_class_memberships m ON m.class_id=c.id AND m.status='active' WHERE m.student_id=$1 AND c.teacher_id=$2 ORDER BY c.id LIMIT 1`, [s.id, req.user.id]);
    return { s, classId: classRow.id };
  }

  r.get("/api/teacher/student/:id/study", ...guard, async (req, res) => {
    const { s } = await studentFor(req);
    const { from, to } = filterDates(req.query);
    const subject = req.query.subject ? v.str(String(req.query.subject), "Subject filter", { max: 100 }) : "";
    const category = req.query.category ? v.oneOf(String(req.query.category), "Study type filter", ["tuition", "self-study", "outside"]) : "";
    const conditions = ["student_id=$1"], params = [s.id];
    if (from) { params.push(from); conditions.push(`study_date>=$${params.length}`); }
    if (to) { params.push(to); conditions.push(`study_date<=$${params.length}`); }
    if (subject) { params.push(subject); conditions.push(`subject=$${params.length}`); }
    if (category) { params.push(category); conditions.push(`category=$${params.length}`); }
    const where = conditions.join(" AND ");
    const logs = await db.many(`SELECT * FROM study_logs WHERE ${where} ORDER BY study_date DESC,id DESC LIMIT 1000`, params);
    const thisWeek = (await db.one("SELECT COALESCE(SUM(minutes),0) AS n FROM study_logs WHERE student_id=$1 AND study_date>=$2", [s.id, clock.startOfWeek()])).n;
    const prevWeek = (await db.one("SELECT COALESCE(SUM(minutes),0) AS n FROM study_logs WHERE student_id=$1 AND study_date>=$2 AND study_date<$3", [s.id, clock.previousWeekStart(), clock.startOfWeek()])).n;
    res.json({
      student: s, logs,
      daily: await db.many(`SELECT study_date,SUM(minutes) AS minutes FROM study_logs WHERE ${where} GROUP BY study_date ORDER BY study_date`, params),
      subjects: await db.many(`SELECT subject,SUM(minutes) AS minutes FROM study_logs WHERE ${where} GROUP BY subject ORDER BY SUM(minutes) DESC,subject`, params),
      categories: await db.many(`SELECT category,SUM(minutes) AS minutes FROM study_logs WHERE ${where} GROUP BY category`, params),
      total_minutes: logs.reduce((a, x) => a + x.minutes, 0), this_week_minutes: thisWeek, previous_week_minutes: prevWeek, trend: trend(thisWeek, prevWeek),
      change_percentage: prevWeek ? Number(((thisWeek - prevWeek) * 100 / prevWeek).toFixed(1)) : null, filters: { from, to, subject, category },
    });
  });

  r.get("/api/teacher/student/:id/analytics", ...guard, async (req, res) => {
    const { s, classId } = await studentFor(req);
    const scores = (await db.many(`SELECT t.id,t.title,t.subject,t.max_marks,m.marks,m.remark,t.test_date,t.created_at FROM marks m JOIN tests t ON t.id=m.test_id WHERE m.student_id=$1 AND t.class_id=$2`, [s.id, classId]))
      .map(x => ({ ...x, percentage: pct(x.marks, x.max_marks) })).sort((a, b) => String(a.test_date || a.created_at).localeCompare(String(b.test_date || b.created_at)) || a.id - b.id);
    const study = await db.many("SELECT category,SUM(minutes) AS minutes FROM study_logs WHERE student_id=$1 GROUP BY category", [s.id]);
    const avg = scores.length ? scores.reduce((a, x) => a + x.percentage, 0) / scores.length : 0;
    const first = scores[0]?.percentage || 0, last = scores.at(-1)?.percentage || 0;
    const week = (await db.one("SELECT COALESCE(SUM(minutes),0) AS n FROM study_logs WHERE student_id=$1 AND study_date>=$2", [s.id, clock.startOfWeek()])).n;
    const prevWeek = (await db.one("SELECT COALESCE(SUM(minutes),0) AS n FROM study_logs WHERE student_id=$1 AND study_date>=$2 AND study_date<$3", [s.id, clock.previousWeekStart(), clock.startOfWeek()])).n;
    // Weekly comparison is grouped in JavaScript so weeks follow the school time zone, not the database's.
    const logs = await db.many("SELECT study_date,minutes FROM study_logs WHERE student_id=$1", [s.id]);
    const byWeek = new Map();
    const slot = ws => { if (!byWeek.has(ws)) byWeek.set(ws, { week_start: ws, study_minutes: 0, tests: [] }); return byWeek.get(ws); };
    logs.forEach(l => { slot(clock.startOfWeek(l.study_date)).study_minutes += l.minutes; });
    scores.forEach(x => slot(clock.startOfWeek(String(x.test_date || clock.localDate(new Date(x.created_at))).slice(0, 10))).tests.push(x.percentage));
    const weeklyComparison = [...byWeek.values()].sort((a, b) => a.week_start.localeCompare(b.week_start)).map(w => ({ week_start: w.week_start, study_minutes: w.study_minutes, test_percentage: w.tests.length ? Number((w.tests.reduce((a, x) => a + x, 0) / w.tests.length).toFixed(1)) : null }));
    const att = await db.one("SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN status='present' THEN 1 ELSE 0 END),0) AS present FROM attendance WHERE student_id=$1 AND class_id=$2", [s.id, classId]);
    const syl = await db.one("SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0) AS completed FROM syllabus_chapters WHERE class_id=$1", [classId]);
    res.json({
      student: s, scores, study, averagePercentage: Number(avg.toFixed(1)), improvementPercentage: Number((last - first).toFixed(1)), latestPercentage: scores.at(-1)?.percentage ?? null,
      studyHours: minutesToHours(study.reduce((a, x) => a + x.minutes, 0)), weekStudyHours: minutesToHours(week), previousWeekStudyHours: minutesToHours(prevWeek), studyTrend: trend(week, prevWeek),
      performanceTrend: scores.length > 1 ? trend(last, first) : "stable", attendancePercentage: att.total ? Number((att.present * 100 / att.total).toFixed(1)) : 0,
      syllabusPercentage: syl.total ? Math.round(syl.completed * 100 / syl.total) : 0, weeklyComparison,
    });
  });

  r.get("/api/teacher/student/:id/homework", ...guard, async (req, res) => {
    const { s, classId } = await studentFor(req);
    const rows = await db.many(`SELECT h.id,h.title,h.description,h.due_date,h.file_name,(h.file_path IS NOT NULL) AS has_file,h.created_at,hs.note,hs.submitted_at,hs.status,hs.feedback,hs.reviewed_at
      FROM homework h LEFT JOIN homework_submissions hs ON hs.homework_id=h.id AND hs.student_id=$1 WHERE h.class_id=$2 ORDER BY h.created_at DESC`, [s.id, classId]);
    res.json({ student: s, homework: rows.map(h => ({ ...h, has_file: Boolean(h.has_file) })) });
  });

  // ---- Homework ----
  async function ownedHomework(idParam, teacherId) {
    const h = await db.one("SELECT h.*,c.suspended FROM homework h JOIN classes c ON c.id=h.class_id WHERE h.id=$1 AND c.teacher_id=$2", [v.id(idParam, "homework"), teacherId]);
    if (!h) throw new HttpError(404, "Homework not found");
    return h;
  }
  r.get("/api/teacher/homework/:id/submissions", ...guard, async (req, res) => {
    const h = await ownedHomework(req.params.id, req.user.id);
    const students = await studentsForClass(db, h.class_id);
    const rows = await db.many("SELECT * FROM homework_submissions WHERE homework_id=$1", [h.id]);
    const map = new Map(rows.map(x => [x.student_id, x]));
    const { file_path, ...home } = h;
    res.json({ homework: { ...home, has_file: Boolean(file_path) }, submissions: students.map(s => ({ student: s, ...(map.get(s.id) || {}), status: map.get(s.id)?.status || (h.due_date && clock.today() > h.due_date ? "late" : "pending") })) });
  });
  r.post("/api/teacher/homework/:id/review", ...guard, async (req, res) => {
    const h = await ownedHomework(req.params.id, req.user.id);
    const studentId = v.id(req.body?.studentId, "student");
    const sub = await db.one(`SELECT hs.id FROM homework_submissions hs JOIN student_class_memberships m ON m.student_id=hs.student_id AND m.class_id=$3 AND m.status='active' WHERE hs.homework_id=$1 AND hs.student_id=$2`, [h.id, studentId, h.class_id]);
    if (!sub) throw new HttpError(404, "Submission not found");
    const feedback = v.optStr(req.body?.feedback, "Feedback", { max: 5000, multiline: true });
    await db.exec("UPDATE homework_submissions SET status='reviewed',feedback=$1,reviewed_at=$2 WHERE id=$3", [feedback, clock.nowIso(), sub.id]);
    await notify(db, clock, [studentId], { type: "homework_reviewed", title: `Your homework "${h.title}" was reviewed`, body: feedback.slice(0, 200), classId: h.class_id, refType: "homework", refId: h.id });
    res.json({ ok: true });
  });

  function targetClassIds(req) {
    let raw = req.body?.classIds;
    if (typeof raw === "string" && raw.trim()) { try { raw = JSON.parse(raw); } catch { raw = raw.split(",").map(x => x.trim()).filter(Boolean); } }
    return raw === undefined || raw === null || raw === "" ? null : v.idList(raw, "Classes", { min: 1, max: 10 });
  }

  // THE V3 BUG: v3 had no way to create homework from the teacher screen. This route creates homework (text, due date,
  // optional PDF/JPG/PNG/DOCX file) for one or several classes in a single request.
  r.post("/api/teacher/homework", ...guard, uploadMw, uploadGuard, async (req, res) => {
    const title = v.str(req.body?.title, "Title", { max: 200 });
    const description = v.optStr(req.body?.description, "Description", { max: 5000, multiline: true });
    const dueDate = v.optDate(req.body?.dueDate, "Due date");
    const ids = targetClassIds(req);
    let classes;
    if (ids) {
      const p = [req.user.id];
      classes = await db.many(`SELECT id,name,suspended FROM classes WHERE teacher_id=$1 AND id IN (${inList(p, ids)}) ORDER BY id`, p);
      if (classes.length !== ids.length) throw new HttpError(404, "Class not found");
    } else classes = [await classForReq(db, req)];
    classes.forEach(c => assertClassActive({ suspended: Boolean(c.suspended) }));
    let info = null;
    if (req.file) {
      requireStorage(ctx);
      info = await inspectRequestFile(ctx, req);
      await assertStorageQuota(ctx, req.user, info.size * classes.length);
    }
    const uploaded = [];
    try {
      for (const c of classes) uploaded.push(info ? await putFile(ctx, req.user, { classId: c.id, kind: "homework", info, buffer: req.file.buffer }) : null);
      const created = await db.tx(async t => {
        const out = [];
        for (let i = 0; i < classes.length; i++) {
          const row = await t.one(`INSERT INTO homework(teacher_id,class_id,title,description,due_date,file_path,file_name,file_size,file_type,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [req.user.id, classes[i].id, title, description, dueDate, uploaded[i], info?.displayName ?? null, info?.size ?? 0, info?.mime ?? null, clock.nowIso()]);
          out.push({ id: row.id, class_id: classes[i].id, class_name: classes[i].name });
        }
        return out;
      });
      for (const c of created) {
        const students = (await studentsForClass(db, c.class_id)).map(s => s.id);
        await notify(db, clock, students, { type: "homework", title: `New homework: ${title}`, body: dueDate ? `Due ${dueDate}` : "", classId: c.class_id, refType: "homework", refId: c.id });
      }
      res.status(201).json({ created, fileName: info?.displayName ?? null });
    } catch (error) {
      await removeFiles(ctx, uploaded);
      throw error;
    }
  });

  async function attach(req, res, table) {
    const row = await db.one(`SELECT x.id,x.class_id,x.file_path,x.file_size,c.suspended FROM ${table} x JOIN classes c ON c.id=x.class_id WHERE x.id=$1 AND c.teacher_id=$2`, [v.id(req.params.id), req.user.id]);
    if (!row) throw new HttpError(404, table === "homework" ? "Homework not found" : "Test not found");
    assertClassActive({ suspended: Boolean(row.suspended) });
    requireStorage(ctx);
    const info = await inspectRequestFile(ctx, req);
    await assertStorageQuota(ctx, req.user, info.size, row.file_size || 0);
    const path = await putFile(ctx, req.user, { classId: row.class_id, kind: table, info, buffer: req.file.buffer });
    try { await db.exec(`UPDATE ${table} SET file_path=$1,file_name=$2,file_size=$3,file_type=$4 WHERE id=$5`, [path, info.displayName, info.size, info.mime, row.id]); }
    catch (error) { await removeFiles(ctx, [path]); throw error; }
    if (row.file_path && row.file_path !== path) await removeFiles(ctx, [row.file_path]);
    res.status(201).json({ fileName: info.displayName });
  }
  r.post("/api/teacher/homework/:id/attach", ...guard, uploadMw, uploadGuard, (req, res) => attach(req, res, "homework"));
  r.post("/api/teacher/tests/:id/attach", ...guard, uploadMw, uploadGuard, (req, res) => attach(req, res, "tests"));

  r.delete("/api/teacher/homework/:id", ...guard, async (req, res) => {
    const h = await ownedHomework(req.params.id, req.user.id);
    await db.exec("DELETE FROM homework WHERE id=$1", [h.id]);
    await removeFiles(ctx, [h.file_path]);
    res.json({ ok: true });
  });

  // ---- Tests, marks, results ----
  r.get("/api/teacher/results", ...guard, async (req, res) => {
    const cls = await classForReq(db, req, { required: false });
    if (!cls) return res.json({ students: [], tests: [] });
    const subject = req.query.subject ? v.str(String(req.query.subject), "Subject filter", { max: 100 }) : "";
    const { from, to } = filterDates(req.query);
    const inRange = t => (!subject || t.subject === subject) && (!from || testDay(t) >= from) && (!to || testDay(t) <= to);
    const students = await studentsForClass(db, cls.id);
    const marks = (await db.many(`SELECT m.student_id,m.marks,t.id,t.title,t.subject,t.test_date,t.max_marks,t.created_at FROM marks m JOIN tests t ON t.id=m.test_id WHERE t.class_id=$1`, [cls.id])).filter(inRange);
    const results = students.map(s => {
      const scores = marks.filter(m => m.student_id === s.id).map(m => ({ percentage: pct(m.marks, m.max_marks), id: m.id, title: m.title, subject: m.subject, test_date: m.test_date, marks: m.marks, max_marks: m.max_marks, _k: String(m.test_date || m.created_at) }))
        .sort((a, b) => b._k.localeCompare(a._k) || b.id - a.id).map(({ _k, ...rest }) => rest);
      const avg = scores.length ? scores.reduce((a, x) => a + x.percentage, 0) / scores.length : 0;
      const latest = scores[0]?.percentage ?? null, previous = scores[1]?.percentage ?? null;
      return { student: s, test_count: scores.length, average_percentage: Number(avg.toFixed(1)), latest_percentage: latest, highest_percentage: scores.length ? Math.max(...scores.map(x => x.percentage)) : null, lowest_percentage: scores.length ? Math.min(...scores.map(x => x.percentage)) : null, trend: latest != null && previous != null ? trend(latest, previous) : "stable", scores };
    });
    res.json({ class: cls, students: results, tests: (await testResultsForClass(cls.id)).filter(inRange), filters: { subject, from, to } });
  });

  r.post("/api/teacher/tests", ...guard, uploadMw, uploadGuard, async (req, res) => {
    const cls = await classForReq(db, req);
    assertClassActive(cls);
    const b = req.body || {};
    const title = v.str(b.title, "Title", { max: 200 }), subject = v.str(b.subject, "Subject", { max: 100 });
    const maxMarks = v.int(b.maxMarks, "Max marks", { min: 1, max: 100000 });
    const solution = v.optStr(b.solution, "Solution notes", { max: 10000, multiline: true });
    const testDate = v.optDate(b.testDate, "Test date");
    let info = null, path = null;
    if (req.file) { requireStorage(ctx); info = await inspectRequestFile(ctx, req); await assertStorageQuota(ctx, req.user, info.size); path = await putFile(ctx, req.user, { classId: cls.id, kind: "tests", info, buffer: req.file.buffer }); }
    let row;
    try {
      row = await db.one(`INSERT INTO tests(teacher_id,class_id,title,subject,max_marks,solution,test_date,file_path,file_name,file_size,file_type,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,title,subject,max_marks,test_date`,
        [req.user.id, cls.id, title, subject, maxMarks, solution, testDate, path, info?.displayName ?? null, info?.size ?? 0, info?.mime ?? null, clock.nowIso()]);
    } catch (error) { await removeFiles(ctx, [path]); throw error; }
    const students = (await studentsForClass(db, cls.id)).map(s => s.id);
    await notify(db, clock, students, { type: "test", title: `New test: ${title}`, body: testDate ? `${subject} · ${testDate}` : subject, classId: cls.id, refType: "test", refId: row.id });
    res.status(201).json(row);
  });
  r.post("/api/teacher/marks", ...guard, async (req, res) => {
    const testId = v.id(req.body?.testId, "test");
    const test = await db.one("SELECT t.id,t.title,t.max_marks,t.class_id FROM tests t JOIN classes c ON c.id=t.class_id WHERE t.id=$1 AND c.teacher_id=$2", [testId, req.user.id]);
    const student = test && await studentForTeacher(db, v.id(req.body?.studentId, "student"), req.user.id, test.class_id);
    if (!test || !student) throw new HttpError(404, "Test or student not found");
    const marks = v.num(req.body?.marks, "Marks", { min: 0, max: test.max_marks });
    const remark = v.optStr(req.body?.remark, "Remark", { max: 1000 });
    await db.exec(`INSERT INTO marks(test_id,student_id,marks,remark,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(test_id,student_id) DO UPDATE SET marks=excluded.marks,remark=excluded.remark`, [test.id, student.id, marks, remark, clock.nowIso()]);
    await notify(db, clock, [student.id], { type: "marks", title: `Marks posted: ${test.title}`, body: `${marks}/${test.max_marks}`, classId: test.class_id, refType: "test", refId: test.id });
    res.json({ ok: true, percentage: pct(marks, test.max_marks) });
  });

  // ---- Attendance & syllabus ----
  r.get("/api/teacher/attendance", ...guard, async (req, res) => {
    const cls = await classForReq(db, req, { required: false });
    if (!cls) return res.json({ class: null, records: [] });
    const date = req.query.date ? v.date(String(req.query.date), "Date") : clock.today();
    const records = await db.many("SELECT student_id,status FROM attendance WHERE class_id=$1 AND attendance_date=$2", [cls.id, date]);
    const map = new Map(records.map(x => [x.student_id, x.status]));
    res.json({ class: cls, date, students: (await studentsForClass(db, cls.id)).map(s => ({ student: s, status: map.get(s.id) || null })) });
  });
  r.post("/api/teacher/attendance", ...guard, async (req, res) => {
    const cls = await classForReq(db, req);
    assertClassActive(cls);
    const date = req.body?.date ? v.date(req.body.date, "Attendance date") : clock.today();
    if (!Array.isArray(req.body?.records) || req.body.records.length > 500) throw new HttpError(400, "Attendance records are required (up to 500)");
    const members = new Set((await studentsForClass(db, cls.id)).map(s => s.id));
    const rows = req.body.records.map(x => ({ studentId: v.id(x?.studentId, "student"), status: v.oneOf(x?.status, "Status", ["present", "absent"]) }));
    if (rows.some(x => !members.has(x.studentId))) throw new HttpError(404, "Student not found in this class");
    await db.tx(async t => {
      for (const x of rows) await t.exec(`INSERT INTO attendance(student_id,class_id,attendance_date,status,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(student_id,class_id,attendance_date) DO UPDATE SET status=excluded.status`, [x.studentId, cls.id, date, x.status, clock.nowIso()]);
    });
    res.json({ ok: true });
  });
  r.get("/api/teacher/syllabus", ...guard, async (req, res) => {
    const cls = await classForReq(db, req, { required: false });
    res.json({ class: cls, chapters: cls ? await db.many("SELECT * FROM syllabus_chapters WHERE class_id=$1 ORDER BY subject,id", [cls.id]) : [] });
  });
  r.post("/api/teacher/syllabus", ...guard, async (req, res) => {
    const cls = await classForReq(db, req);
    assertClassActive(cls);
    const subject = v.str(req.body?.subject, "Subject", { max: 100 }), chapter = v.str(req.body?.chapter, "Chapter", { max: 200 });
    const status = v.oneOf(req.body?.status, "Status", STATUS);
    const row = await db.one(`INSERT INTO syllabus_chapters(class_id,subject,chapter,status,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(class_id,subject,chapter) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at RETURNING id`, [cls.id, subject, chapter, status, clock.nowIso()]);
    res.json({ ok: true, id: row.id });
  });
  r.get("/api/teacher/activity", ...guard, async (req, res) => {
    const cls = await classForReq(db, req, { required: false });
    res.json({ activity: cls ? await buildActivity(db, { classIds: [cls.id], limit: 50 }) : [] });
  });
}
