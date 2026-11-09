// V6 features: due-date reminders, parent view, student submission files, login alerts, class export.
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { createTestApp, createTestDb, Browser } from "./helpers.mjs";
import { makePdf, makePng, upload } from "./fixtures.mjs";
import { createSnapshot, restoreSnapshot } from "../src/backup.js";
import { applyMigrations } from "../src/migrate.js";
import { buildXlsx, buildCsv, crc32 } from "../src/xlsx.js";

const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const google = (app, n, role, ua) => new Browser(app, ua ? { ua } : {});
const mk = async (app, role, n, ua) => { const b = google(app, n, role, ua); const r = await b.signIn({ sub: `${role[0]}${n}`, email: `${role[0]}${n}@gmail.com`, name: `${role === "teacher" ? "Teacher" : "Student"} ${n}`, role }); assert.equal(r.status, 200, JSON.stringify(r.body)); b.id = r.body.user.id; return b; };
const mkClass = async (t, name = "Physics") => (await t.post("/api/teacher/classes", { name })).body;
const enroll = (app, s, cls) => app.db.exec("INSERT INTO student_class_memberships(student_id,class_id,status,joined_at) VALUES($1,$2,'active',$3)", [s.id, cls.id, app.clock.nowIso()]);
const pdf = name => upload(makePdf(`% ${name}`), name, "application/pdf");
const png = name => upload(makePng(), name, "image/png");
const bucket = app => app.storage.buckets.get("studytrack-files");
const titles = async s => (await s.get("/api/notifications?limit=100")).body.notifications.map(n => n.title);
const reminders = async s => (await s.get("/api/notifications?limit=100")).body.notifications.filter(n => n.type === "reminder").map(n => n.title);
const tick = () => new Promise(r => setImmediate(r));

// ---------------------------------------------------------------------------------------------------------------------
// 1. Reminders
// ---------------------------------------------------------------------------------------------------------------------
test("reminders: due tomorrow, due today and overdue, each sent once", async () => {
  const app = await createTestApp(); const t = await mk(app, "teacher", 1), s = await mk(app, "student", 1); const cls = await mkClass(t); await enroll(app, s, cls);
  const today = app.clock.today(), d = n => app.clock.shift(today, n);
  const hw = async (title, due) => (await t.post("/api/teacher/homework", { title, dueDate: due })).body.created[0].id;
  await hw("HW tomorrow", d(1)); await hw("HW today", d(0)); await hw("HW overdue", d(-2)); await hw("HW too old", d(-10)); await hw("HW far away", d(5)); await hw("HW undated", "");
  const done = await hw("HW already submitted", d(1)); assert.equal((await s.post(`/api/student/homework/${done}/submit`, { note: "ok" })).status, 200);
  assert.equal((await t.post("/api/teacher/tests", { title: "Unit 1", subject: "Physics", maxMarks: 10, testDate: d(1) })).status, 201);
  assert.equal((await s.post("/api/student/plan-items", { kind: "goal", title: "Goal tomorrow", startDate: today, endDate: d(1) })).status, 201);
  assert.equal((await s.post("/api/student/plan-items", { kind: "revision", title: "Revision overdue", startDate: d(-5), endDate: d(-1) })).status, 201);
  const finished = (await s.post("/api/student/plan-items", { kind: "task", title: "Finished task", startDate: today, endDate: d(1) })).body.item;
  await s.patch(`/api/student/plan-items/${finished.id}`, { done: true });
  assert.equal((await s.post("/api/student/exams", { subject: "Maths", title: "Maths exam", examDate: d(1) })).status, 201);

  const unread = (await s.get("/api/notifications/unread-count")).body.unread;
  const got = await reminders(s);
  assert.deepEqual(got.sort(), ["Exam tomorrow: Maths exam", "Homework due today: HW today", "Homework due tomorrow: HW tomorrow", "Homework overdue: HW overdue", "Test tomorrow: Unit 1", "Your revision plan overdue: Revision overdue", "Your study goal due tomorrow: Goal tomorrow"].sort());
  const overdue = (await s.get("/api/notifications")).body.notifications.find(n => n.title === "Homework overdue: HW overdue");
  assert.equal(overdue.priority, "important"); assert.equal(overdue.type, "reminder"); assert.match(overdue.body, /due 2026-10-05/);

  // checking again does not repeat anything, now or after the 30-minute check interval
  assert.equal((await s.get("/api/notifications/unread-count")).body.unread, unread);
  app.advance(31 * 60_000); assert.equal((await s.get("/api/notifications/unread-count")).body.unread, unread, "reminders are never repeated for the same stage");
  // the next day the same items move to the next stage and get ONE new reminder each
  app.advance(24 * 3600_000);
  const next = await reminders(s);
  assert.ok(next.includes("Homework due today: HW tomorrow")); assert.ok(next.includes("Homework overdue: HW today")); assert.ok(next.includes("Your study goal due today: Goal tomorrow"));
  assert.equal(next.filter(x => x === "Homework due today: HW tomorrow").length, 1);
  assert.ok(!next.some(x => /HW (far away|undated|too old|already submitted)|Finished task/.test(x)), "no reminders for finished, far-off, undated or old items");
  // teachers get none
  assert.equal((await reminders(t)).length, 0);
});

test("reminders: can be switched off, and are capped so a long absence cannot flood", async () => {
  const app = await createTestApp(); const t = await mk(app, "teacher", 1), s = await mk(app, "student", 1), quiet = await mk(app, "student", 2); const cls = await mkClass(t); await enroll(app, s, cls); await enroll(app, quiet, cls);
  const today = app.clock.today();
  await t.post("/api/teacher/homework", { title: "Due tomorrow", dueDate: app.clock.shift(today, 1) });
  const off = await quiet.patch("/api/account/settings", { remindersEnabled: false });
  assert.equal(off.status, 200); assert.equal(off.body.reminders_enabled, false);
  assert.equal((await reminders(quiet)).length, 0, "no reminders while switched off");
  assert.ok((await reminders(s)).some(x => /Homework due tomorrow/.test(x)));
  await quiet.patch("/api/account/settings", { remindersEnabled: true });
  app.advance(31 * 60_000);
  assert.ok((await reminders(quiet)).some(x => /Homework due tomorrow/.test(x)), "turning them back on delivers what is due");

  for (let i = 0; i < 30; i++) await s.post("/api/student/plan-items", { kind: "task", title: `Task ${i}`, startDate: today, endDate: app.clock.shift(today, 1) });
  app.advance(31 * 60_000);
  const count = (await reminders(s)).filter(x => /^Your task due tomorrow/.test(x)).length;
  assert.ok(count <= 20, `at most 20 reminders per check, got ${count}`);
  app.advance(31 * 60_000);
  assert.ok((await reminders(s)).filter(x => /^Your task due tomorrow/.test(x)).length > count, "the rest follow on the next check");
});

test("settings: validated, per account", async () => {
  const app = await createTestApp(); const s = await mk(app, "student", 1);
  assert.deepEqual(Object.keys((await s.get("/api/account/settings")).body).sort(), ["email_alerts_available", "login_alerts_enabled", "reminders_enabled", "role"]);
  assert.equal((await s.patch("/api/account/settings", { remindersEnabled: "no" })).status, 400);
  assert.equal((await s.patch("/api/account/settings", { loginAlertsEnabled: false })).body.login_alerts_enabled, false);
  assert.equal((await app.request({ method: "GET", url: "/api/account/settings" })).status, 401);
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Parent view
// ---------------------------------------------------------------------------------------------------------------------
test("parent view: the student shares a read-only weekly summary through a secret link", async () => {
  const app = await createTestApp(); const t = await mk(app, "teacher", 1), s = await mk(app, "student", 1), other = await mk(app, "student", 2); const cls = await mkClass(t); await enroll(app, s, cls);
  const today = app.clock.today();
  await app.db.exec("UPDATE users SET first_name='Aarav',parent_name='Rajesh Mehta',parent_phone='+91 99999 11111',phone='+91 88888 22222' WHERE id=$1", [s.id]);
  await s.post("/api/student/study-log", { category: "self-study", subject: "Physics", minutes: 90, studyDate: today });
  await s.put("/api/student/goals", { dailyMinutes: 60, weeklyMinutes: 300 });
  await t.post("/api/teacher/homework", { title: "Pending sheet", dueDate: app.clock.shift(today, 2) });
  await s.post("/api/student/plan-items", { kind: "goal", title: "PRIVATE-GOAL-TITLE", startDate: today, endDate: today, notes: "PRIVATE-NOTE" });
  const test = (await t.post("/api/teacher/tests", { title: "Unit 1", subject: "Physics", maxMarks: 50, testDate: app.clock.shift(today, -2) })).body.id;
  assert.equal((await t.post("/api/teacher/marks", { testId: test, studentId: s.id, marks: 40, remark: "PRIVATE-REMARK" })).status, 200);

  assert.equal((await s.get("/api/student/parent-link")).body.link.active, false);
  const made = await s.post("/api/student/parent-link", {});
  assert.equal(made.status, 201); assert.match(made.body.token, /^[A-Za-z0-9_-]{43}$/); assert.equal(made.body.path, `/parent#${made.body.token}`);
  const row = await app.db.one("SELECT token_hash FROM parent_links"); assert.ok(!JSON.stringify(row).includes(made.body.token), "only a hash is stored");
  const status = (await s.get("/api/student/parent-link")).body; assert.equal(status.link.active, true); assert.ok(!JSON.stringify(status).includes(made.body.token), "the secret is shown once only");

  const anon = new Browser(app); // not signed in
  const seen = await anon.post("/api/parent/view", { token: made.body.token });
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  const sm = seen.body.summary;
  assert.equal(sm.student.first_name, "Aarav"); assert.equal(sm.student.parent_name, "Rajesh Mehta"); assert.deepEqual(sm.student.classes, ["Physics"]);
  assert.equal(sm.study.week_minutes, 90); assert.equal(sm.study.today_minutes, 90); assert.deepEqual(sm.study.goal, { daily_minutes: 60, weekly_minutes: 300 });
  assert.equal(sm.homework.open, 1); assert.equal(sm.homework.pending[0].title, "Pending sheet");
  assert.equal(sm.tests.recent[0].percentage, 80); assert.equal(sm.tests.average, 80);
  assert.equal(sm.own_goals.open, 1);
  assert.ok(sm.upcoming.some(u => u.title === "Pending sheet" && u.kind === "homework"));
  const text = JSON.stringify(seen.body);
  for (const secret of ["PRIVATE-GOAL-TITLE", "PRIVATE-NOTE", "PRIVATE-REMARK", "s1@gmail.com", "99999", "88888", "password", "DEMO"]) assert.ok(!text.includes(secret), `the parent view must not contain ${secret}`);
  assert.equal((await app.db.one("SELECT view_count FROM parent_links")).view_count, 1);
  assert.equal((await s.get("/api/student/parent-link/preview")).body.summary.study.week_minutes, 90, "the student can preview exactly what is shared");
  assert.equal((await other.get("/api/student/parent-link")).body.link.active, false, "another student has no link");
  assert.equal((await t.get("/api/student/parent-link")).status, 403);

  // a new link cancels the old one; cancelling stops it at once
  const second = (await s.post("/api/student/parent-link", {})).body;
  assert.equal((await anon.post("/api/parent/view", { token: made.body.token })).status, 404, "the old link no longer works");
  assert.equal((await anon.post("/api/parent/view", { token: second.token })).status, 200);
  assert.equal((await s.delete("/api/student/parent-link")).status, 200);
  assert.equal((await anon.post("/api/parent/view", { token: second.token })).status, 404);
  assert.equal((await s.get("/api/student/parent-link")).body.link.active, false);
});

test("parent view: bad, guessed, expired and abused links all get the same answer", async () => {
  const app = await createTestApp({ limits: { parentView: 14 } }); const s = await mk(app, "student", 1); const anon = new Browser(app);
  const token = (await s.post("/api/student/parent-link", {})).body.token;
  const same = [];
  for (const bad of [undefined, "", "short", "a".repeat(43), "!".repeat(43), "a".repeat(44), { $ne: 1 }, ["x"], token.slice(0, 42) + (token.endsWith("A") ? "B" : "A")]) { const r = await anon.post("/api/parent/view", { token: bad }); assert.equal(r.status, 404, JSON.stringify(bad)); same.push(JSON.stringify(r.body)); }
  assert.equal(new Set(same).size, 1, "every kind of failure gives the identical answer");
  app.advance(91 * 86400000);
  assert.equal((await anon.post("/api/parent/view", { token })).status, 404, "links expire after 90 days");
  let last = 0; for (let i = 0; i < 16; i++) last = (await anon.post("/api/parent/view", { token: "b".repeat(43) })).status;
  assert.equal(last, 429, "guessing is rate limited");
  assert.equal((await new Browser(app, { ip: "198.51.100.9" }).post("/api/parent/view", { token: "b".repeat(43) })).status, 404, "per network: another network is not locked out");
});

test("parent view: a banned or deleted student's link stops working", async () => {
  const app = await createTestApp(); const s = await mk(app, "student", 1); const anon = new Browser(app);
  const token = (await s.post("/api/student/parent-link", {})).body.token;
  await app.db.exec("UPDATE users SET banned=TRUE WHERE id=$1", [s.id]);
  assert.equal((await anon.post("/api/parent/view", { token })).status, 404);
  await app.db.exec("UPDATE users SET banned=FALSE WHERE id=$1", [s.id]);
  assert.equal((await anon.post("/api/parent/view", { token })).status, 200);
  await app.db.exec("DELETE FROM users WHERE id=$1", [s.id]);
  assert.equal((await anon.post("/api/parent/view", { token })).status, 404);
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM parent_links")).n, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Student submission files
// ---------------------------------------------------------------------------------------------------------------------
async function homeworkSetup(app) {
  const t = await mk(app, "teacher", 1), s = await mk(app, "student", 1), other = await mk(app, "student", 2), t2 = await mk(app, "teacher", 2);
  const cls = await mkClass(t); await enroll(app, s, cls); await mkClass(t2, "Other");
  const hw = (await t.post("/api/teacher/homework", { title: "Essay", dueDate: app.clock.shift(app.clock.today(), 3) })).body.created[0].id;
  return { t, t2, s, other, cls, hw };
}

test("submission files: submit first, then attach up to 5 files; the teacher can open each one", async () => {
  const app = await createTestApp(); const { t, t2, s, other, hw } = await homeworkSetup(app);
  const early = await s.post(`/api/student/homework/${hw}/files`, {}, { file: pdf("early.pdf") });
  assert.equal(early.status, 409); assert.equal(early.body.code, "SUBMIT_FIRST");
  assert.equal((await s.post(`/api/student/homework/${hw}/submit`, { note: "Done" })).status, 200);
  const names = ["page1.pdf", "page2.png", "page3.pdf", "page4.png", "page5.pdf"];
  for (const n of names) assert.equal((await s.post(`/api/student/homework/${hw}/files`, {}, { file: n.endsWith(".png") ? png(n) : pdf(n) })).status, 201, n);
  const over = await s.post(`/api/student/homework/${hw}/files`, {}, { file: pdf("six.pdf") });
  assert.equal(over.status, 400); assert.equal(over.body.code, "TOO_MANY_FILES");
  assert.equal((await s.post(`/api/student/homework/${hw}/files`, {}, { file: upload(Buffer.from("MZ"), "evil.pdf", "application/pdf") })).status, 415);
  assert.equal(bucket(app).size, 5, "the refused files were not stored");

  const mine = (await s.get("/api/student/dashboard")).body.homework.find(h => h.id === hw);
  assert.deepEqual(mine.my_files.map(f => f.name), names); assert.ok(mine.my_files.every(f => f.id && f.size > 0 && !("file_path" in f)));
  const seen = (await t.get(`/api/teacher/homework/${hw}/submissions`)).body.submissions.find(x => x.student.id === s.id);
  assert.deepEqual(seen.files.map(f => f.name), names, "the teacher sees every file the student uploaded");
  for (const f of seen.files) { const r = await t.get(`/api/submission-files/${f.id}`); assert.equal(r.status, 200, f.name); assert.equal(r.body.fileName, f.name); }
  assert.match((await t.get(`/api/submission-files/${seen.files[0].id}?disposition=attachment`)).body.url, /dl=page1\.pdf/);
  assert.equal((await s.get(`/api/submission-files/${seen.files[0].id}`)).status, 200, "the student can open their own file");
  // nobody else can
  for (const [who, name] of [[other, "another student"], [t2, "another teacher"]]) assert.equal((await who.get(`/api/submission-files/${seen.files[0].id}`)).status, 404, name);
  assert.equal((await app.request({ method: "GET", url: `/api/submission-files/${seen.files[0].id}` })).status, 401);
  assert.equal((await t.get(`/api/teacher/student/${s.id}/homework`)).body.homework.find(h => h.id === hw).my_files.length, 5);
});

test("submission files: students can remove their own files until the teacher reviews; then it is locked", async () => {
  const app = await createTestApp(); const { t, s, other, hw } = await homeworkSetup(app);
  await s.post(`/api/student/homework/${hw}/submit`, { note: "x" });
  const id = (await s.post(`/api/student/homework/${hw}/files`, {}, { file: pdf("mine.pdf") })).body.file.id;
  assert.equal((await other.delete(`/api/student/submission-files/${id}`)).status, 404, "not someone else's");
  assert.equal((await t.delete(`/api/student/submission-files/${id}`)).status, 403, "teachers use their own review tools");
  assert.equal((await s.delete(`/api/student/submission-files/${id}`)).status, 200); assert.equal(bucket(app).size, 0, "the stored file is deleted too");
  const keep = (await s.post(`/api/student/homework/${hw}/files`, {}, { file: pdf("keep.pdf") })).body.file.id;
  assert.equal((await t.post(`/api/teacher/homework/${hw}/review`, { studentId: s.id, feedback: "Good", status: "reviewed" })).status, 200);
  const locked = await s.post(`/api/student/homework/${hw}/files`, {}, { file: pdf("late.pdf") }); assert.equal(locked.status, 409); assert.equal(locked.body.code, "ALREADY_REVIEWED");
  assert.equal((await s.delete(`/api/student/submission-files/${keep}`)).status, 409);
  assert.equal((await s.get(`/api/submission-files/${keep}`)).status, 200, "reviewed work stays viewable");
});

test("submission files: students outside the class cannot upload; deleting homework, or the student, removes the files", async () => {
  const app = await createTestApp(); const { t, s, other, hw } = await homeworkSetup(app);
  await s.post(`/api/student/homework/${hw}/submit`, {});
  assert.equal((await other.post(`/api/student/homework/${hw}/files`, {}, { file: pdf("x.pdf") })).status, 404, "not in the class");
  assert.equal((await t.post(`/api/student/homework/${hw}/files`, {}, { file: pdf("x.pdf") })).status, 403);
  await s.post(`/api/student/homework/${hw}/files`, {}, { file: pdf("a.pdf") }); await s.post(`/api/student/homework/${hw}/files`, {}, { file: pdf("b.pdf") });
  assert.equal(bucket(app).size, 2);
  const mine = await s.get("/api/account/export"); assert.deepEqual(mine.body.homework_files_uploaded.map(f => f.file_name), ["a.pdf", "b.pdf"]);
  assert.equal((await s.call("DELETE", "/api/account", { confirm: "DELETE" })).status, 200);
  assert.equal(bucket(app).size, 0, "deleting the student removes their uploaded files from storage");
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM submission_files")).n, 0);

  const a = await mk(app, "student", 5); await enroll(app, a, { id: (await app.db.one("SELECT id FROM classes LIMIT 1")).id });
  await a.post(`/api/student/homework/${hw}/submit`, {}); await a.post(`/api/student/homework/${hw}/files`, {}, { file: pdf("c.pdf") });
  assert.equal(bucket(app).size, 1);
  assert.equal((await t.delete(`/api/teacher/homework/${hw}`)).status, 200);
  assert.equal(bucket(app).size, 0, "deleting the homework removes the students' files as well");
});

test("submission files count towards the institute's storage limit", async () => {
  const app = await createTestApp(); const { t, s, hw } = await homeworkSetup(app);
  const inst = (await t.post("/api/institute/request", { instituteName: "Quota Academy", phone: "98765 43210" })).body.institute;
  await app.db.exec("UPDATE institutes SET status='active',storage_limit_mb=1 WHERE id=$1", [inst.id]);
  await s.post(`/api/student/homework/${hw}/submit`, {});
  const big = name => upload(makePdf(" ".repeat(400 * 1024)), name, "application/pdf");
  assert.equal((await s.post(`/api/student/homework/${hw}/files`, {}, { file: big("a.pdf") })).status, 201);
  assert.equal((await s.post(`/api/student/homework/${hw}/files`, {}, { file: big("b.pdf") })).status, 201);
  const r = await s.post(`/api/student/homework/${hw}/files`, {}, { file: big("c.pdf") });
  assert.equal(r.status, 413); assert.equal(r.body.code, "STORAGE_LIMIT");
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. Login alerts
// ---------------------------------------------------------------------------------------------------------------------
const signInAgain = (app, n, role, ua) => { const b = new Browser(app, { ua }); return b.signIn({ sub: `${role[0]}${n}`, email: `${role[0]}${n}@gmail.com`, name: "x", role }); };
const securityNotes = async b => (await b.get("/api/notifications?limit=50")).body.notifications.filter(n => n.type === "security");

test("login alerts: a sign-in from a new kind of device alerts in the app and by e-mail; known devices do not", async () => {
  const app = await createTestApp(); const s = await mk(app, "student", 1); // first device: Chrome on Android
  assert.equal((await securityNotes(s)).length, 0, "the very first sign-in never alerts");
  app.mail.sent.length = 0;
  assert.equal((await signInAgain(app, 1, "student", WINDOWS)).status, 200); await tick();
  const notes = await securityNotes(s);
  assert.equal(notes.length, 1); assert.equal(notes[0].title, "New sign-in on Chrome on Windows"); assert.equal(notes[0].priority, "important"); assert.match(notes[0].body, /log out of all other devices/i);
  assert.equal(app.mail.sent.length, 1, "and an e-mail");
  const mail = app.mail.sent[0]; assert.equal(mail.to, "s1@gmail.com"); assert.match(mail.subject, /New sign-in/); assert.match(mail.text, /Chrome on Windows/);
  assert.ok(!/token|password=|secret/i.test(mail.text), "the e-mail carries no link that logs anyone in");
  // the same two devices again: nothing new
  await signInAgain(app, 1, "student", WINDOWS); await new Browser(app).signIn({ sub: "s1", email: "s1@gmail.com", name: "x", role: "student" }); await tick();
  assert.equal((await securityNotes(s)).length, 1); assert.equal(app.mail.sent.length, 1);
  // a third kind of device (an iPhone) alerts in the app, but the e-mail is held back by the 10-minute cool-down
  await signInAgain(app, 1, "student", IPHONE); await tick();
  assert.equal((await securityNotes(s)).length, 2); assert.equal(app.mail.sent.length, 1, "at most one alert e-mail every 10 minutes");
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM known_devices")).n, 3);
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM security_events WHERE type='login_alert'")).n, 2);
  const stored = JSON.stringify(await app.db.many("SELECT * FROM known_devices")); assert.ok(!/203\.0\.113|Mozilla/.test(stored), "no IP address or full browser string is kept in the device list");
});

test("login alerts: can be switched off; password sign-ins alert too; a broken mailer never blocks signing in", async () => {
  const app = await createTestApp(); const s = await mk(app, "student", 1);
  await s.patch("/api/account/settings", { loginAlertsEnabled: false });
  await signInAgain(app, 1, "student", WINDOWS); await tick();
  assert.equal((await securityNotes(s)).length, 0, "switched off");
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM known_devices")).n, 2, "the device is still remembered");
  await s.patch("/api/account/settings", { loginAlertsEnabled: true });
  app.mail.failNext = true;
  const r = await signInAgain(app, 1, "student", IPHONE); await tick();
  assert.equal(r.status, 200, "a failing mail service does not stop the sign-in"); assert.equal((await securityNotes(s)).length, 1, "the in-app alert still appears");

  const pw = new Browser(app); await pw.register({ email: "pw@gmail.com", password: "Sunrise2026" }); await pw.openMailLink(); // first device
  app.mail.sent.length = 0;
  assert.equal((await new Browser(app, { ua: WINDOWS }).login("pw@gmail.com", "Sunrise2026")).status, 200); await tick();
  assert.equal(app.mail.sent.length, 1); assert.match(app.mail.sent[0].subject, /New sign-in/);
});

test("login alerts: accounts that existed before the upgrade learn their first device quietly; demo accounts never alert", async () => {
  const app = await createTestApp(); const s = await mk(app, "student", 1);
  await app.db.exec("DELETE FROM known_devices"); // an account from before V6 has no device list yet
  assert.equal((await signInAgain(app, 1, "student", WINDOWS)).status, 200); await tick();
  assert.equal((await securityNotes(s)).length, 0, "no alert storm on upgrade"); assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM known_devices")).n, 1);
  await app.db.exec("UPDATE users SET is_demo=TRUE WHERE id=$1", [s.id]);
  await signInAgain(app, 1, "student", IPHONE); await tick();
  assert.equal((await securityNotes(s)).length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. Class export
// ---------------------------------------------------------------------------------------------------------------------
function readZip(buffer) { // tiny zip reader for the test: central directory + inflate
  const out = {}; let eocd = buffer.length - 22; assert.equal(buffer.readUInt32LE(eocd), 0x06054b50, "end of central directory");
  const entries = buffer.readUInt16LE(eocd + 10); let p = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < entries; i++) {
    assert.equal(buffer.readUInt32LE(p), 0x02014b50);
    const csize = buffer.readUInt32LE(p + 20), usize = buffer.readUInt32LE(p + 24), nl = buffer.readUInt16LE(p + 28), xl = buffer.readUInt16LE(p + 30), cl = buffer.readUInt16LE(p + 32), lo = buffer.readUInt32LE(p + 42), crc = buffer.readUInt32LE(p + 16);
    const name = buffer.subarray(p + 46, p + 46 + nl).toString(); const dataStart = lo + 30 + buffer.readUInt16LE(lo + 26) + buffer.readUInt16LE(lo + 28);
    const data = zlib.inflateRawSync(buffer.subarray(dataStart, dataStart + csize)); assert.equal(data.length, usize); assert.equal(crc32(data), crc, `crc of ${name}`);
    out[name] = data.toString("utf8"); p += 46 + nl + xl + cl;
  }
  return out;
}

async function exportSetup(app) {
  const t = await mk(app, "teacher", 1), t2 = await mk(app, "teacher", 2), a = await mk(app, "student", 1), b = await mk(app, "student", 2);
  const cls = await mkClass(t, "Physics 11"); await enroll(app, a, cls); await enroll(app, b, cls);
  await app.db.exec("UPDATE users SET name=$1 WHERE id=$2", ["=HYPERLINK(\"http://evil.example\",\"click\")", b.id]);
  await app.db.exec("UPDATE users SET name='Aarav Mehta',grade='Class 11',phone='+91 90000 11111',parent_phone='+91 90000 22222' WHERE id=$1", [a.id]);
  const today = app.clock.today();
  const t1 = (await t.post("/api/teacher/tests", { title: "Unit 1", subject: "Physics", maxMarks: 50, testDate: app.clock.shift(today, -5) })).body.id;
  await t.post("/api/teacher/marks", { testId: t1, studentId: a.id, marks: 40 }); await t.post("/api/teacher/marks", { testId: t1, studentId: b.id, marks: 25 });
  await t.post("/api/teacher/tests", { title: "Unit 2", subject: "Physics", maxMarks: 100, testDate: today });
  const hw = (await t.post("/api/teacher/homework", { title: "Sheet 1", dueDate: app.clock.shift(today, -2) })).body.created[0].id; await a.post(`/api/student/homework/${hw}/submit`, {});
  for (const [d, sa, sb] of [[-3, "present", "absent"], [-2, "present", "present"]]) await t.post("/api/teacher/attendance", { date: app.clock.shift(today, d), records: [{ studentId: a.id, status: sa }, { studentId: b.id, status: sb }] });
  await a.post("/api/student/study-log", { category: "self-study", subject: "Physics", minutes: 45, studyDate: today });
  return { t, t2, a, b, cls };
}

test("export: a teacher downloads the class as one Excel workbook; it opens, has the right numbers and no private data", async () => {
  const app = await createTestApp(); const { t } = await exportSetup(app);
  const r = await t.get("/api/teacher/export");
  assert.equal(r.status, 200, r.error?.message || JSON.stringify(r.body).slice(0, 200)); assert.ok(Buffer.isBuffer(r.body));
  assert.match(r.headers["content-type"], /spreadsheetml\.sheet$/); assert.match(r.headers["content-disposition"], /^attachment; filename="StudyTrack-Physics-11-2026-10-07\.xlsx"$/);
  const files = readZip(r.body);
  assert.deepEqual(Object.keys(files).filter(n => n.startsWith("xl/worksheets/")).length, 5);
  const wb = files["xl/workbook.xml"]; for (const name of ["Summary", "Results", "Attendance", "Homework", "About"]) assert.ok(wb.includes(`name="${name}"`), name);
  const [summary, results, attendance, homework] = [1, 2, 3, 4].map(i => files[`xl/worksheets/sheet${i}.xml`]);
  assert.match(summary, /Aarav Mehta/); assert.match(summary, /Class 11/);
  assert.match(results, /Unit 1 \(Physics, out of 50, 2026-10-02\)/); assert.match(results, /<v>40<\/v>/); assert.match(results, /<v>25<\/v>/); assert.match(results, /<v>80<\/v>/, "Aarav's average is 80%");
  assert.match(attendance, />P</); assert.match(attendance, />A</); assert.match(attendance, /2026-10-04/);
  assert.match(homework, /Submitted/); assert.match(homework, /Missing/, "the other student never submitted and it is past due");
  const all = Object.values(files).join("");
  for (const private_ of ["s1@gmail.com", "s2@gmail.com", "90000", "<f>", "<f "]) assert.ok(!all.includes(private_), `the workbook must not contain ${private_}`);
  assert.ok(all.includes("=HYPERLINK") && /t="inlineStr"[^>]*><is><t[^>]*>=HYPERLINK/.test(all), "a formula-looking name is stored as text, never as a formula");
});

test("export: CSV of one sheet, with the formula-injection guard", async () => {
  const app = await createTestApp(); const { t } = await exportSetup(app);
  const r = await t.get("/api/teacher/export?format=csv&sheet=results");
  assert.equal(r.status, 200); assert.match(r.headers["content-type"], /^text\/csv; charset=utf-8/); assert.match(r.headers["content-disposition"], /StudyTrack-Physics-11-2026-10-07-results\.csv/);
  const csv = r.body.toString("utf8"); assert.ok(csv.startsWith("\uFEFFStudent,"), "BOM so Excel reads UTF-8");
  const lines = csv.trim().split("\r\n"); assert.equal(lines.length, 3);
  assert.ok(lines.some(l => l.startsWith("Aarav Mehta,40,") && l.endsWith(",80")));
  assert.ok(lines.some(l => l.startsWith(`"'=HYPERLINK(`)), "a leading = is neutralised");
  assert.ok(!lines.some(l => /^=/.test(l) || /^"=/.test(l)));
  for (const sheet of ["summary", "attendance", "homework"]) assert.equal((await t.get(`/api/teacher/export?format=csv&sheet=${sheet}`)).status, 200, sheet);
});

test("export: only your own class, only teachers, validated input", async () => {
  const app = await createTestApp(); const { t, t2, a, cls } = await exportSetup(app);
  assert.equal((await a.get("/api/teacher/export")).status, 403, "students cannot export");
  assert.equal((await app.request({ method: "GET", url: "/api/teacher/export" })).status, 401);
  assert.equal((await t2.call("GET", "/api/teacher/export", undefined, { headers: { "x-class-id": String(cls.id) } })).status, 404, "another teacher's class looks like it does not exist");
  assert.equal((await t2.get("/api/teacher/export")).status, 400, "a teacher with no class is told to make one");
  for (const q of ["format=pdf", "format=csv&sheet=users", "from=nope", "from=2026-10-10&to=2026-10-01", "from=2020-01-01&to=2026-01-01"]) assert.equal((await t.get(`/api/teacher/export?${q}`)).status, 400, q);
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM security_events WHERE type='class_export'")).n, 0, "refused requests are not logged as exports");
  await t.get("/api/teacher/export"); assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM security_events WHERE type='class_export'")).n, 1);
  const narrow = readZip((await t.get("/api/teacher/export?from=2026-10-05&to=2026-10-07")).body)["xl/worksheets/sheet3.xml"];
  assert.ok(narrow.includes("2026-10-05") && !narrow.includes("2026-10-04"), "the date range limits the attendance columns");
});

test("export writer: hostile text, long text and duplicate sheet names still make a valid workbook", () => {
  const book = buildXlsx([{ name: "A/B:C*?[]", rows: [["Name"], ["x\u0001y\u0008z"], ["lone \uD800 surrogate"], ["x".repeat(40000)], ["<>&\"'"]] }, { name: "a/b:c*?[]", rows: [["dup"]] }]);
  const files = readZip(book);
  const names = [...files["xl/workbook.xml"].matchAll(/sheet name="([^"]+)"/g)].map(m => m[1]); assert.equal(new Set(names.map(n => n.toLowerCase())).size, 2);
  const sheet = files["xl/worksheets/sheet1.xml"]; assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(sheet)); assert.ok(sheet.includes("xyz")); assert.ok(sheet.includes("&lt;&gt;&amp;&quot;'"));
  assert.ok(!sheet.includes("x".repeat(32001)), "cells are capped below Excel's 32,767 character limit");
  assert.equal(buildCsv([["a", "b,c", 'say "hi"', "+1", "-2x", "@x", 5, null]]).toString("utf8"), '\uFEFFa,"b,c","say ""hi""",\'+1,\'-2x,\'@x,5,\r\n');
});

// ---------------------------------------------------------------------------------------------------------------------
test("backups carry the new tables through a restore", async () => {
  const app = await createTestApp(); const { t, s, hw } = await homeworkSetup(app);
  await s.post(`/api/student/homework/${hw}/submit`, {}); await s.post(`/api/student/homework/${hw}/files`, {}, { file: pdf("a.pdf") });
  await s.post("/api/student/parent-link", {}); await app.advance(31 * 60_000); await s.get("/api/notifications/unread-count");
  const snap = await createSnapshot(app.db, app.clock);
  for (const table of ["submission_files", "parent_links", "known_devices"]) assert.ok(snap.rowCounts[table] >= 1, table);
  const fresh = await createTestDb(); await applyMigrations(fresh);
  await restoreSnapshot(snap.buffer, fresh, { expectedSha256: snap.sha256 });
  for (const table of ["submission_files", "parent_links", "known_devices"]) assert.equal((await fresh.one(`SELECT COUNT(*) AS n FROM ${table}`)).n, snap.rowCounts[table], table);
});
