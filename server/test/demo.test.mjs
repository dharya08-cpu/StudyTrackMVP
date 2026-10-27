import test from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createTestDb, Browser } from "./helpers.mjs";
import { seedDemo, DEMO_ACCOUNTS } from "../src/demo.js";

const demoApp = async (extra = {}) => { const app = await createTestApp({ env: { ALLOW_DEMO: "true" }, ...extra }); await seedDemo(app.ctx); return app; };
const as = async (app, n) => { const a = DEMO_ACCOUNTS[n]; const b = new Browser(app); const r = await b.login(a.email, a.password); assert.equal(r.status, 200, `${a.email}: ${JSON.stringify(r.body)}`); b.me = r.body.user; return b; };
const T1 = 0, T2 = 1, T3 = 2, S1 = 3, S2 = 4;

test("all 5 demo accounts exist with the given Gmail/password and sign in straight to the home page", async () => {
  const app = await demoApp();
  for (let i = 0; i < 5; i++) { const b = await as(app, i); assert.equal(b.me.profile_completed, true, "no details page for demo accounts"); assert.equal(b.me.is_demo, true); assert.equal(b.me.role, DEMO_ACCOUNTS[i].role); }
  assert.equal((await new Browser(app).login("demoteacher1@coaching.com", "demoteacher2")).body.code, "WRONG_PASSWORD");
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM users")).n, 5);
});

test("demo accounts are off unless ALLOW_DEMO=true", async () => {
  const app = await createTestApp(); await assert.rejects(seedDemo(app.ctx), e => e.code === "DEMO_OFF");
  const on = await demoApp(); on.ctx.config.allowDemo = false;
  assert.equal((await new Browser(on).login("demoteacher1@coaching.com", "demoteacher1")).body.code, "NO_ACCOUNT", "seeded accounts cannot log in once the switch is off");
});

test("structure: 6 classes DEMO01 to DEMO06, institute for teachers 1 and 2, teacher 3 independent, both students in all 6", async () => {
  const app = await demoApp();
  const classes = await app.db.many("SELECT c.code,c.name,u.email FROM classes c JOIN users u ON u.id=c.teacher_id ORDER BY c.code");
  assert.deepEqual(classes.map(c => c.code), ["DEMO01", "DEMO02", "DEMO03", "DEMO04", "DEMO05", "DEMO06"]);
  assert.deepEqual(classes.map(c => c.email), ["demoteacher1@coaching.com", "demoteacher1@coaching.com", "demoteacher2@coaching.com", "demoteacher2@coaching.com", "demoteacher3@coaching.com", "demoteacher3@coaching.com"]);
  const t1 = await as(app, T1), t2 = await as(app, T2), t3 = await as(app, T3);
  assert.equal((await t1.get("/api/me")).body.institute.my_role, "head"); assert.equal((await t2.get("/api/me")).body.institute.my_role, "teacher"); assert.equal((await t3.get("/api/me")).body.institute, null);
  const home = (await t1.get("/api/institute/home")).body; assert.equal(home.institute.status, "active"); assert.deepEqual(home.teachers.map(t => t.name), ["Anita Sharma", "Rahul Verma"]); assert.equal(home.teachers[0].class_count, 2); assert.equal(home.teachers[1].student_count, 4);
  assert.equal((await t3.get("/api/institute/home")).status, 404);
  assert.equal((await t2.get("/api/institute/home")).body.institute.code, undefined, "only the head sees the institute code");
  for (const n of [S1, S2]) { const s = await as(app, n); const cl = (await s.get("/api/student/classes")).body.classes; assert.equal(cl.length, 6); assert.ok(cl.every(c => c.available)); assert.deepEqual([...new Set(cl.map(c => c.institute_name))].sort(), [null, "Bright Future Academy (Demo)"].sort(), "classes of an institute AND of an independent teacher together"); }
});

test("EVERY FEATURE HAS LIVE DATA: student Aarav (strong, improving)", async () => {
  const app = await demoApp(); const s = await as(app, S1);
  const d = (await s.get("/api/student/dashboard")).body;
  assert.equal(d.homework.length, 24); assert.ok(d.homework.filter(h => h.status === "reviewed").length >= 12); assert.ok(d.homework.some(h => h.status === "submitted")); assert.ok(d.homework.some(h => h.status === "pending")); assert.ok(d.homework.some(h => h.has_file), "worksheets attached");
  assert.equal(d.tests.length, 24); assert.equal(d.tests.filter(t => t.marks != null).length, 18); assert.ok(d.stats.average_percentage >= 80 && d.stats.average_percentage <= 92, `avg ${d.stats.average_percentage}`);
  assert.ok(d.stats.attendance_percentage >= 85); assert.ok(d.stats.syllabus_percentage >= 40 && d.stats.syllabus_percentage < 100); assert.equal(d.stats.study_trend, "improving"); assert.ok(d.logs.length > 100); assert.equal(d.subjects.length, 6); assert.equal(d.categories.length, 3);
  const g = (await s.get("/api/student/goals")).body;
  assert.equal(g.goal.daily_minutes, 240); assert.equal(g.daily.minutes, 165); assert.equal(g.daily.percent, 69); assert.ok(g.streak >= 12, `streak ${g.streak}`); assert.equal(g.days[0].status, "met"); assert.equal(g.days[2].status, "today");
  const p = (await s.get("/api/student/planner")).body;
  assert.ok(p.suggestions.items.length >= 3 && p.suggestions.items.every(i => i.reasons.length)); assert.ok(!p.suggestions.items.some(i => i.type === "homework"), "Aarav hands homework in early"); assert.deepEqual(p.exams.filter(e => e.source === "personal").map(e => e.days_left), [5, 21]); assert.ok(p.exams.some(e => e.source === "test"));
  assert.ok(p.timetable.filter(day => day.weekday <= 6).every(day => day.items.length >= 1), "Monday to Saturday have class or study blocks"); assert.equal(p.timetable[6].items.length, 0, "Sunday is free");
  const cal = (await s.get("/api/calendar?from=2026-10-01&to=2026-11-10")).body.entries; const kinds = new Set(cal.map(e => e.kind));
  for (const k of ["class", "homework", "test", "event", "holiday", "exam"]) assert.ok(kinds.has(k), `calendar has ${k}`);
  assert.ok(cal.some(e => e.kind === "class" && e.on_holiday), "classes during the holiday are flagged");
  const ann = (await s.get("/api/student/announcements")).body.announcements; assert.equal(ann.length, 5); assert.ok(ann.some(a => a.priority === "important")); assert.ok(ann.some(a => a.scope === "institute"));
  const n = (await s.get("/api/notifications?limit=100")).body; assert.ok(n.unread >= 5 && n.notifications.length > 30); assert.ok(n.notifications.some(x => x.read_at) && n.notifications.some(x => !x.read_at));
  assert.equal((await s.get("/api/student/attendance")).body.longestStreak >= 3, true); assert.equal((await s.get("/api/student/syllabus")).body.subjects.length, 6);
  assert.ok((await s.get("/api/student/activity")).body.activity.length >= 20);
  const hw = d.homework.find(h => h.has_file); const dl = await s.get(`/api/files/homework/${hw.id}`); assert.equal(dl.status, 200); assert.match(dl.body.url, /worksheet\.pdf/);
});

test("student Diya (irregular, falling marks) looks different, and her teachers see the warning signals", async () => {
  const app = await demoApp(); const s1 = await as(app, S1), s2 = await as(app, S2), t1 = await as(app, T1);
  const a = (await s1.get("/api/student/dashboard")).body, b = (await s2.get("/api/student/dashboard")).body;
  assert.ok(b.stats.average_percentage < a.stats.average_percentage - 15, `${b.stats.average_percentage} vs ${a.stats.average_percentage}`); assert.ok(b.stats.attendance_percentage < a.stats.attendance_percentage - 15); assert.ok(b.stats.week_minutes < a.stats.week_minutes);
  assert.ok(b.homework.filter(h => h.status === "pending" || h.status === "late").length >= 12, "pending/late homework");
  const g = (await s2.get("/api/student/goals")).body; assert.equal(g.goal.daily_minutes, 180); assert.ok(g.streak < 3); assert.ok(g.days.some(d => d.status === "missed"));
  const p = (await s2.get("/api/student/planner")).body; assert.equal(p.exams[0].days_left, 3); assert.ok(p.suggestions.items.some(i => i.type === "homework" && /overdue/.test(i.reasons[0])), "Diya is nudged about overdue homework");
  const room = await t1.get("/api/teacher/overview"); assert.equal(room.status, 200);
  const sum = room.body.studentSummary; const aarav = sum.find(x => x.name === "Aarav Mehta"), diya = sum.find(x => x.name === "Diya Nair");
  assert.equal(aarav.status, "on-track"); assert.notEqual(diya.status, "on-track", `Diya is ${diya.status}`); assert.ok(room.body.metrics.pending_reviews >= 1); assert.ok(room.body.activity.length > 5);
  const an = (await t1.get(`/api/teacher/student/${diya.id}/analytics`)).body; assert.equal(an.performanceTrend, "declining"); assert.ok(an.attendancePercentage < 80); assert.equal((await t1.get(`/api/teacher/student/${aarav.id}/analytics`)).body.performanceTrend, "improving");
  const results = (await t1.get("/api/teacher/results")).body; assert.equal(results.students.length, 2); assert.equal(results.tests.length, 4);
  assert.equal((await t1.get("/api/teacher/attendance")).status, 200); assert.equal((await t1.get("/api/teacher/syllabus")).body.chapters.length, 5);
});

test("teacher features: head announces to the institute; plain teacher cannot; independent teacher is separate; join flow can be demonstrated live", async () => {
  const app = await demoApp(); const t1 = await as(app, T1), t2 = await as(app, T2), t3 = await as(app, T3);
  assert.equal((await t1.post("/api/teacher/announcements", { title: "Fee reminder", body: "Please pay by Friday.", scope: "institute" })).status, 201);
  assert.equal((await t2.post("/api/teacher/announcements", { title: "x", body: "y", scope: "institute" })).body.code, "NOT_INSTITUTE_HEAD");
  assert.equal((await t3.post("/api/teacher/announcements", { title: "x", body: "y", scope: "institute" })).status, 403);
  assert.equal((await t2.get("/api/notifications")).body.notifications.some(n => /Fee reminder/.test(n.title)), true);
  for (const t of [t1, t2, t3]) { const ctx = (await t.get("/api/teacher/context")).body; assert.equal(ctx.classes.length, 2); assert.ok(ctx.classes.every(c => c.student_count === 2)); assert.equal((await t.get("/api/teacher/schedule")).body.slots.length, 2); assert.ok((await t.get("/api/teacher/announcements")).body.announcements.length >= 1); }
  assert.ok((await t3.get("/api/calendar?from=2026-10-01&to=2026-11-10")).body.entries.some(e => e.kind === "holiday" && e.title === "Teacher training day"));
  const jr = (await t1.get("/api/teacher/join-requests")).body; assert.deepEqual([jr.pending.length, jr.blocked.length], [0, 0]);
  const s2 = await as(app, S2); const cls = (await s2.get("/api/student/classes")).body.classes.find(c => c.name === "Physics Class 11");
  assert.equal((await s2.post(`/api/student/classes/${cls.id}/leave`)).status, 200);
  assert.equal((await s2.post("/api/student/join-request", { classCode: "DEMO01" })).status, 201);
  const pending = (await t1.get("/api/teacher/join-requests")).body.pending; assert.equal(pending.length, 1); assert.equal((await t1.post(`/api/teacher/join-requests/${pending[0].id}/approve`)).status, 200);
  assert.equal((await t3.post("/api/teacher/homework", { title: "Live demo homework" })).status, 201);
});

test("demo and real accounts can never mix; demo credentials cannot be changed", async () => {
  const app = await demoApp(); const real = new Browser(app); await real.signIn({ sub: "r1", email: "real.student@gmail.com", name: "Real Student", role: "student" });
  assert.equal((await real.post("/api/student/join-request", { classCode: "DEMO01" })).status, 404, "a real student cannot join a demo class");
  const realT = new Browser(app); await realT.signIn({ sub: "r2", email: "real.teacher@gmail.com", name: "Real Teacher", role: "teacher" });
  assert.equal((await realT.post("/api/institute/join", { code: "DEMOACAD" })).status, 404, "a real teacher cannot join the demo institute");
  assert.ok((await realT.post("/api/teacher/classes", { name: "Real class", code: "REAL01" })).body.id);
  const demoS = await as(app, S1); assert.equal((await demoS.post("/api/student/join-request", { classCode: "REAL01" })).status, 404, "a demo student cannot join a real class");
  assert.equal((await demoS.post("/api/account/change-password", { currentPassword: "demostudent1", newPassword: "Hacked2026pw" })).body.code, "DEMO_LOCKED");
  assert.equal((await demoS.post("/api/account/change-email", { credential: "x".repeat(40) })).body.code, "DEMO_LOCKED");
  const t3 = await as(app, T3); assert.equal((await t3.post("/api/institute/request", { instituteName: "Fake Academy", phone: "99999 11111" })).body.code, "DEMO_LOCKED");
  const before = app.mail.sent.length; await new Browser(app).post("/api/auth/forgot-password", { email: "demostudent1@coaching.com" }); assert.equal(app.mail.sent.length, before, "no reset e-mails for demo accounts");
  assert.equal((await new Browser(app).register({ email: "demostudent1@coaching.com", password: "Sunrise2026" })).status, 400, "only Gmail can register");
});

test("reset: running it again restores the original demo and cleans up files; admin panel can do it", async () => {
  const app = await demoApp(); const bucket = () => app.storage.buckets.get("studytrack-files").size;
  const snapshot = async () => ({ files: bucket(), logs: (await app.db.one("SELECT COUNT(*) AS n FROM study_logs")).n, hw: (await app.db.one("SELECT COUNT(*) AS n FROM homework")).n });
  const before = await snapshot(); assert.equal(before.files, 6, "one worksheet per class");
  const s = await as(app, S1); await s.post("/api/student/study-log", { category: "tuition", subject: "Physics", minutes: 30, studyDate: "2026-10-07" });
  const t3 = await as(app, T3); await t3.post("/api/teacher/homework", { title: "Junk homework" });
  const admin = new Browser(app); admin.csrf = (await admin.post("/api/admin/login", { key: "owner-key-123456" })).body.csrfToken;
  assert.equal((await admin.get("/api/admin/demo")).body.accounts.length, 5);
  const r = await admin.post("/api/admin/demo/reset"); assert.equal(r.status, 201); assert.equal(r.body.users, 5);
  assert.deepEqual(await snapshot(), before, "identical to the first run");
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM users")).n, 5); assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM institutes")).n, 1);
  assert.equal((await s.get("/api/me")).status, 401, "old sessions are gone after a reset");
  const off = await createTestApp(); const a2 = new Browser(off); a2.csrf = (await a2.post("/api/admin/login", { key: "owner-key-123456" })).body.csrfToken; assert.equal((await a2.post("/api/admin/demo/reset")).body.code, "DEMO_OFF");
  assert.equal((await new Browser(app).post("/api/admin/demo/reset")).status, 401);
  const real = new Browser(app); await real.signIn({ sub: "r1", email: "real@gmail.com", name: "Real", role: "student" }); await seedDemo(app.ctx); assert.equal((await real.get("/api/me")).status, 200, "real accounts are untouched by a reset");
});

test("demo data survives backup and restore", async () => {
  const app = await demoApp(); const { createSnapshot, restoreSnapshot } = await import("../src/backup.js"); const { applyMigrations } = await import("../src/migrate.js");
  const snap = await createSnapshot(app.db, app.clock); const fresh = await createTestDb(); await applyMigrations(fresh);
  const out = await restoreSnapshot(snap.buffer, fresh, { expectedSha256: snap.sha256 }); assert.ok(out.total > 500, `restored ${out.total} rows`);
  assert.equal((await fresh.one("SELECT COUNT(*) AS n FROM users WHERE is_demo=TRUE")).n, 5);
});
