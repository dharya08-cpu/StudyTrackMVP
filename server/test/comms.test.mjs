import test from "node:test";
import assert from "node:assert/strict";
import { createTestApp, Browser } from "./helpers.mjs";

const mkTeacher = async (app, n) => { const b = new Browser(app); const r = await b.signIn({ sub: `t${n}`, email: `t${n}@gmail.com`, name: `Teacher ${n}`, role: "teacher" }); b.id = r.body.user.id; return b; };
const mkStudent = async (app, n) => { const b = new Browser(app); const r = await b.signIn({ sub: `s${n}`, email: `s${n}@gmail.com`, name: `Student ${n}`, role: "student" }); b.id = r.body.user.id; return b; };
const mkClass = async (t, name) => (await t.post("/api/teacher/classes", { name })).body;
const enroll = async (app, student, cls) => { await app.db.exec("INSERT INTO student_class_memberships(student_id,class_id,status,joined_at) VALUES($1,$2,'active',$3) ON CONFLICT(student_id,class_id) DO UPDATE SET status='active'", [student.id, cls.id, app.clock.nowIso()]); };
const unread = async b => (await b.get("/api/notifications")).body.unread;
const makeInstitute = async (app, head, extra = {}) => { const r = await head.post("/api/institute/request", { instituteName: "Bright Academy", phone: "99999 11111", ...extra }); await app.db.exec("UPDATE institutes SET status='active' WHERE id=$1", [r.body.institute.id]); return r.body.institute; };

test("announcement to ONE class reaches only that class's students and appears in their notification centre", async () => {
  const app = await createTestApp();
  const t = await mkTeacher(app, 1); const phy = await mkClass(t, "Physics 11"), chem = await mkClass(t, "Chemistry 11");
  const sPhy = await mkStudent(app, 1), sChem = await mkStudent(app, 2), both = await mkStudent(app, 3), nobody = await mkStudent(app, 4);
  await enroll(app, sPhy, phy); await enroll(app, sChem, chem); await enroll(app, both, phy); await enroll(app, both, chem);
  const r = await t.post("/api/teacher/announcements", { title: "Important", body: "Tomorrow's Physics class will begin at 5 PM instead of 4 PM.", priority: "important", scope: "class", classIds: [phy.id] });
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.delivered, 2);
  assert.equal(await unread(sPhy), 1); assert.equal(await unread(both), 1, "a student in two classes gets ONE notification"); assert.equal(await unread(sChem), 0); assert.equal(await unread(nobody), 0);
  const n = (await sPhy.get("/api/notifications")).body.notifications[0];
  assert.equal(n.type, "announcement"); assert.equal(n.priority, "important"); assert.match(n.body, /5 PM/); assert.equal(n.class_id, phy.id);
  assert.equal((await sPhy.get("/api/student/announcements")).body.announcements[0].title, "Important");
  assert.equal((await sChem.get("/api/student/announcements")).body.announcements.length, 0);
  assert.equal((await both.get("/api/student/announcements")).body.announcements.length, 1);
  assert.equal((await t.get("/api/teacher/announcements")).body.announcements[0].classes[0], "Physics 11");
  assert.equal((await t.post("/api/teacher/announcements", { title: "No scope", body: "x" })).status, 400);
});

test("announcement to MULTIPLE classes; validation; cannot target another teacher's class", async () => {
  const app = await createTestApp();
  const t = await mkTeacher(app, 1), other = await mkTeacher(app, 2); const a = await mkClass(t, "A"), b = await mkClass(t, "B"), c = await mkClass(t, "C"), foreign = await mkClass(other, "F");
  const sa = await mkStudent(app, 1), sb = await mkStudent(app, 2), sc = await mkStudent(app, 3), sf = await mkStudent(app, 4);
  await enroll(app, sa, a); await enroll(app, sb, b); await enroll(app, sc, c); await enroll(app, sf, foreign);
  const r = await t.post("/api/teacher/announcements", { title: "Holiday notice", body: "School closed Friday", scope: "classes", classIds: [a.id, b.id] });
  assert.equal(r.body.delivered, 2); assert.equal(await unread(sa), 1); assert.equal(await unread(sb), 1); assert.equal(await unread(sc), 0); assert.equal(await unread(sf), 0);
  assert.equal((await t.post("/api/teacher/announcements", { title: "x", body: "y", scope: "classes", classIds: [a.id] })).status, 400, "'classes' needs at least two");
  assert.equal((await t.post("/api/teacher/announcements", { title: "x", body: "y", scope: "classes", classIds: [a.id, foreign.id] })).status, 404);
  assert.equal((await t.post("/api/teacher/announcements", { title: "x", body: "y", scope: "class", classIds: [foreign.id] })).status, 404);
  assert.equal(await unread(sf), 0, "foreign student untouched");
  for (const bad of [{ title: "", body: "x" }, { title: "t", body: "" }, { title: "t".repeat(121), body: "x" }, { title: "t", body: "x".repeat(2001) }, { title: "t", body: "x", priority: "urgent" }, { title: ["t"], body: "x" }]) assert.equal((await t.post("/api/teacher/announcements", { scope: "class", classIds: [a.id], ...bad })).status, 400, JSON.stringify(bad).slice(0, 50));
  assert.equal((await (await mkStudent(app, 9)).post("/api/teacher/announcements", { title: "x", body: "y", scope: "class", classIds: [a.id] })).status, 403, "students cannot announce");
});

test("announcement to the ENTIRE institute: heads only; reaches every class's students and the other teachers", async () => {
  const app = await createTestApp();
  const head = await mkTeacher(app, 1), colleague = await mkTeacher(app, 2), indep = await mkTeacher(app, 3);
  const inst = await makeInstitute(app, head);
  await app.db.exec("UPDATE users SET institute_id=$1,institute_role='teacher' WHERE id=$2", [inst.id, colleague.id]);
  const c1 = await mkClass(head, "Head class"), c2 = await mkClass(colleague, "Colleague class"), c3 = await mkClass(indep, "Independent class");
  const s1 = await mkStudent(app, 1), s2 = await mkStudent(app, 2), s3 = await mkStudent(app, 3); await enroll(app, s1, c1); await enroll(app, s2, c2); await enroll(app, s3, c3);
  const body = { title: "Annual day", body: "Friday 4 PM in the auditorium", scope: "institute" };
  assert.equal((await colleague.post("/api/teacher/announcements", body)).status, 403, "plain teachers cannot announce institute-wide");
  assert.equal((await indep.post("/api/teacher/announcements", body)).status, 403);
  const r = await head.post("/api/teacher/announcements", body); assert.equal(r.status, 201); assert.equal(r.body.delivered, 3);
  assert.equal(await unread(s1), 1); assert.equal(await unread(s2), 1); assert.equal(await unread(colleague), 1); assert.equal(await unread(s3), 0, "other institutes are never reached"); assert.equal(await unread(indep), 0); assert.equal(await unread(head), 0);
  assert.equal((await s2.get("/api/student/announcements")).body.announcements[0].title, "Annual day");
  assert.equal((await s3.get("/api/student/announcements")).body.announcements.length, 0);
  const lateJoiner = await mkStudent(app, 4); await enroll(app, lateJoiner, c2);
  assert.equal((await lateJoiner.get("/api/student/announcements")).body.announcements.length, 1, "institute notices are visible to students who join later");
  assert.equal((await head.get("/api/teacher/announcements")).body.announcements[0].classes[0], "Entire institute");
  await app.db.exec("UPDATE institutes SET status='pending' WHERE id=$1", [inst.id]);
  assert.equal((await head.post("/api/teacher/announcements", body)).status, 403, "inactive institute");
});

test("deleting an announcement removes it and its notifications; only the author may", async () => {
  const app = await createTestApp(); const t = await mkTeacher(app, 1), o = await mkTeacher(app, 2); const c = await mkClass(t, "A"); const s = await mkStudent(app, 1); await enroll(app, s, c);
  const id = (await t.post("/api/teacher/announcements", { title: "Oops", body: "wrong time", scope: "class", classIds: [c.id] })).body.id;
  assert.equal((await o.delete(`/api/teacher/announcements/${id}`)).status, 404); assert.equal(await unread(s), 1);
  assert.equal((await t.delete(`/api/teacher/announcements/${id}`)).status, 200);
  assert.equal(await unread(s), 0); assert.equal((await s.get("/api/student/announcements")).body.announcements.length, 0);
  assert.equal((await t.delete(`/api/teacher/announcements/${id}`)).status, 404);
});

test("announcement rate limit and class suspension", async () => {
  const app = await createTestApp({ limits: { announce: 3 } }); const t = await mkTeacher(app, 1); const c = await mkClass(t, "A");
  const post = () => t.post("/api/teacher/announcements", { title: "t", body: "b", scope: "class", classIds: [c.id] });
  assert.deepEqual([await post(), await post(), await post(), await post()].map(r => r.status), [201, 201, 201, 429]);
  await app.db.exec("UPDATE classes SET suspended=TRUE"); app.advance(3600_001);
  assert.equal((await post()).body.code, "CLASS_SUSPENDED");
});

test("notification centre: list, paging, unread count, mark read, read-all, delete, isolation between users", async () => {
  const app = await createTestApp(); const t = await mkTeacher(app, 1); const c = await mkClass(t, "A"); const s = await mkStudent(app, 1), s2 = await mkStudent(app, 2); await enroll(app, s, c); await enroll(app, s2, c);
  for (let i = 1; i <= 5; i++) await t.post("/api/teacher/announcements", { title: `N${i}`, body: "b", scope: "class", classIds: [c.id] });
  const page1 = (await s.get("/api/notifications?limit=2")).body; assert.deepEqual(page1.notifications.map(n => n.title), ["N5", "N4"]); assert.equal(page1.unread, 5); assert.ok(page1.next);
  const page2 = (await s.get(`/api/notifications?limit=2&before=${page1.next}`)).body; assert.deepEqual(page2.notifications.map(n => n.title), ["N3", "N2"]);
  assert.equal((await s.get("/api/notifications/unread-count")).body.unread, 5);
  const id = page1.notifications[0].id;
  assert.equal((await s.post(`/api/notifications/${id}/read`)).status, 200); assert.equal(await unread(s), 4);
  assert.equal((await s2.post(`/api/notifications/${id}/read`)).status, 404, "cannot touch another user's notification");
  assert.equal((await s2.delete(`/api/notifications/${id}`)).status, 404); assert.equal(await unread(s2), 5);
  assert.equal((await s.get("/api/notifications?unread=1&limit=100")).body.notifications.length, 4);
  assert.equal((await s.post("/api/notifications/read-all")).body.updated, 4); assert.equal(await unread(s), 0); assert.equal(await unread(s2), 5);
  assert.equal((await s.delete(`/api/notifications/${id}`)).status, 200); assert.equal((await s.get("/api/notifications?limit=100")).body.notifications.length, 4);
  assert.equal((await s.get("/api/notifications?limit=abc")).status, 200); assert.equal((await s.get("/api/notifications?before=0")).status, 400);
});

test("calendar: classes, homework deadlines, tests, events and holidays in ONE view, per audience", async () => {
  const app = await createTestApp();
  const head = await mkTeacher(app, 1); const inst = await makeInstitute(app, head);
  const phy = await mkClass(head, "Physics 11"), chem = await mkClass(head, "Chemistry 11");
  const other = await mkTeacher(app, 2); const oc = await mkClass(other, "Other"); const sOther = await mkStudent(app, 9); await enroll(app, sOther, oc);
  const s = await mkStudent(app, 1); await enroll(app, s, phy); await enroll(app, s, chem);
  const inClass = c => ({ headers: { "x-class-id": String(c.id) } });
  assert.equal((await head.post("/api/teacher/schedule", { weekday: 3, startTime: "17:00", endTime: "18:00", subject: "Physics", room: "Lab 1" }, inClass(phy))).status, 201);
  assert.equal((await head.post("/api/teacher/schedule", { weekday: 4, startTime: "16:00", endTime: "17:00", subject: "Chemistry" }, inClass(chem))).status, 201);
  assert.equal((await head.post("/api/teacher/schedule", { weekday: 8, startTime: "16:00", endTime: "17:00", subject: "x" }, inClass(phy))).status, 400);
  assert.equal((await head.post("/api/teacher/schedule", { weekday: 1, startTime: "18:00", endTime: "17:00", subject: "x" }, inClass(phy))).status, 400);
  await head.post("/api/teacher/homework", { title: "Kinematics HW", dueDate: "2026-10-09" }, inClass(phy));
  await head.post("/api/teacher/tests", { title: "Unit Test", subject: "Chemistry", maxMarks: 25, testDate: "2026-10-10" }, inClass(chem));
  assert.equal((await head.post("/api/teacher/calendar-events", { kind: "holiday", title: "Diwali", startDate: "2026-10-08", endDate: "2026-10-09", scope: "institute" })).status, 201);
  assert.equal((await head.post("/api/teacher/calendar-events", { kind: "event", title: "Science fair", startDate: "2026-10-11", startTime: "10:00", scope: "class", classIds: [phy.id] })).status, 201);
  const cal = (await s.get("/api/calendar?from=2026-10-05&to=2026-10-11")).body;
  const kinds = cal.entries.map(e => `${e.kind}:${e.title}`);
  for (const expected of ["class:Physics", "class:Chemistry", "homework:Kinematics HW", "test:Unit Test", "holiday:Diwali", "event:Science fair"]) assert.ok(kinds.includes(expected), `${expected} in ${kinds}`);
  assert.equal(cal.entries.filter(e => e.kind === "holiday").length, 2, "a 2-day holiday appears on both days");
  assert.equal(cal.entries.find(e => e.title === "Chemistry").on_holiday, true);
  assert.equal(cal.entries.find(e => e.title === "Physics").on_holiday, false);
  const oneClass = (await s.get(`/api/calendar?from=2026-10-05&to=2026-10-11&classId=${chem.id}`)).body.entries.map(e => e.title);
  assert.ok(oneClass.includes("Chemistry") && !oneClass.includes("Physics") && !oneClass.includes("Science fair"));
  const outsider = (await sOther.get("/api/calendar?from=2026-10-05&to=2026-10-11")).body.entries; assert.equal(outsider.length, 0, "another institute sees none of it");
  assert.equal((await sOther.get(`/api/calendar?from=2026-10-05&to=2026-10-11&classId=${phy.id}`)).status, 404);
  const tcal = (await head.get("/api/calendar?from=2026-10-05&to=2026-10-11")).body.entries; assert.ok(tcal.length >= 6);
  assert.equal((await other.get("/api/calendar?from=2026-10-05&to=2026-10-11")).body.entries.length, 0);
  assert.ok((await s.get("/api/notifications")).body.notifications.some(n => n.type === "holiday" && /Diwali/.test(n.title)));
  assert.equal((await s.get("/api/calendar?from=2026-10-05&to=2027-01-01")).status, 400, "range is capped");
  assert.equal((await s.get("/api/calendar?from=2026-10-09&to=2026-10-05")).status, 400);
  assert.equal((await s.get("/api/calendar?from=bad&to=2026-10-05")).status, 400);
  assert.equal((await s.get("/api/calendar")).status, 200, "default range");
  // own exams show on the student's calendar only
  await s.post("/api/student/exams", { subject: "Maths", title: "Board exam", examDate: "2026-10-11" });
  assert.ok((await s.get("/api/calendar?from=2026-10-05&to=2026-10-11")).body.entries.some(e => e.kind === "exam"));
  assert.ok(!(await sOther.get("/api/calendar?from=2026-10-05&to=2026-10-11")).body.entries.some(e => e.kind === "exam"));
  // events can be deleted by their creator only
  const evId = (await app.db.one("SELECT id FROM calendar_events WHERE title='Science fair'")).id;
  assert.equal((await other.delete(`/api/teacher/calendar-events/${evId}`)).status, 404); assert.equal((await head.delete(`/api/teacher/calendar-events/${evId}`)).status, 200);
  assert.ok(!(await s.get("/api/calendar?from=2026-10-05&to=2026-10-11")).body.entries.some(e => e.title === "Science fair"));
  assert.equal((await other.post("/api/teacher/calendar-events", { kind: "holiday", title: "x", startDate: "2026-10-08", scope: "institute" })).status, 403);
  assert.equal((await head.post("/api/teacher/calendar-events", { kind: "event", title: "x", startDate: "2026-10-09", endDate: "2026-10-08", scope: "institute" })).status, 400);
  assert.equal((await head.post("/api/teacher/calendar-events", { kind: "party", title: "x", startDate: "2026-10-09", scope: "institute" })).status, 400);
  const slot = (await app.db.one("SELECT id FROM class_schedule LIMIT 1")).id;
  assert.equal((await other.delete(`/api/teacher/schedule/${slot}`)).status, 404); assert.equal((await head.delete(`/api/teacher/schedule/${slot}`)).status, 200);
});
