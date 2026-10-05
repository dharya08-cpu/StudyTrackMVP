import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, makeKit } from "./helpers.mjs";

let srv, api, kit, admin;
before(async () => {
  srv = await startServer();
  api = srv.api; kit = makeKit(api); admin = await kit.adminToken();
});
after(async () => { await srv.stop(); });

test("teacher self-signup: creates account + class, code stored, duplicates rejected, no Termux needed", async () => {
  const r = await api.post("/api/auth/teacher-register", { name: "Self Serve", email: "Self@Example.com", password: "secret123", className: "Physics 11", classCode: "phy11" });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.role, "teacher");
  const ctx = await api.get("/api/teacher/context", { token: r.data.token });
  assert.equal(ctx.data.classes[0].code, "PHY11");
  assert.equal(ctx.data.institute, null);
  assert.equal((await api.post("/api/auth/teacher-register", { name: "X", email: "self@example.com", password: "secret123", className: "A", classCode: "OTHER1" })).status, 409, "email is case-insensitive unique");
  assert.equal((await api.post("/api/auth/teacher-register", { name: "X", email: "x2@example.com", password: "secret123", className: "A", classCode: "PHY11" })).status, 409, "class code unique");
  assert.equal((await api.post("/api/auth/teacher-register", { name: "X", email: "x3@example.com", password: "123", className: "A" })).status, 400);
  assert.equal((await api.post("/api/auth/teacher-register", { name: "X", email: "bad", password: "secret123", className: "A" })).status, 400);
  const generated = await api.post("/api/auth/teacher-register", { name: "Gen", email: "gen@example.com", password: "secret123", className: "Auto" });
  assert.equal(generated.status, 201);
  const login = await api.post("/api/auth/login", { email: "gen@example.com", password: "secret123", role: "teacher" });
  assert.equal(login.status, 200);
  assert.equal((await api.post("/api/auth/login", { email: "gen@example.com", password: "secret123", role: "student" })).status, 401);
  assert.equal((await api.post("/api/admin/create-teacher", {})).status, 404, "old Termux-era endpoint is gone");
});

test("institute request: stays pending until the owner approves; code is not joinable before that", async () => {
  const email = `head${kit.unique()}@example.com`;
  const r = await api.post("/api/auth/institute-request", kit.instituteBody({ coachingCode: "bright1", name: "Dr Head", email, password: "secret123" }));
  assert.equal(r.status, 201);
  assert.equal(r.data.institute.status, "pending");
  assert.equal(r.data.institute.code, "BRIGHT1");
  const home = await api.get("/api/institute/home", { token: r.data.token });
  assert.equal(home.data.institute.status, "pending");
  assert.equal(home.data.teachers, null, "no teacher list until approved");
  const early = await api.post("/api/auth/teacher-join-institute", { name: "Early", email: `e${kit.unique()}@example.com`, password: "secret123", coachingCode: "BRIGHT1" });
  assert.equal(early.status, 404, "pending code cannot be used");

  assert.equal((await api.get("/api/admin/institutes", { token: r.data.token })).status, 401, "normal user token is not an admin token");
  assert.equal((await api.get("/api/admin/institutes")).status, 401);
  const list = await api.get("/api/admin/institutes", { token: admin });
  const row = list.data.institutes.find(i => i.code === "BRIGHT1");
  assert.equal(row.status, "pending");
  assert.equal(row.head_email, email);
  assert.equal((await api.post(`/api/admin/institutes/${row.id}/status`, { action: "suspend" }, { token: admin })).status, 409, "cannot suspend a pending institute");
  assert.equal((await api.post(`/api/admin/institutes/${row.id}/status`, { action: "approve" }, { token: admin })).status, 200);
  assert.equal((await api.post(`/api/admin/institutes/${row.id}/status`, { action: "approve" }, { token: admin })).status, 409);
  assert.equal((await api.get("/api/institute/home", { token: r.data.token })).data.institute.status, "active");
  const join = await api.post("/api/auth/teacher-join-institute", { name: "Late", email: `l${kit.unique()}@example.com`, password: "secret123", coachingCode: "bright1" });
  assert.equal(join.status, 201);
  assert.equal(join.data.landing, "institute");
});

test("institute request validation, taken codes, rejected requests can be resubmitted", async () => {
  const base = kit.instituteBody({ name: "N", email: `v${kit.unique()}@example.com`, password: "secret123" });
  assert.equal((await api.post("/api/auth/institute-request", { ...base, instituteName: "AB" })).status, 400);
  assert.equal((await api.post("/api/auth/institute-request", { ...base, phone: "abc" })).status, 400);
  assert.equal((await api.post("/api/auth/institute-request", { ...base, coachingCode: "x" })).status, 400);
  assert.equal((await api.post("/api/auth/institute-request", { ...base, expectedTeachers: -3 })).status, 400);
  const first = await api.post("/api/auth/institute-request", { ...base, coachingCode: "TAKEN1" });
  assert.equal(first.status, 201);
  const clash = await api.post("/api/auth/institute-request", { ...base, email: `v${kit.unique()}@example.com`, coachingCode: "TAKEN1" });
  assert.equal(clash.status, 409);
  const t = await kit.teacher("Class Code Owner", "CLS999");
  const clash2 = await api.post("/api/auth/institute-request", { ...base, email: `v${kit.unique()}@example.com`, coachingCode: t.classCode });
  assert.equal(clash2.status, 409, "coaching codes and class codes share one namespace");
  const again = await api.post("/api/auth/institute-request", { ...base, email: base.email });
  assert.equal(again.status, 409, "same head cannot open two institutes");
  await api.post(`/api/admin/institutes/${first.data.institute.id}/status`, { action: "reject", reason: "Incomplete details" }, { token: admin });
  const home = await api.get("/api/institute/home", { token: first.data.token });
  assert.equal(home.data.institute.status, "rejected");
  assert.equal(home.data.institute.status_reason, "Incomplete details");
  const retry = await api.post("/api/auth/institute-request", { ...base, coachingCode: "TAKEN1", instituteName: "Better Details" });
  assert.equal(retry.status, 201, "rejected head can resubmit, even reusing their own code");
  assert.equal(retry.data.institute.status, "pending");
});

test("existing independent teacher can create or join an institute with their password", async () => {
  const t = await kit.teacher("Existing One");
  const wrong = await api.post("/api/auth/institute-request", kit.instituteBody({ email: t.email, password: "wrong-pass" }));
  assert.equal(wrong.status, 401);
  const ok = await api.post("/api/auth/institute-request", kit.instituteBody({ email: t.email, password: t.password, coachingCode: "EXIST1" }));
  assert.equal(ok.status, 201);
  const ctx = await api.get("/api/teacher/context", { token: ok.data.token });
  assert.equal(ctx.data.classes.length, 1, "their class and data are kept");
  assert.equal(ctx.data.institute.role, "head");

  const inst = await kit.activeInstitute();
  const t2 = await kit.teacher("Existing Two");
  const joined = await api.post("/api/auth/teacher-join-institute", { email: t2.email, password: t2.password, coachingCode: inst.code });
  assert.equal(joined.status, 200);
  assert.equal(joined.data.landing, "institute");
  const again = await api.post("/api/auth/teacher-join-institute", { email: t2.email, password: t2.password, coachingCode: inst.code });
  assert.equal(again.status, 409);
  const student = await kit.student("A Student");
  const asStudent = await api.post("/api/auth/teacher-join-institute", { email: student.email, password: student.password, coachingCode: inst.code });
  assert.equal(asStudent.status, 409, "student emails cannot become teachers");
});

test("logged-in independent teacher can join by code from inside the app", async () => {
  const inst = await kit.activeInstitute();
  const t = await kit.teacher("Inside Joiner");
  assert.equal((await api.post("/api/institute/join", { code: "ZZZZZZ" }, { token: t.token })).status, 404);
  assert.equal((await api.post("/api/institute/join", { code: inst.code }, { token: t.token })).status, 200);
  assert.equal((await api.post("/api/institute/join", { code: inst.code }, { token: t.token })).status, 409);
  const home = await api.get("/api/institute/home", { token: t.token });
  assert.equal(home.data.myRole, "teacher");
  assert.equal(home.data.institute.code, undefined, "regular teachers do not see the institute code");
});

test("institute home lists teachers with classes, counts and notes; code visibility by role", async () => {
  const inst = await kit.activeInstitute({ code: "HOME01" });
  const t1 = await kit.joinInstitute(inst.code, "Anita");
  const t2 = await kit.joinInstitute(inst.code, "Bhavin");
  const c1 = (await api.get("/api/teacher/context", { token: t1.token })).data.classes;
  assert.equal(c1.length, 0, "institute joiners start with no class");
  const made = await api.post("/api/teacher/classes", { name: "Anita Batch", code: "ANI001" }, { token: t1.token });
  assert.equal(made.status, 201);
  const s = await kit.student("Pupil");
  await api.post("/api/student/join-request", { classCode: "ANI001" }, { token: s.token });
  const req = (await api.get("/api/teacher/join-requests", { token: t1.token })).data.pending[0];
  await api.post(`/api/teacher/join-requests/${req.id}/approve`, {}, { token: t1.token });

  const headHome = await api.get("/api/institute/home", { token: inst.head.token });
  assert.equal(headHome.data.institute.code, "HOME01");
  assert.deepEqual(headHome.data.teachers.map(t => t.name), ["Head Teacher", "Anita", "Bhavin"], "head first, then alphabetical");
  const anita = headHome.data.teachers.find(t => t.name === "Anita");
  assert.equal(anita.student_count, 1);
  assert.equal(anita.classes[0].code, "ANI001", "heads see every class code");
  const bhavinView = await api.get("/api/institute/home", { token: t2.token });
  const anitaForBhavin = bhavinView.data.teachers.find(t => t.name === "Anita");
  assert.equal(anitaForBhavin.classes[0].code, undefined, "peers do not see each other's class codes");
  assert.equal(anitaForBhavin.classes[0].name, "Anita Batch");
  assert.equal(anitaForBhavin.classes[0].student_count, 1, "peers still see class sizes");

  const note = await api.post(`/api/institute/members/${anita.id}/note`, { note: "Great feedback from students" }, { token: inst.head.token });
  assert.equal(note.status, 200);
  assert.equal((await api.post(`/api/institute/members/${anita.id}/note`, { note: "x" }, { token: t2.token })).status, 403);
  const after = await api.get("/api/institute/home", { token: t2.token });
  assert.equal(after.data.teachers.find(t => t.name === "Anita").note, "Great feedback from students");
});

test("head can create a co-head; co-head gets head powers but cannot touch the head", async () => {
  const inst = await kit.activeInstitute();
  const a = await kit.joinInstitute(inst.code, "Alpha");
  const b = await kit.joinInstitute(inst.code, "Beta");
  assert.equal((await api.post(`/api/institute/members/${b.id}/role`, { role: "co_head" }, { token: a.token })).status, 403, "regular teacher cannot promote");
  assert.equal((await api.post(`/api/institute/members/${a.id}/role`, { role: "co_head" }, { token: inst.head.token })).status, 200);
  const coHome = await api.get("/api/institute/home", { token: a.token });
  assert.equal(coHome.data.myRole, "co_head");
  assert.equal(coHome.data.institute.code, inst.code, "co-heads can see the institute code");
  assert.equal((await api.post(`/api/institute/members/${inst.head.id}/role`, { role: "teacher" }, { token: a.token })).status, 403);
  assert.equal((await api.del(`/api/institute/members/${inst.head.id}`, { token: a.token })).status, 403);
  assert.equal((await api.post(`/api/institute/members/${b.id}/role`, { role: "co_head" }, { token: a.token })).status, 200, "co-head can promote others");
  assert.equal((await api.post(`/api/institute/members/${b.id}/role`, { role: "teacher" }, { token: a.token })).status, 403, "co-head cannot demote another co-head");
  assert.equal((await api.post(`/api/institute/members/${b.id}/role`, { role: "teacher" }, { token: inst.head.token })).status, 200);
  assert.equal((await api.post(`/api/institute/members/${a.id}/role`, { role: "teacher" }, { token: a.token })).status, 200, "a co-head can step down");
  assert.equal((await api.post(`/api/institute/members/${b.id}/role`, { role: "boss" }, { token: inst.head.token })).status, 400);
});

test("removing and leaving: teacher keeps account and classes, head cannot leave", async () => {
  const inst = await kit.activeInstitute();
  const a = await kit.joinInstitute(inst.code, "Leaver");
  await api.post("/api/teacher/classes", { name: "Own class" }, { token: a.token });
  assert.equal((await api.post("/api/institute/leave", {}, { token: inst.head.token })).status, 403);
  assert.equal((await api.post("/api/institute/leave", {}, { token: a.token })).status, 200);
  assert.equal((await api.get("/api/institute/home", { token: a.token })).status, 404);
  assert.equal((await api.get("/api/teacher/context", { token: a.token })).data.classes.length, 1);
  const b = await kit.joinInstitute(inst.code, "Removed");
  assert.equal((await api.del(`/api/institute/members/${b.id}`, { token: a.token })).status, 404, "outsiders cannot manage the institute");
  assert.equal((await api.del(`/api/institute/members/${b.id}`, { token: inst.head.token })).status, 200);
  assert.equal((await api.del(`/api/institute/members/${inst.head.id}`, { token: inst.head.token })).status, 403);
});

test("suspend → teachers and students are blocked immediately; reactivate restores; ban; unban", async () => {
  const inst = await kit.activeInstitute();
  const t = await kit.joinInstitute(inst.code, "Suspended T");
  const made = await api.post("/api/teacher/classes", { name: "Susp class", code: "SUSP01" }, { token: t.token });
  const s = await kit.student("Susp Student");
  await api.post("/api/student/join-request", { classCode: "SUSP01" }, { token: s.token });
  const req = (await api.get("/api/teacher/join-requests", { token: t.token })).data.pending[0];
  await api.post(`/api/teacher/join-requests/${req.id}/approve`, {}, { token: t.token });
  assert.equal((await api.get("/api/student/dashboard", { token: s.token })).status, 200);

  const suspend = await api.post(`/api/admin/institutes/${inst.instituteId}/status`, { action: "suspend", reason: "Demo period over" }, { token: admin });
  assert.equal(suspend.status, 200);
  const tBlocked = await api.get("/api/teacher/overview", { token: t.token, classId: made.data.id });
  assert.equal(tBlocked.status, 403);
  assert.equal(tBlocked.data.code, "INSTITUTE_SUSPENDED");
  assert.match(tBlocked.data.error, /Demo period over/);
  const sBlocked = await api.get("/api/student/dashboard", { token: s.token });
  assert.equal(sBlocked.status, 403);
  assert.equal(sBlocked.data.code, "INSTITUTE_SUSPENDED");
  assert.doesNotMatch(sBlocked.data.error, /Demo period over/, "students are not shown internal reasons");
  assert.equal((await api.post("/api/auth/login", { email: t.email, password: t.password })).status, 403, "login is refused too");
  assert.equal((await api.post("/api/auth/login", { email: s.email, password: s.password })).status, 403);
  const late = await kit.student("Late Joiner");
  assert.equal((await api.post("/api/student/join-request", { classCode: "SUSP01" }, { token: late.token })).status, 403, "no new requests while suspended");
  assert.equal((await api.post("/api/auth/teacher-join-institute", { name: "N", email: `n${kit.unique()}@example.com`, password: "secret123", coachingCode: inst.code })).status, 404, "suspended code cannot be joined");

  assert.equal((await api.post(`/api/admin/institutes/${inst.instituteId}/status`, { action: "reactivate" }, { token: admin })).status, 200);
  assert.equal((await api.get("/api/student/dashboard", { token: s.token })).status, 200);
  assert.equal((await api.post(`/api/admin/institutes/${inst.instituteId}/status`, { action: "ban", reason: "Chargeback" }, { token: admin })).status, 200);
  assert.equal((await api.get("/api/student/dashboard", { token: s.token })).data.code, "INSTITUTE_BANNED");
  assert.equal((await api.post(`/api/admin/institutes/${inst.instituteId}/status`, { action: "reactivate" }, { token: admin })).status, 409, "banned must be unbanned, not reactivated");
  assert.equal((await api.post(`/api/admin/institutes/${inst.instituteId}/status`, { action: "unban" }, { token: admin })).status, 200);
  assert.equal((await api.get("/api/teacher/context", { token: t.token })).status, 200);
});

test("class suspension, teacher ban and class deletion from the admin panel", async () => {
  const t = await kit.teacher("Solo Teacher", "SOLO01");
  const s = await kit.student("Solo Student");
  await api.post("/api/student/join-request", { classCode: "SOLO01" }, { token: s.token });
  const req = (await api.get("/api/teacher/join-requests", { token: t.token })).data.pending[0];
  await api.post(`/api/teacher/join-requests/${req.id}/approve`, {}, { token: t.token });

  const classes = (await api.get("/api/admin/classes", { token: admin })).data.classes;
  const row = classes.find(c => c.code === "SOLO01");
  assert.equal(row.student_count, 1);
  assert.equal(row.teacher_email, t.email);
  assert.equal(row.institute_id, null);

  await api.post(`/api/admin/classes/${row.id}/status`, { action: "suspend", reason: "Unpaid" }, { token: admin });
  const blockedTeacher = await api.get("/api/teacher/overview", { token: t.token, classId: row.id });
  assert.equal(blockedTeacher.status, 403);
  assert.equal(blockedTeacher.data.code, "CLASS_SUSPENDED");
  assert.equal((await api.get("/api/student/dashboard", { token: s.token })).data.code, "CLASS_SUSPENDED");
  assert.equal((await api.get("/api/teacher/context", { token: t.token })).status, 200, "teacher can still sign in to see the notice");
  await api.post(`/api/admin/classes/${row.id}/status`, { action: "reactivate" }, { token: admin });
  assert.equal((await api.get("/api/student/dashboard", { token: s.token })).status, 200);

  await api.post(`/api/admin/teachers/${t.id}/status`, { action: "ban", reason: "Abuse" }, { token: admin });
  assert.equal((await api.get("/api/teacher/context", { token: t.token })).data.code, "ACCOUNT_BANNED");
  assert.equal((await api.get("/api/student/dashboard", { token: s.token })).data.code, "CLASS_UNAVAILABLE");
  assert.equal((await api.post("/api/auth/login", { email: t.email, password: t.password })).status, 403);
  await api.post(`/api/admin/teachers/${t.id}/status`, { action: "unban" }, { token: admin });
  assert.equal((await api.get("/api/teacher/context", { token: t.token })).status, 200);

  assert.equal((await api.del(`/api/admin/classes/${row.id}`, { token: admin })).status, 200);
  const status = await api.get("/api/student/class-status", { token: s.token });
  assert.equal(status.data.joined, false, "student is left without a class and can join another");
  assert.equal((await api.get("/api/admin/classes", { token: admin })).data.classes.some(c => c.code === "SOLO01"), false);
});

test("limits: teacher cap, student cap, storage cap and read-only mode", async () => {
  const inst = await kit.activeInstitute();
  const set = body => api.patch(`/api/admin/institutes/${inst.instituteId}/limits`, body, { token: admin });
  assert.equal((await set({ max_teachers: 0 })).status, 400);
  assert.equal((await set({ max_teachers: 2, max_students: 1, storage_limit_mb: 1, read_only: false })).status, 200);
  await kit.joinInstitute(inst.code, "Seat Two");
  const full = await api.post("/api/auth/teacher-join-institute", { name: "Seat Three", email: `x${kit.unique()}@example.com`, password: "secret123", coachingCode: inst.code });
  assert.equal(full.status, 403);
  assert.equal(full.data.code, "LIMIT_TEACHERS");

  const klass = await api.post("/api/teacher/classes", { name: "Cap class", code: "CAP001" }, { token: inst.head.token });
  const s1 = await kit.student("Cap One"), s2 = await kit.student("Cap Two");
  await api.post("/api/student/join-request", { classCode: "CAP001" }, { token: s1.token });
  await api.post("/api/student/join-request", { classCode: "CAP001" }, { token: s2.token });
  const pending = (await api.get("/api/teacher/join-requests", { token: inst.head.token })).data.pending;
  assert.equal((await api.post(`/api/teacher/join-requests/${pending[0].id}/approve`, {}, { token: inst.head.token })).status, 200);
  const over = await api.post(`/api/teacher/join-requests/${pending[1].id}/approve`, {}, { token: inst.head.token });
  assert.equal(over.status, 409);
  assert.equal(over.data.code, "LIMIT_STUDENTS");

  const hw = await api.post("/api/teacher/homework", { title: "Sheet" }, { token: inst.head.token, classId: klass.data.id });
  assert.equal(hw.status, 201);
  const detail = await api.get(`/api/admin/institutes/${inst.instituteId}`, { token: admin });
  assert.equal(detail.data.institute.usage.students, 1);
  assert.equal(detail.data.institute.usage.storage_bytes, 0);

  assert.equal((await set({ read_only: true })).status, 200);
  assert.equal((await api.post("/api/teacher/homework", { title: "Blocked write" }, { token: inst.head.token, classId: klass.data.id })).data.code, "READ_ONLY");
  assert.equal((await api.get("/api/teacher/overview", { token: inst.head.token, classId: klass.data.id })).status, 200, "reads still work");
  assert.equal((await api.post("/api/student/study-log", { category: "self-study", subject: "Maths", minutes: 30, studyDate: "2026-10-01" }, { token: s1.token })).data.code, "READ_ONLY");
  assert.equal((await api.get("/api/student/dashboard", { token: s1.token })).status, 200);
});

test("make independent: restrictions are lifted and the admin panel can no longer control it", async () => {
  const inst = await kit.activeInstitute();
  const t = await kit.joinInstitute(inst.code, "Indep T");
  const c = await api.post("/api/teacher/classes", { name: "Indep class", code: "INDEP1" }, { token: t.token });
  await api.patch(`/api/admin/institutes/${inst.instituteId}/limits`, { max_teachers: 5, read_only: true }, { token: admin });
  await api.post(`/api/admin/classes/${c.data.id}/status`, { action: "suspend" }, { token: admin });
  await api.post(`/api/admin/institutes/${inst.instituteId}/status`, { action: "suspend" }, { token: admin });
  assert.equal((await api.patch(`/api/admin/institutes/${inst.instituteId}/control`, { mode: "independent" }, { token: admin })).status, 409, "must be active first");
  await api.post(`/api/admin/institutes/${inst.instituteId}/status`, { action: "reactivate" }, { token: admin });
  const made = await api.patch(`/api/admin/institutes/${inst.instituteId}/control`, { mode: "independent" }, { token: admin });
  assert.equal(made.status, 200);
  assert.equal(made.data.institute.control_mode, "independent");
  assert.equal(made.data.institute.read_only, false);
  assert.equal(made.data.institute.max_teachers, null);
  assert.equal((await api.post("/api/teacher/homework", { title: "Works again" }, { token: t.token, classId: c.data.id })).status, 201, "read-only and class suspension were cleared");
  for (const [method, route, body] of [
    ["post", `/api/admin/institutes/${inst.instituteId}/status`, { action: "suspend" }],
    ["patch", `/api/admin/institutes/${inst.instituteId}/limits`, { max_teachers: 1 }],
    ["post", `/api/admin/classes/${c.data.id}/status`, { action: "suspend" }],
    ["post", `/api/admin/teachers/${t.id}/status`, { action: "ban" }],
  ]) {
    const r = await api[method](route, body, { token: admin });
    assert.equal(r.status, 409, route);
    assert.equal(r.data.code, "INDEPENDENT");
  }
  assert.equal((await api.del(`/api/admin/institutes/${inst.instituteId}`, { token: admin })).status, 409);
  assert.equal((await api.del(`/api/admin/classes/${c.data.id}`, { token: admin })).status, 409);
  assert.equal((await api.get("/api/teacher/context", { token: t.token })).status, 200);
  const back = await api.patch(`/api/admin/institutes/${inst.instituteId}/control`, { mode: "managed" }, { token: admin });
  assert.equal(back.data.institute.control_mode, "managed");
  assert.equal((await api.post(`/api/admin/institutes/${inst.instituteId}/status`, { action: "suspend" }, { token: admin })).status, 200);
});

test("delete institute: without data keeps teachers; with data removes everything and cleans storage", async () => {
  const keep = await kit.activeInstitute();
  const t = await kit.joinInstitute(keep.code, "Stay Teacher");
  await api.post("/api/teacher/classes", { name: "Stay class" }, { token: t.token });
  const d1 = await api.del(`/api/admin/institutes/${keep.instituteId}`, { token: admin });
  assert.equal(d1.status, 200);
  assert.equal((await api.get("/api/teacher/context", { token: t.token })).data.classes.length, 1, "teacher and class survive");
  assert.equal((await api.get("/api/institute/home", { token: t.token })).status, 404);
  assert.equal((await api.get("/api/admin/institutes/" + keep.instituteId, { token: admin })).status, 404);

  const gone = await kit.activeInstitute();
  const t2 = await kit.joinInstitute(gone.code, "Doomed Teacher");
  const klass = await api.post("/api/teacher/classes", { name: "Doomed class", code: "DOOM01" }, { token: t2.token });
  const s = await kit.student("Orphan Student");
  await api.post("/api/student/join-request", { classCode: "DOOM01" }, { token: s.token });
  const req = (await api.get("/api/teacher/join-requests", { token: t2.token })).data.pending[0];
  await api.post(`/api/teacher/join-requests/${req.id}/approve`, {}, { token: t2.token });
  assert.equal((await api.post("/api/teacher/homework", { title: "Doomed hw" }, { token: t2.token, classId: klass.data.id })).status, 201);
  const d2 = await api.del(`/api/admin/institutes/${gone.instituteId}?withData=true`, { token: admin });
  assert.equal(d2.status, 200);
  assert.equal((await api.post("/api/auth/login", { email: t2.email, password: t2.password })).status, 401, "teacher account removed");
  assert.equal((await api.post("/api/auth/login", { email: s.email, password: s.password })).status, 200, "student account is kept");
  assert.equal((await api.get("/api/student/class-status", { token: s.token })).data.joined, false);
  assert.equal((await api.get("/api/admin/classes", { token: admin })).data.classes.some(c => c.code === "DOOM01"), false);
});

test("admin login: wrong key, rate limit, overview, activity log", async () => {
  assert.equal((await api.post("/api/admin/login", { key: "wrong" })).status, 401);
  assert.equal((await api.post("/api/admin/login", {})).status, 401);
  const ov = await api.get("/api/admin/overview", { token: admin });
  assert.equal(ov.status, 200);
  assert.ok(ov.data.institutes.total > 0 && ov.data.teachers > 0 && ov.data.students > 0);
  assert.equal(typeof ov.data.database_bytes, "number");
  const log = await api.get("/api/admin/log", { token: admin });
  assert.ok(log.data.log.some(l => l.action === "approve"));
  const teachers = await api.get("/api/admin/teachers", { token: admin });
  assert.ok(teachers.data.teachers.length > 0);
  // brute-force protection: after 8 failures from one IP the limiter answers 429, even for the right key
  let last;
  for (let i = 0; i < 9; i++) last = await api.post("/api/admin/login", { key: "nope-" + i });
  assert.equal(last.status, 429);
  assert.equal((await api.post("/api/admin/login", { key: "test-admin-key-123456" })).status, 429);
});
