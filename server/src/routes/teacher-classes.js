// Teacher: classes, join requests, blocks, removing students, weekly class schedule.
import crypto from "node:crypto";
import { HttpError, v } from "../validate.js";
import { classForReq, assertClassActive } from "../classctx.js";
import { getInstitute, instituteEnforced, studentCountFor, instituteSummaryFor, notify, isUniqueViolation, codeInUse, generateUniqueCode, studentForTeacher } from "../repo.js";

const MAX_CLASSES_PER_TEACHER = 30;
const MAX_SLOTS_PER_CLASS = 40;

export function teacherClassRoutes(ctx, r) {
  const { db, clock, auth, role } = ctx;
  const guard = [auth, role("teacher")];

  r.get("/api/teacher/context", ...guard, async (req, res) => {
    const rows = await db.many(`SELECT c.id,c.name,c.code,c.suspended,c.created_at,
      (SELECT COUNT(*) FROM student_class_memberships m WHERE m.class_id=c.id AND m.status='active') AS student_count,
      (SELECT COUNT(*) FROM join_requests jr WHERE jr.class_id=c.id AND jr.status='pending') AS pending_requests
      FROM classes c WHERE c.teacher_id=$1 ORDER BY c.id`, [req.user.id]);
    const classes = rows.map(c => ({ ...c, suspended: Boolean(c.suspended) }));
    const inst = req.user.institute_id ? await getInstitute(db, req.user.institute_id) : null;
    res.json({ classes, institute: instituteSummaryFor(inst, req.user), pending_total: classes.reduce((s, c) => s + c.pending_requests, 0), read_only: req.user.readOnly });
  });

  r.post("/api/teacher/classes", ...guard, async (req, res) => {
    const name = v.str(req.body?.name, "Class name", { min: 1, max: 100 });
    let code = v.code(req.body?.code, "Class code", { optional: true });
    if ((await db.one("SELECT COUNT(*) AS n FROM classes WHERE teacher_id=$1", [req.user.id])).n >= MAX_CLASSES_PER_TEACHER) throw new HttpError(403, `You can create up to ${MAX_CLASSES_PER_TEACHER} classes.`, "CLASS_LIMIT");
    if (code && await codeInUse(db, code)) throw new HttpError(409, "That class code is already taken. Choose another or leave it blank to generate one.");
    if (!code) code = await generateUniqueCode(db, crypto.randomInt);
    try {
      const row = await db.one("INSERT INTO classes(teacher_id,name,code,created_at) VALUES($1,$2,$3,$4) RETURNING id", [req.user.id, name, code, clock.nowIso()]);
      res.status(201).json({ id: row.id, name, code, suspended: false, student_count: 0, pending_requests: 0 });
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, "That class code is already taken");
      throw error;
    }
  });

  async function requestForTeacher(idParam, teacherId) {
    const id = v.id(idParam, "request");
    const row = await db.one(`SELECT jr.*,c.teacher_id,c.name AS class_name,c.suspended AS class_suspended FROM join_requests jr JOIN classes c ON c.id=jr.class_id WHERE jr.id=$1 AND c.teacher_id=$2`, [id, teacherId]);
    if (!row) throw new HttpError(404, "Join request not found");
    return row;
  }

  r.get("/api/teacher/join-requests", ...guard, async (req, res) => {
    const pending = await db.many(`SELECT jr.id,jr.created_at,s.id AS student_id,s.name AS student_name,s.email AS student_email,c.id AS class_id,c.name AS class_name,c.code AS class_code
      FROM join_requests jr JOIN users s ON s.id=jr.student_id JOIN classes c ON c.id=jr.class_id WHERE c.teacher_id=$1 AND jr.status='pending' ORDER BY jr.id`, [req.user.id]);
    const blocked = await db.many("SELECT id,student_email,student_name,created_at FROM teacher_blocks WHERE teacher_id=$1 ORDER BY id DESC", [req.user.id]);
    res.json({ pending, blocked });
  });

  r.post("/api/teacher/join-requests/:id/approve", ...guard, async (req, res) => {
    const request = await requestForTeacher(req.params.id, req.user.id);
    if (request.status !== "pending") throw new HttpError(409, "This request has already been handled");
    if (request.class_suspended) throw new HttpError(403, "This class has been suspended by StudyTrack.", "CLASS_SUSPENDED");
    const student = await db.one("SELECT id FROM users WHERE id=$1 AND role='student'", [request.student_id]);
    if (!student) throw new HttpError(404, "This student account no longer exists");
    if (req.user.institute_id) {
      const inst = await getInstitute(db, req.user.institute_id);
      if (instituteEnforced(inst) && inst.max_students != null) {
        // A student already in another class of this institute does not take a new seat.
        const already = await db.one(`SELECT 1 AS x FROM student_class_memberships m JOIN classes c ON c.id=m.class_id JOIN users t ON t.id=c.teacher_id
          WHERE m.student_id=$1 AND m.status='active' AND t.institute_id=$2`, [student.id, inst.id]);
        if (!already && await studentCountFor(db, inst.id) >= inst.max_students) throw new HttpError(409, "Your institute has reached its student limit. Contact StudyTrack to increase it.", "LIMIT_STUDENTS");
      }
    }
    const now = clock.nowIso();
    await db.tx(async t => {
      const done = await t.exec("UPDATE join_requests SET status='approved',resolved_at=$1 WHERE id=$2 AND status='pending'", [now, request.id]);
      if (!done) throw new HttpError(409, "This request has already been handled");
      await t.exec(`INSERT INTO student_class_memberships(student_id,class_id,status,joined_at) VALUES($1,$2,'active',$3)
        ON CONFLICT(student_id,class_id) DO UPDATE SET status='active',removed_at=NULL,joined_at=excluded.joined_at`, [student.id, request.class_id, now]);
    });
    await notify(db, clock, [student.id], { type: "join_approved", title: `You joined ${request.class_name}`, body: "Your teacher approved your request.", classId: request.class_id });
    res.json({ ok: true });
  });

  // mode "remove": the request is declined. mode "block": declined and the student's Gmail is blocked from all of this teacher's classes.
  r.post("/api/teacher/join-requests/:id/deny", ...guard, async (req, res) => {
    const mode = v.oneOf(req.body?.mode, "Mode", ["remove", "block"]);
    if (mode === "block" && req.body?.confirm !== true) throw new HttpError(400, "Blocking must be confirmed", "CONFIRM_REQUIRED");
    const request = await requestForTeacher(req.params.id, req.user.id);
    if (request.status !== "pending") throw new HttpError(409, "This request has already been handled");
    const student = await db.one("SELECT id,name,email FROM users WHERE id=$1", [request.student_id]);
    await db.tx(async t => {
      await t.exec("UPDATE join_requests SET status=$1,resolved_at=$2 WHERE id=$3 AND status='pending'", [mode === "block" ? "blocked" : "denied", clock.nowIso(), request.id]);
      if (mode === "block" && student) {
        await t.exec(`INSERT INTO teacher_blocks(teacher_id,student_id,student_email,student_name,created_at) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(teacher_id,student_email) DO UPDATE SET student_id=excluded.student_id,student_name=excluded.student_name`, [req.user.id, student.id, student.email, student.name, clock.nowIso()]);
      }
    });
    if (student) await notify(db, clock, [student.id], { type: "join_denied", title: `Your request to join ${request.class_name} was not approved`, classId: request.class_id });
    res.json({ ok: true, blocked: mode === "block" });
  });

  r.delete("/api/teacher/blocks/:id", ...guard, async (req, res) => {
    const block = await db.one("SELECT * FROM teacher_blocks WHERE id=$1 AND teacher_id=$2", [v.id(req.params.id), req.user.id]);
    if (!block) throw new HttpError(404, "Blocked student not found");
    await db.tx(async t => {
      await t.exec("DELETE FROM teacher_blocks WHERE id=$1", [block.id]);
      if (block.student_id) await t.exec("UPDATE join_requests SET status='denied' WHERE status='blocked' AND student_id=$1 AND class_id IN (SELECT id FROM classes WHERE teacher_id=$2)", [block.student_id, req.user.id]);
    });
    res.json({ ok: true });
  });

  // Removes a student from the CURRENT class only (their other classes are unaffected).
  r.delete("/api/teacher/students/:id", ...guard, async (req, res) => {
    const cls = await classForReq(db, req);
    const student = await studentForTeacher(db, v.id(req.params.id, "student"), req.user.id, cls.id);
    if (!student) throw new HttpError(404, "Student not found");
    await db.exec("UPDATE student_class_memberships SET status='removed',removed_at=$1 WHERE student_id=$2 AND class_id=$3 AND status='active'", [clock.nowIso(), student.id, cls.id]);
    await notify(db, clock, [student.id], { type: "removed", title: `You were removed from ${cls.name}`, classId: cls.id });
    res.json({ ok: true });
  });

  // ---- Weekly class schedule (feeds the calendar) ----
  r.get("/api/teacher/schedule", ...guard, async (req, res) => {
    const cls = await classForReq(db, req);
    res.json({ class: cls, slots: await db.many("SELECT id,weekday,start_time,end_time,subject,room FROM class_schedule WHERE class_id=$1 ORDER BY weekday,start_time,id", [cls.id]) });
  });
  r.post("/api/teacher/schedule", ...guard, async (req, res) => {
    const cls = await classForReq(db, req);
    assertClassActive(cls);
    const b = req.body || {};
    const weekday = v.int(b.weekday, "Weekday", { min: 1, max: 7 });
    const start = v.time(b.startTime, "Start time"), end = v.time(b.endTime, "End time");
    if (end <= start) throw new HttpError(400, "End time must be after start time");
    const subject = v.str(b.subject, "Subject", { max: 100 }), room = v.optStr(b.room, "Room", { max: 60 });
    if ((await db.one("SELECT COUNT(*) AS n FROM class_schedule WHERE class_id=$1", [cls.id])).n >= MAX_SLOTS_PER_CLASS) throw new HttpError(400, `A class can have up to ${MAX_SLOTS_PER_CLASS} weekly slots`);
    const row = await db.one("INSERT INTO class_schedule(class_id,weekday,start_time,end_time,subject,room,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id", [cls.id, weekday, start, end, subject, room, clock.nowIso()]);
    res.status(201).json({ id: row.id });
  });
  r.delete("/api/teacher/schedule/:id", ...guard, async (req, res) => {
    const n = await db.exec("DELETE FROM class_schedule WHERE id=$1 AND class_id IN (SELECT id FROM classes WHERE teacher_id=$2)", [v.id(req.params.id), req.user.id]);
    if (!n) throw new HttpError(404, "Slot not found");
    res.json({ ok: true });
  });
}
