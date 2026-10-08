// Coaching institutes (teacher side): create a request, join with a code, institute home, roles and members.
import crypto from "node:crypto";
import { HttpError, v, parseId } from "../validate.js";
import { getInstitute, isHeadRole, instituteEnforced, teacherCountFor, codeInUse, generateUniqueCode, isUniqueViolation, notify } from "../repo.js";

const phoneOk = s => /^[0-9+\-\s()]{6,20}$/.test(s);

export function instituteRoutes(ctx, r) {
  const { db, clock, auth, role, limiters } = ctx;
  const guard = [auth, role("teacher")];

  async function membershipFor(req) {
    const me = await db.one("SELECT institute_id,institute_role FROM users WHERE id=$1", [req.user.id]);
    const inst = me?.institute_id ? await getInstitute(db, me.institute_id) : null;
    if (!inst) throw new HttpError(404, "You are not part of a coaching institute", "NO_INSTITUTE");
    return { inst, myRole: me.institute_role || "teacher" };
  }
  async function activeMembershipFor(req) {
    const m = await membershipFor(req);
    if (m.inst.status !== "active") throw new HttpError(409, "Your institute is not active yet. StudyTrack is still reviewing it.", "INSTITUTE_NOT_ACTIVE");
    return m;
  }
  async function memberById(instituteId, idParam) {
    const id = parseId(idParam);
    const member = id && await db.one("SELECT id,name,email,institute_role,institute_note FROM users WHERE id=$1 AND institute_id=$2 AND role='teacher'", [id, instituteId]);
    if (!member) throw new HttpError(404, "Teacher not found in this institute");
    return member;
  }
  async function assertTeacherSeat(inst) {
    if (instituteEnforced(inst) && inst.max_teachers != null && await teacherCountFor(db, inst.id) >= inst.max_teachers) {
      throw new HttpError(403, "This institute has reached its teacher limit. Ask the institute head to contact StudyTrack.", "LIMIT_TEACHERS");
    }
  }

  async function homeData(inst, viewerId, viewerRole) {
    const members = await db.many(`SELECT id,name,email,institute_role,institute_note FROM users WHERE institute_id=$1 AND role='teacher'
      ORDER BY CASE institute_role WHEN 'head' THEN 0 WHEN 'co_head' THEN 1 ELSE 2 END,lower(name),id`, [inst.id]);
    const seeAllCodes = isHeadRole(viewerRole);
    const out = [];
    for (const m of members) {
      const classes = await db.many(`SELECT c.id,c.name,c.code,c.suspended,(SELECT COUNT(*) FROM student_class_memberships sm WHERE sm.class_id=c.id AND sm.status='active') AS student_count
        FROM classes c WHERE c.teacher_id=$1 ORDER BY c.id`, [m.id]);
      const scores = await db.many("SELECT mk.marks,t.max_marks FROM marks mk JOIN tests t ON t.id=mk.test_id WHERE t.teacher_id=$1", [m.id]);
      const att = await db.one("SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN a.status='present' THEN 1 ELSE 0 END),0) AS present FROM attendance a JOIN classes c ON c.id=a.class_id WHERE c.teacher_id=$1", [m.id]);
      const hw = await db.one("SELECT COUNT(*) AS n FROM homework WHERE teacher_id=$1", [m.id]);
      out.push({
        id: m.id, name: m.name, email: m.email, role: m.institute_role || "teacher", note: m.institute_note, is_me: m.id === viewerId,
        classes: classes.map(c => ({ id: c.id, name: c.name, student_count: c.student_count, suspended: Boolean(c.suspended), code: seeAllCodes || m.id === viewerId ? c.code : undefined })),
        class_count: classes.length, student_count: classes.reduce((s, c) => s + c.student_count, 0),
        average_percentage: scores.length ? Number((scores.reduce((a, x) => a + x.marks * 100 / x.max_marks, 0) / scores.length).toFixed(1)) : null,
        attendance_percentage: att.total ? Number((att.present * 100 / att.total).toFixed(1)) : null, homework_count: hw.n,
      });
    }
    return out;
  }

  r.get("/api/institute/home", ...guard, async (req, res) => {
    const { inst, myRole } = await membershipFor(req);
    const summary = { id: inst.id, name: inst.name, status: inst.status, status_reason: inst.status_reason, code: isHeadRole(myRole) ? inst.code : undefined };
    if (inst.status !== "active") return res.json({ institute: summary, myRole, teachers: null });
    res.json({ institute: summary, myRole, teachers: await homeData(inst, req.user.id, myRole) });
  });

  // "Create Your Own Coaching Institute": the signed-in teacher becomes the head once the owner approves the request.
  r.post("/api/institute/request", ...guard, limiters.signup.guard, async (req, res) => {
    const b = req.body || {};
    const name = v.str(b.instituteName, "Institute name", { min: 3, max: 80 });
    const code = v.code(b.coachingCode, "Coaching code", { optional: true });
    const phone = v.str(b.phone, "Contact phone", { min: 6, max: 20 });
    if (!phoneOk(phone)) throw new HttpError(400, "Enter a valid contact phone number");
    const city = v.optStr(b.city, "City", { max: 80 }), description = v.optStr(b.description, "Description", { max: 500, multiline: true });
    const expectedTeachers = v.optInt(b.expectedTeachers, "Expected teachers", { min: 0, max: 100000 }), expectedStudents = v.optInt(b.expectedStudents, "Expected students", { min: 0, max: 1000000 });
    const me = await db.one("SELECT id,email,institute_id,institute_role FROM users WHERE id=$1", [req.user.id]);
    let rejectedId = null;
    if (me.institute_id) {
      const current = await getInstitute(db, me.institute_id);
      if (current && current.status === "rejected" && me.institute_role === "head") rejectedId = current.id;
      else throw new HttpError(409, "Your account already belongs to a coaching institute.");
    }
    if (code && await codeInUse(db, code)) {
      const own = rejectedId && await db.one("SELECT 1 AS x FROM institutes WHERE id=$1 AND code=$2", [rejectedId, code]);
      if (!own) throw new HttpError(409, "That coaching code is already taken. Choose another or leave it blank to generate one.");
    }
    const finalCode = code || await generateUniqueCode(db, crypto.randomInt, 8);
    let instituteId;
    try {
      instituteId = await db.tx(async t => {
        if (rejectedId) {
          await t.exec("UPDATE users SET institute_id=NULL,institute_role=NULL WHERE id=$1", [me.id]);
          await t.exec("DELETE FROM institutes WHERE id=$1", [rejectedId]);
        }
        const inst = await t.one(`INSERT INTO institutes(name,code,head_id,owner_email,contact_phone,city,description,expected_teachers,expected_students,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [name, finalCode, me.id, me.email, phone, city, description, expectedTeachers, expectedStudents, clock.nowIso()]);
        await t.exec("UPDATE users SET institute_id=$1,institute_role='head' WHERE id=$2", [inst.id, me.id]);
        return inst.id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, "That coaching code is already taken");
      throw error;
    }
    res.status(201).json({ institute: { id: instituteId, name, code: finalCode, status: "pending" } });
  });

  // A teacher joins an existing, active institute with its coaching code.
  r.post("/api/institute/join", ...guard, limiters.joinIp.guard, limiters.join.guard, async (req, res) => {
    if (req.user.institute_id) throw new HttpError(409, "You already belong to a coaching institute");
    const code = v.code(req.body?.code, "Coaching code");
    const inst = await db.one("SELECT * FROM institutes WHERE code=$1 AND status='active'", [code]);
    if (!inst) throw new HttpError(404, "No active coaching institute found with that code. Check it with your institute head.");
    await assertTeacherSeat(inst);
    const n = await db.exec("UPDATE users SET institute_id=$1,institute_role='teacher' WHERE id=$2 AND institute_id IS NULL", [inst.id, req.user.id]);
    if (!n) throw new HttpError(409, "You already belong to a coaching institute");
    if (inst.head_id) await notify(db, clock, [inst.head_id], { type: "teacher_joined", title: `${req.user.name} joined ${inst.name}` });
    res.json({ ok: true, institute: { id: inst.id, name: inst.name, status: inst.status, role: "teacher" } });
  });

  r.post("/api/institute/members/:id/role", ...guard, async (req, res) => {
    const { inst, myRole } = await activeMembershipFor(req);
    if (!isHeadRole(myRole)) throw new HttpError(403, "Only institute heads can change roles");
    const newRole = v.oneOf(req.body?.role, "Role", ["co_head", "teacher"]);
    const member = await memberById(inst.id, req.params.id);
    if (member.institute_role === "head") throw new HttpError(403, "The institute head's role can't be changed");
    const current = member.institute_role || "teacher";
    if (current === newRole) return res.json({ ok: true, role: newRole });
    const steppingDown = member.id === req.user.id && newRole === "teacher";
    if (myRole === "co_head" && !(newRole === "co_head" || steppingDown)) throw new HttpError(403, "Only the institute head can remove another co-head's role");
    await db.exec("UPDATE users SET institute_role=$1 WHERE id=$2", [newRole, member.id]);
    res.json({ ok: true, role: newRole });
  });
  r.post("/api/institute/members/:id/note", ...guard, async (req, res) => {
    const { inst, myRole } = await activeMembershipFor(req);
    if (!isHeadRole(myRole)) throw new HttpError(403, "Only institute heads can write feedback notes");
    const note = v.optStr(req.body?.note, "Note", { max: 300 });
    const member = await memberById(inst.id, req.params.id);
    if (member.institute_role === "head") throw new HttpError(403, "Notes can't be added to the institute head");
    await db.exec("UPDATE users SET institute_note=$1 WHERE id=$2", [note, member.id]);
    res.json({ ok: true });
  });
  r.delete("/api/institute/members/:id", ...guard, async (req, res) => {
    const { inst, myRole } = await activeMembershipFor(req);
    if (!isHeadRole(myRole)) throw new HttpError(403, "Only institute heads can remove teachers");
    const member = await memberById(inst.id, req.params.id);
    if (member.institute_role === "head") throw new HttpError(403, "The institute head can't be removed");
    if (member.id === req.user.id) throw new HttpError(400, "Use Leave institute to remove yourself");
    if (myRole === "co_head" && member.institute_role === "co_head") throw new HttpError(403, "Only the institute head can remove a co-head");
    await db.exec("UPDATE users SET institute_id=NULL,institute_role=NULL,institute_note='' WHERE id=$1", [member.id]);
    res.json({ ok: true });
  });
  r.post("/api/institute/leave", ...guard, async (req, res) => {
    const { myRole } = await membershipFor(req);
    if (myRole === "head") throw new HttpError(403, "The institute head can't leave. Contact StudyTrack support to close or transfer the institute.");
    await db.exec("UPDATE users SET institute_id=NULL,institute_role=NULL,institute_note='' WHERE id=$1", [req.user.id]);
    res.json({ ok: true });
  });
}
