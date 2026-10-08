import test from "node:test";
import assert from "node:assert/strict";
import { createTestApp, Browser } from "./helpers.mjs";
import { makePdf, upload } from "./fixtures.mjs";

const mkTeacher = async (app, n) => { const b = new Browser(app); const r = await b.signIn({ sub: `t${n}`, email: `t${n}@gmail.com`, name: `Teacher ${n}`, role: "teacher" }); b.id = r.body.user.id; return b; };
const mkStudent = async (app, n) => { const b = new Browser(app); const r = await b.signIn({ sub: `s${n}`, email: `s${n}@gmail.com`, name: `Student ${n}`, role: "student" }); b.id = r.body.user.id; return b; };
const mkClass = async (t, name) => (await t.post("/api/teacher/classes", { name })).body;
const enroll = (app, s, c) => app.db.exec("INSERT INTO student_class_memberships(student_id,class_id,status,joined_at) VALUES($1,$2,'active',$3)", [s.id, c.id, app.clock.nowIso()]);
const details = { instituteName: "Bright Academy", phone: "99999 11111", city: "Pune", description: "Coaching", expectedTeachers: 5, expectedStudents: 200 };
async function adminLogin(app, key = "owner-key-123456") {
  const a = new Browser(app); const r = await a.post("/api/admin/login", { key }, { headers: {} });
  if (r.status === 200) a.csrf = r.body.csrfToken; a.status = r.status; return a;
}
const act = async (admin, id, action, reason = "") => admin.post(`/api/admin/institutes/${id}/status`, { action, reason });

test("create institute request, owner approves, teachers join with the code, roles and members", async () => {
  const app = await createTestApp({ limits: { join: 100, joinIp: 100 } });
  const head = await mkTeacher(app, 1), t2 = await mkTeacher(app, 2), t3 = await mkTeacher(app, 3), s = await mkStudent(app, 1);
  for (const bad of [{ ...details, instituteName: "ab" }, { ...details, phone: "abc" }, { ...details, coachingCode: "x y" }, { ...details, expectedStudents: -1 }, { ...details, city: "c".repeat(81) }]) assert.equal((await head.post("/api/institute/request", bad)).status, 400);
  assert.equal((await s.post("/api/institute/request", details)).status, 403, "students cannot create institutes");
  const r = await head.post("/api/institute/request", { ...details, coachingCode: "bright1" }); assert.equal(r.status, 201); assert.equal(r.body.institute.code, "BRIGHT1"); assert.equal(r.body.institute.status, "pending");
  assert.equal((await head.post("/api/institute/request", details)).status, 409, "one institute per teacher");
  assert.equal((await t2.post("/api/institute/request", { ...details, coachingCode: "BRIGHT1" })).status, 409, "code taken");
  assert.equal((await t2.post("/api/institute/join", { code: "BRIGHT1" })).status, 404, "pending institutes cannot be joined");
  const me = (await head.get("/api/me")).body; assert.equal(me.institute.status, "pending"); assert.equal(me.institute.my_role, "head");
  const admin = await adminLogin(app); assert.equal(admin.status, 200);
  assert.equal((await act(admin, r.body.institute.id, "approve")).body.institute.status, "active");
  assert.ok((await head.get("/api/notifications")).body.notifications.some(n => /now active/.test(n.title)));
  assert.equal((await t2.post("/api/institute/join", { code: "bright1" })).status, 200);
  assert.equal((await t2.post("/api/institute/join", { code: "BRIGHT1" })).status, 409, "already a member");
  assert.equal((await t3.post("/api/institute/join", { code: "ZZZZZZ" })).status, 404);
  assert.equal((await t3.post("/api/institute/join", { code: "bad code" })).status, 400);
  await t3.post("/api/institute/join", { code: "BRIGHT1" });
  const c = await mkClass(t2, "Math"); assert.ok(c.id);
  const home = (await head.get("/api/institute/home")).body; assert.equal(home.teachers.length, 3); assert.equal(home.teachers[0].role, "head");
  assert.equal(home.teachers.find(t => t.name === "Teacher 2").classes[0].code, c.code, "heads see class codes");
  const t2home = (await t2.get("/api/institute/home")).body; assert.equal(t2home.institute.code, undefined, "plain teachers do not see the institute code");
  assert.equal(t2home.teachers.find(t => t.name === "Teacher 3").classes.length, 0);
  assert.equal((await t2.post(`/api/institute/members/${t3.id}/role`, { role: "co_head" })).status, 403);
  assert.equal((await head.post(`/api/institute/members/${t3.id}/role`, { role: "co_head" })).status, 200);
  assert.equal((await head.post(`/api/institute/members/${head.id}/role`, { role: "teacher" })).status, 403, "head role cannot change");
  assert.equal((await head.post(`/api/institute/members/${t2.id}/role`, { role: "owner" })).status, 400);
  assert.equal((await t3.post(`/api/institute/members/${t2.id}/note`, { note: "Great" })).status, 200, "co-head can write notes");
  assert.equal((await t2.post(`/api/institute/members/${t3.id}/note`, { note: "x" })).status, 403);
  assert.equal((await t3.delete(`/api/institute/members/${head.id}`)).status, 403);
  assert.equal((await head.delete(`/api/institute/members/${head.id}`)).status, 403);
  assert.equal((await head.delete(`/api/institute/members/${t2.id}`)).status, 200); assert.equal((await t2.get("/api/institute/home")).status, 404);
  assert.equal((await head.post("/api/institute/leave")).status, 403); assert.equal((await t3.post("/api/institute/leave")).status, 200);
  assert.equal((await t3.get("/api/me")).body.institute, null);
  const outsider = await mkTeacher(app, 9); assert.equal((await outsider.delete(`/api/institute/members/${t3.id}`)).status, 404);
});

test("owner admin: separate signed cookie, CSRF, rate-limited, user sessions do not count", async () => {
  const app = await createTestApp();
  const a = await adminLogin(app); assert.equal(a.status, 200);
  const setCookie = (await new Browser(app).post("/api/admin/login", { key: "owner-key-123456" })).setCookies[0]; assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
  assert.equal((await a.get("/api/admin/overview")).status, 200);
  assert.equal((await a.get("/api/admin/session")).body.csrfToken, a.csrf);
  assert.equal((await a.call("POST", "/api/admin/classes/1/status", { action: "suspend" }, { headers: { "x-csrf-token": "" } })).body.code, "BAD_CSRF");
  assert.equal((await a.call("POST", "/api/admin/logout", {}, { headers: { origin: "https://evil.example.com" } })).body.code, "BAD_ORIGIN");
  const tampered = new Browser(app); tampered.cookies.st_admin = a.cookies.st_admin.replace(/.$/, c => (c === "a" ? "b" : "a")); assert.equal((await tampered.get("/api/admin/overview")).status, 401);
  const forged = new Browser(app); forged.cookies.st_admin = Buffer.from(JSON.stringify({ r: "admin", e: 9e15, n: "x" })).toString("base64url") + ".deadbeef"; assert.equal((await forged.get("/api/admin/overview")).status, 401);
  app.advance(13 * 3600_000); assert.equal((await a.get("/api/admin/overview")).status, 401, "expires after 12 hours");
  const wrong = []; for (let i = 0; i < 6; i++) wrong.push((await adminLogin(app, "guess-" + i)).status);
  assert.deepEqual(wrong, [401, 401, 401, 401, 401, 429]); assert.equal((await adminLogin(app)).status, 429, "even the right key is refused while locked out");
  const noKey = await createTestApp({ env: { ADMIN_KEY: "" } }); assert.equal((await new Browser(noKey).post("/api/admin/login", { key: "" })).status, 503);
  const u = await mkTeacher(await createTestApp(), 1); assert.equal((await u.get("/api/admin/overview")).status, 401);
  assert.ok((await app.db.one("SELECT COUNT(*) AS n FROM security_events WHERE type='admin_login_failed'")).n >= 5);
  const fresh = await adminLogin(await createTestApp()); assert.equal((await fresh.get("/api/admin/security-events")).status, 200);
});

test("suspending an institute pauses ITS classes only; a student's other classes keep working", async () => {
  const app = await createTestApp();
  const head = await mkTeacher(app, 1), indep = await mkTeacher(app, 2);
  const inst = (await head.post("/api/institute/request", details)).body.institute; const admin = await adminLogin(app); await act(admin, inst.id, "approve");
  const c1 = await mkClass(head, "Institute class"), c2 = await mkClass(indep, "Independent class");
  const s = await mkStudent(app, 1); await enroll(app, s, c1); await enroll(app, s, c2);
  await head.post("/api/teacher/homework", { title: "Inst HW" }, { headers: { "x-class-id": String(c1.id) } }); await indep.post("/api/teacher/homework", { title: "Indep HW" });
  assert.equal((await s.get("/api/student/dashboard")).body.homework.length, 2);
  assert.equal((await act(admin, inst.id, "suspend", "Unpaid")).body.institute.status, "suspended");
  assert.equal((await act(admin, inst.id, "suspend")).status, 409, "invalid transition");
  const blocked = await head.get("/api/teacher/overview"); assert.equal(blocked.status, 403); assert.equal(blocked.body.code, "INSTITUTE_SUSPENDED"); assert.match(blocked.body.error, /Unpaid/);
  assert.equal((await new Browser(app).signIn({ sub: "t1", email: "t1@gmail.com", role: "teacher" })).body.code, "INSTITUTE_SUSPENDED");
  const dash = (await s.get("/api/student/dashboard")).body;
  assert.deepEqual(dash.homework.map(h => h.title), ["Indep HW"], "paused class data is hidden, the other class still works");
  assert.equal(dash.classes.find(c => c.id === c1.id).available, false); assert.match(dash.classes.find(c => c.id === c1.id).unavailable_reason, /paused/);
  assert.equal((await s.post("/api/student/study-log", { category: "tuition", subject: "Phy", minutes: 30, studyDate: "2026-10-07" })).status, 201, "personal study logging is never blocked");
  const hwId = (await app.db.one("SELECT id FROM homework WHERE title='Inst HW'")).id;
  assert.equal((await s.post(`/api/student/homework/${hwId}/submit`, { note: "x" })).status, 403);
  assert.equal((await s.get(`/api/student/dashboard?classId=${c1.id}`)).status, 404);
  assert.equal((await s.get("/api/calendar")).status, 200);
  const joiner = await mkStudent(app, 2); assert.equal((await joiner.post("/api/student/join-request", { classCode: c1.code })).status, 403);
  assert.equal((await act(admin, inst.id, "reactivate")).body.institute.status, "active");
  assert.equal((await head.get("/api/teacher/overview")).status, 200); assert.equal((await s.get("/api/student/dashboard")).body.homework.length, 2);
  // ban, then unban
  await act(admin, inst.id, "ban", "Fraud"); assert.equal((await head.get("/api/teacher/overview")).body.code, "INSTITUTE_BANNED"); await act(admin, inst.id, "unban");
  assert.equal((await head.get("/api/teacher/overview")).status, 200);
});

test("read-only mode blocks writes but not reads; limits (teachers, students per institute, storage); independent mode", async () => {
  const app = await createTestApp({ limits: { join: 100, joinIp: 100 } });
  const head = await mkTeacher(app, 1), t2 = await mkTeacher(app, 2), t3 = await mkTeacher(app, 3);
  const inst = (await head.post("/api/institute/request", { ...details, coachingCode: "LIMIT1" })).body.institute; const admin = await adminLogin(app); await act(admin, inst.id, "approve");
  const c1 = await mkClass(head, "One"), c2 = await mkClass(head, "Two");
  assert.equal((await admin.patch(`/api/admin/institutes/${inst.id}/limits`, { max_teachers: 2, max_students: 2, storage_limit_mb: 5, read_only: false })).status, 200);
  assert.equal((await t2.post("/api/institute/join", { code: "LIMIT1" })).status, 200);
  const full = await t3.post("/api/institute/join", { code: "LIMIT1" }); assert.equal(full.status, 403); assert.equal(full.body.code, "LIMIT_TEACHERS");
  const sA = await mkStudent(app, 1), sB = await mkStudent(app, 2), sC = await mkStudent(app, 3);
  const approve = async (s, c) => { await s.post("/api/student/join-request", { classCode: c.code }); const id = (await head.get("/api/teacher/join-requests")).body.pending.find(x => x.student_id === s.id && x.class_id === c.id).id; return head.post(`/api/teacher/join-requests/${id}/approve`); };
  assert.equal((await approve(sA, c1)).status, 200); assert.equal((await approve(sB, c1)).status, 200);
  assert.equal((await approve(sA, c2)).status, 200, "a student already in the institute takes NO new seat for a second class");
  const over = await approve(sC, c1); assert.equal(over.status, 409); assert.equal(over.body.code, "LIMIT_STUDENTS");
  assert.equal((await admin.patch(`/api/admin/institutes/${inst.id}/limits`, { max_teachers: 2, max_students: 2, storage_limit_mb: 5, read_only: true })).status, 200);
  const w = await head.post("/api/teacher/homework", { title: "x" }); assert.equal(w.status, 403); assert.equal(w.body.code, "READ_ONLY");
  assert.equal((await head.get("/api/teacher/overview")).status, 200);
  const hw = (await app.db.exec("INSERT INTO homework(teacher_id,class_id,title,created_at) VALUES($1,$2,'H',$3)", [head.id, c1.id, app.clock.nowIso()]), (await app.db.one("SELECT id FROM homework")).id);
  assert.equal((await sA.post(`/api/student/homework/${hw}/submit`, { note: "x" })).body.code, "READ_ONLY");
  assert.equal((await sA.get("/api/student/dashboard")).status, 200);
  assert.equal((await admin.patch(`/api/admin/institutes/${inst.id}/limits`, { max_teachers: 0 })).status, 400);
  // independent: the owner releases control; limits / read-only / suspension no longer apply and the admin panel cannot change them
  assert.equal((await admin.patch(`/api/admin/institutes/${inst.id}/control`, { mode: "independent" })).status, 200);
  assert.equal((await head.post("/api/teacher/homework", { title: "works again" })).status, 201);
  assert.equal((await act(admin, inst.id, "suspend")).body.code, "INDEPENDENT");
  assert.equal((await admin.post(`/api/admin/classes/${c1.id}/status`, { action: "suspend" })).body.code, "INDEPENDENT");
  assert.equal((await admin.post(`/api/admin/teachers/${head.id}/status`, { action: "ban" })).body.code, "INDEPENDENT");
  assert.equal((await admin.delete(`/api/admin/institutes/${inst.id}`)).body.code, "INDEPENDENT");
  assert.equal((await approve(sC, c1)).status, 200, "limits cleared");
  assert.equal((await admin.patch(`/api/admin/institutes/${inst.id}/control`, { mode: "managed" })).status, 200);
});

test("admin: reject and re-request, class suspend, teacher ban kills sessions, delete institute with data cleans storage", async () => {
  const app = await createTestApp();
  const head = await mkTeacher(app, 1); const inst = (await head.post("/api/institute/request", details)).body.institute; const admin = await adminLogin(app);
  assert.equal((await act(admin, inst.id, "reject", "Incomplete")).body.institute.status, "rejected");
  assert.equal((await head.get("/api/teacher/overview")).status, 200, "rejected institutes do not lock the teacher out");
  assert.equal((await head.post("/api/institute/request", { ...details, coachingCode: "SECOND1" })).status, 201, "a rejected head can apply again");
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM institutes")).n, 1);
  const inst2 = (await admin.get("/api/admin/institutes")).body.institutes[0]; assert.equal(inst2.status, "pending"); assert.equal(inst2.head_email, "t1@gmail.com"); assert.equal(inst2.usage.teachers, 1);
  await act(admin, inst2.id, "approve");
  const cls = await mkClass(head, "Phys"); const s = await mkStudent(app, 1); await enroll(app, s, cls);
  await head.post("/api/teacher/homework", { title: "With file" }, { file: upload(makePdf(), "a.pdf", "application/pdf") });
  assert.equal(app.storage.buckets.get("studytrack-files").size, 1);
  assert.equal((await admin.post(`/api/admin/classes/${cls.id}/status`, { action: "suspend", reason: "Review" })).status, 200);
  assert.equal((await head.post("/api/teacher/homework", { title: "blocked" })).body.code, "CLASS_SUSPENDED");
  assert.equal((await s.get("/api/student/dashboard")).body.classes[0].available, false);
  await admin.post(`/api/admin/classes/${cls.id}/status`, { action: "reactivate" });
  const ov = (await admin.get("/api/admin/overview")).body; assert.equal(ov.institutes.active, 1); assert.equal(ov.teachers, 1); assert.equal(ov.students, 1); assert.ok(ov.storage_bytes > 0); assert.ok(ov.active_sessions >= 2);
  assert.equal((await admin.get("/api/admin/classes")).body.classes[0].student_count, 1);
  assert.equal((await admin.get("/api/admin/teachers")).body.teachers[0].class_count, 1);
  assert.equal((await admin.get(`/api/admin/institutes/${inst2.id}`)).body.teachers[0].classes[0].student_count, 1);
  assert.equal((await admin.post(`/api/admin/teachers/${head.id}/status`, { action: "ban", reason: "abuse" })).status, 200);
  assert.equal((await head.get("/api/me")).status, 401, "ban signs the teacher out everywhere");
  assert.equal((await admin.post(`/api/admin/teachers/${head.id}/status`, { action: "unban" })).status, 200);
  assert.equal((await admin.post(`/api/admin/institutes/${inst2.id}/status`, { action: "explode" })).status, 400);
  assert.equal((await admin.patch(`/api/admin/institutes/${inst2.id}/note`, { note: "Paid 5000" })).status, 200);
  assert.equal((await admin.delete(`/api/admin/institutes/${inst2.id}?withData=true`)).body.teachers, 1);
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM users WHERE role='teacher'")).n, 0); assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM classes")).n, 0);
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM student_class_memberships")).n, 0); assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM users WHERE role='student'")).n, 1, "students keep their accounts");
  assert.equal(app.storage.buckets.get("studytrack-files").size, 0, "files are removed from storage");
  assert.ok((await admin.get("/api/admin/log")).body.log.length >= 5);
  assert.equal((await admin.get("/api/admin/institutes/9999")).status, 404);
  assert.equal((await admin.get("/api/admin/institutes/abc")).status, 404);
});

test("deleting an institute WITHOUT data turns teachers into independent teachers", async () => {
  const app = await createTestApp(); const head = await mkTeacher(app, 1); const inst = (await head.post("/api/institute/request", details)).body.institute; const admin = await adminLogin(app);
  await act(admin, inst.id, "approve"); await mkClass(head, "Keep me");
  assert.equal((await admin.delete(`/api/admin/institutes/${inst.id}`)).status, 200);
  assert.equal((await head.get("/api/me")).body.institute, null); assert.equal((await head.get("/api/teacher/context")).body.classes.length, 1);
});
