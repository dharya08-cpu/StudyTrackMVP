import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, makeKit } from "./helpers.mjs";

let srv, api, kit;
before(async () => { srv = await startServer(); api = srv.api; kit = makeKit(api); });
after(async () => { await srv.stop(); });

test("health check and unknown API routes return JSON", async () => {
  assert.equal((await api.get("/api/health")).data.ok, true);
  const missing = await api.get("/api/does-not-exist");
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error, "Not found");
});

test("student registers without a class code and has no class yet", async () => {
  const s = await kit.student("Asha");
  const status = await api.get("/api/student/class-status", { token: s.token });
  assert.equal(status.status, 200);
  assert.equal(status.data.joined, false);
  assert.equal(status.data.pending, null);
  assert.equal(status.data.lastDecision, null);
  const dash = await api.get("/api/student/dashboard", { token: s.token });
  assert.equal(dash.status, 409);
  assert.equal(dash.data.code, "NO_CLASS");
});

test("wrong class code is rejected, right code creates exactly one pending request", async () => {
  const t = await kit.teacher("Mehta");
  const s = await kit.student("Ravi");
  const wrong = await api.post("/api/student/join-request", { classCode: "NOPE99" }, { token: s.token });
  assert.equal(wrong.status, 404);
  const ok = await api.post("/api/student/join-request", { classCode: t.classCode.toLowerCase() }, { token: s.token });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.request.teacherName, "Mehta");
  const again = await api.post("/api/student/join-request", { classCode: t.classCode }, { token: s.token });
  assert.equal(again.status, 409);
  const status = await api.get("/api/student/class-status", { token: s.token });
  assert.equal(status.data.pending.teacherName, "Mehta");
  const dash = await api.get("/api/student/dashboard", { token: s.token });
  assert.equal(dash.status, 409, "a student waiting for approval has no class data");
});

test("student can cancel a pending request and send a new one", async () => {
  const t = await kit.teacher("Cancel T");
  const s = await kit.student("Cancel S");
  await api.post("/api/student/join-request", { classCode: t.classCode }, { token: s.token });
  assert.equal((await api.post("/api/student/join-request/cancel", {}, { token: s.token })).status, 200);
  assert.equal((await api.post("/api/student/join-request/cancel", {}, { token: s.token })).status, 404);
  const pending = await api.get("/api/teacher/join-requests", { token: t.token });
  assert.equal(pending.data.pending.length, 0);
  assert.equal((await api.post("/api/student/join-request", { classCode: t.classCode }, { token: s.token })).status, 201);
});

test("teacher sees the request, approves it, and the student joins the class", async () => {
  const t = await kit.teacher("Kapoor");
  const s = await kit.student("Neha");
  await api.post("/api/student/join-request", { classCode: t.classCode }, { token: s.token });
  const list = await api.get("/api/teacher/join-requests", { token: t.token });
  assert.equal(list.data.pending.length, 1);
  assert.equal(list.data.pending[0].student_name, "Neha");
  assert.equal(list.data.pending[0].class_name, "Kapoor Class");
  const ctx = await api.get("/api/teacher/context", { token: t.token });
  assert.equal(ctx.data.pending_total, 1);
  const approve = await api.post(`/api/teacher/join-requests/${list.data.pending[0].id}/approve`, {}, { token: t.token });
  assert.equal(approve.status, 200);
  assert.equal((await api.post(`/api/teacher/join-requests/${list.data.pending[0].id}/approve`, {}, { token: t.token })).status, 409, "cannot approve twice");
  const status = await api.get("/api/student/class-status", { token: s.token });
  assert.equal(status.data.joined, true);
  assert.equal(status.data.class.teacherName, "Kapoor");
  assert.equal((await api.get("/api/student/dashboard", { token: s.token })).status, 200);
  const overview = await api.get("/api/teacher/overview", { token: t.token, classId: t.classId });
  assert.deepEqual(overview.data.students.map(x => x.name), ["Neha"]);
  assert.equal((await api.post("/api/student/join-request", { classCode: t.classCode }, { token: s.token })).status, 409, "a joined student cannot request again");
});

test("Deny & Remove tells the student and lets them try again", async () => {
  const t = await kit.teacher("Verma");
  const s = await kit.student("Dev");
  await api.post("/api/student/join-request", { classCode: t.classCode }, { token: s.token });
  const [req] = (await api.get("/api/teacher/join-requests", { token: t.token })).data.pending;
  assert.equal((await api.post(`/api/teacher/join-requests/${req.id}/deny`, { mode: "bogus" }, { token: t.token })).status, 400);
  assert.equal((await api.post(`/api/teacher/join-requests/${req.id}/deny`, { mode: "remove" }, { token: t.token })).status, 200);
  assert.equal((await api.get("/api/teacher/join-requests", { token: t.token })).data.pending.length, 0);
  const status = await api.get("/api/student/class-status", { token: s.token });
  assert.equal(status.data.joined, false);
  assert.equal(status.data.lastDecision.status, "denied");
  assert.equal(status.data.lastDecision.teacherName, "Verma");
  assert.equal((await api.post("/api/student/join-request", { classCode: t.classCode }, { token: s.token })).status, 201, "a removed request can be re-sent");
});

test("Deny & Block needs confirmation, blocks every class of that teacher, and can be undone", async () => {
  const t = await kit.teacher("Singh");
  const second = await api.post("/api/teacher/classes", { name: "Second batch", code: "SING02" }, { token: t.token });
  assert.equal(second.status, 201);
  const other = await kit.teacher("Other Teacher");
  const s = await kit.student("Blocked Kid");
  await api.post("/api/student/join-request", { classCode: t.classCode }, { token: s.token });
  const [req] = (await api.get("/api/teacher/join-requests", { token: t.token })).data.pending;
  const unconfirmed = await api.post(`/api/teacher/join-requests/${req.id}/deny`, { mode: "block" }, { token: t.token });
  assert.equal(unconfirmed.status, 400);
  assert.equal(unconfirmed.data.code, "CONFIRM_REQUIRED");
  assert.equal((await api.get("/api/teacher/join-requests", { token: t.token })).data.pending.length, 1, "nothing changed without confirmation");
  assert.equal((await api.post(`/api/teacher/join-requests/${req.id}/deny`, { mode: "block", confirm: true }, { token: t.token })).status, 200);

  const status = await api.get("/api/student/class-status", { token: s.token });
  assert.equal(status.data.lastDecision.status, "blocked");
  const viaSecond = await api.post("/api/student/join-request", { classCode: "SING02" }, { token: s.token });
  assert.equal(viaSecond.status, 403);
  assert.equal(viaSecond.data.code, "BLOCKED");
  assert.match(viaSecond.data.error, /Singh/);
  const viaFirst = await api.post("/api/student/join-request", { classCode: t.classCode }, { token: s.token });
  assert.equal(viaFirst.status, 403);

  const blocked = (await api.get("/api/teacher/join-requests", { token: t.token })).data.blocked;
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].student_name, "Blocked Kid");

  // The block is per teacher: another teacher's class still accepts this student.
  assert.equal((await api.post("/api/student/join-request", { classCode: other.classCode }, { token: s.token })).status, 201);
  await api.post("/api/student/join-request/cancel", {}, { token: s.token });

  // Unblocking removes the "blocked" message and allows requests again.
  assert.equal((await api.del(`/api/teacher/blocks/${blocked[0].id}`, { token: t.token })).status, 200);
  assert.equal((await api.get("/api/student/class-status", { token: s.token })).data.lastDecision?.status ?? "denied", "denied");
  assert.equal((await api.post("/api/student/join-request", { classCode: "SING02" }, { token: s.token })).status, 201);
});

test("teachers cannot act on each other's requests, classes or students", async () => {
  const a = await kit.teacher("Teacher A");
  const b = await kit.teacher("Teacher B");
  const s = await kit.student("Shared Kid");
  await api.post("/api/student/join-request", { classCode: a.classCode }, { token: s.token });
  const [req] = (await api.get("/api/teacher/join-requests", { token: a.token })).data.pending;
  assert.equal((await api.post(`/api/teacher/join-requests/${req.id}/approve`, {}, { token: b.token })).status, 404);
  assert.equal((await api.post(`/api/teacher/join-requests/${req.id}/deny`, { mode: "remove" }, { token: b.token })).status, 404);
  await api.post(`/api/teacher/join-requests/${req.id}/approve`, {}, { token: a.token });
  assert.equal((await api.get(`/api/teacher/student/${s.id}/analytics`, { token: b.token })).status, 404);
  assert.equal((await api.get(`/api/teacher/student/${s.id}/analytics`, { token: a.token })).status, 200);
  assert.equal((await api.get("/api/teacher/overview", { token: b.token, classId: a.classId })).status, 404, "a class id from another teacher is rejected");
});

test("a teacher can run several classes and each room only shows its own students", async () => {
  const t = await kit.teacher("Multi");
  const class2 = await api.post("/api/teacher/classes", { name: "Class 2" }, { token: t.token });
  assert.equal(class2.status, 201);
  assert.match(class2.data.code, /^[A-Z0-9]{6}$/, "code is generated when left blank");
  assert.equal((await api.post("/api/teacher/classes", { name: "Dup", code: class2.data.code }, { token: t.token })).status, 409);
  assert.equal((await api.post("/api/teacher/classes", { name: "", code: "ABCD12" }, { token: t.token })).status, 400);
  assert.equal((await api.post("/api/teacher/classes", { name: "Bad", code: "a!" }, { token: t.token })).status, 400);

  const s1 = await kit.student("In Class 1"), s2 = await kit.student("In Class 2");
  await api.post("/api/student/join-request", { classCode: t.classCode }, { token: s1.token });
  await api.post("/api/student/join-request", { classCode: class2.data.code }, { token: s2.token });
  const pending = (await api.get("/api/teacher/join-requests", { token: t.token })).data.pending;
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.map(p => p.class_name).sort(), ["Class 2", "Multi Class"]);
  for (const p of pending) await api.post(`/api/teacher/join-requests/${p.id}/approve`, {}, { token: t.token });

  const room1 = await api.get("/api/teacher/overview", { token: t.token, classId: t.classId });
  const room2 = await api.get("/api/teacher/overview", { token: t.token, classId: class2.data.id });
  assert.deepEqual(room1.data.students.map(x => x.name), ["In Class 1"]);
  assert.deepEqual(room2.data.students.map(x => x.name), ["In Class 2"]);
  assert.equal(room2.data.class.name, "Class 2");
  assert.equal((await api.get("/api/teacher/overview", { token: t.token, classId: "abc" })).status, 400);
  assert.equal((await api.get("/api/teacher/overview", { token: t.token, classId: 999999 })).status, 404);

  // Homework created inside Class 2 belongs to Class 2 only.
  assert.equal((await api.post("/api/teacher/homework", { title: "C2 homework" }, { token: t.token, classId: class2.data.id })).status, 201);
  assert.equal((await api.get("/api/teacher/overview", { token: t.token, classId: t.classId })).data.homework.length, 0);
  assert.equal((await api.get("/api/teacher/overview", { token: t.token, classId: class2.data.id })).data.homework.length, 1);
  const ctx = await api.get("/api/teacher/context", { token: t.token });
  assert.deepEqual(ctx.data.classes.map(c => c.student_count), [1, 1]);
});

test("teacher can remove a student from the class; the student can then join elsewhere", async () => {
  const t = await kit.teacher("Remover");
  const other = await kit.teacher("Other Room");
  const s = await kit.student("Wrongly Approved");
  await api.post("/api/student/join-request", { classCode: t.classCode }, { token: s.token });
  const [req] = (await api.get("/api/teacher/join-requests", { token: t.token })).data.pending;
  await api.post(`/api/teacher/join-requests/${req.id}/approve`, {}, { token: t.token });
  assert.equal((await api.del(`/api/teacher/students/${s.id}`, { token: other.token })).status, 404, "only the student's own teacher can remove them");
  assert.equal((await api.del("/api/teacher/students/abc", { token: t.token })).status, 404);
  assert.equal((await api.del(`/api/teacher/students/${s.id}`, { token: t.token })).status, 200);
  assert.equal((await api.get("/api/student/class-status", { token: s.token })).data.joined, false);
  assert.equal((await api.get("/api/teacher/overview", { token: t.token, classId: t.classId })).data.students.length, 0);
  assert.equal((await api.post("/api/student/join-request", { classCode: other.classCode }, { token: s.token })).status, 201);
});
