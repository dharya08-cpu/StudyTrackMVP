// SCALE AND ISOLATION: a hundred-plus people (teachers and students, in different coaching institutes and classes, on
// different devices, many behind the same wifi) all working AT THE SAME TIME, and proof that nothing is mixed up.
//
// Everything a person creates carries a marker naming its owner (HW#c5#1 = homework of class 5, STUDY#s12 = study log of
// student 12). Afterwards every person's complete view of the app is scanned: any marker, name or e-mail that belongs to
// somebody else is a leak and fails the test. Then people try to reach each other's data directly, and the database is
// checked for lost, duplicated or orphaned records.
import test from "node:test";
import assert from "node:assert/strict";
import { createTestApp, Browser } from "./helpers.mjs";
import { makePdf, makeJpeg, upload } from "./fixtures.mjs";
import { createUploadGate } from "../src/upload-gate.js";

const N_TEACHERS = 12, N_STUDENTS = 112, N_PASSWORD_STUDENTS = 10; // the last 10 students use a password, the rest Google
const PW = "Sunrise2026";
const UAS = [
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (Android 13; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0",
  "Mozilla/5.0 (Linux; Android 12; SM-A525F) AppleWebKit/537.36 Chrome/125.0 Mobile Safari/537.36",
];

// ---- every request is timed and counted, so the run can be summarised and checked for errors ----
const stats = [];
class Device extends Browser {
  async call(method, url, body, extra) { const t0 = performance.now(); const r = await super.call(method, url, body, extra); stats.push({ ms: performance.now() - t0, status: r.status, method, url: url.split("?")[0] }); return r; }
}
const ok = (r, what) => { assert.ok(r.status >= 200 && r.status < 300, `${what}: expected success, got ${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`); return r; };
const jitter = () => new Promise(r => setImmediate(r));
const pdf = (marker, name) => upload(makePdf(`/Marker (${marker})`), name, "application/pdf");
const jpg = (marker, name) => upload(makeJpeg({ comment: marker }), name, "image/jpeg");

// ---- the world: who exists, who is in which class ----
async function buildWorld(app) {
  const today = app.clock.today(), shift = n => app.clock.shift(today, n);
  const world = { app, today, shift, teachers: [], students: [], classes: [] };

  // Teachers: 4 in coaching institute A, 3 in institute B, 5 independent. One device and one IP each.
  for (let i = 0; i < N_TEACHERS; i++) {
    const dev = new Device(app, { ip: `198.51.100.${10 + i}`, ua: UAS[i % UAS.length] });
    const r = ok(await dev.signIn({ sub: `t${i}`, email: `zt${i}t@gmail.com`, name: `Tutor ZT${i}T`, role: "teacher" }), `teacher ${i} sign in`);
    world.teachers.push({ idx: i, dev, id: r.body.user.id, classes: [], inst: i < 4 ? "A" : i >= 6 && i < 9 ? "B" : null });
  }
  for (const [name, headIdx, members] of [["Alpha Coaching", 0, [1, 2, 3]], ["Bright Tuition", 6, [7, 8]]]) {
    const head = world.teachers[headIdx];
    const inst = ok(await head.dev.post("/api/institute/request", { instituteName: name, phone: "98765 43210" }), `institute ${name}`).body.institute;
    await app.db.exec("UPDATE institutes SET status='active',storage_limit_mb=500 WHERE id=$1", [inst.id]);
    for (const m of members) await app.db.exec("UPDATE users SET institute_id=$1,institute_role='teacher' WHERE id=$2", [inst.id, world.teachers[m].id]);
  }
  // Classes: one per teacher, and every third teacher also has a second.
  let k = 0;
  for (const t of world.teachers) for (let n = 0; n < (t.idx % 3 === 0 ? 2 : 1); n++) {
    const c = ok(await t.dev.post("/api/teacher/classes", { name: `Class ZC${k}C ${["Physics", "Maths", "Chemistry", "Biology"][k % 4]}` }), `class ${k}`).body;
    const cls = { k, id: c.id, code: c.code, teacher: t, students: [] };
    t.classes.push(cls); world.classes.push(cls); k++;
  }
  // Students: ~40 share ONE public IP (a coaching centre's wifi); the others have their own. Mixed devices.
  for (let i = 0; i < N_STUDENTS; i++) {
    const ip = i < 40 ? "203.0.113.77" : `192.0.2.${(i % 200) + 1}`;
    world.students.push({ idx: i, ip, ua: UAS[(i * 7) % UAS.length], password: i >= N_STUDENTS - N_PASSWORD_STUDENTS, classes: new Set(), email: `zq${i}q@gmail.com` });
  }
  return world;
}

async function signInStudents(world) {
  const { app } = world;
  // Password accounts are registered one after another (the test mailbox is shared), then everyone signs in at once.
  for (const s of world.students.filter(x => x.password)) {
    const d = new Device(app, { ip: s.ip, ua: s.ua });
    ok(await d.register({ email: s.email, password: PW }), `register ${s.idx}`); ok(await d.openMailLink(), `verify ${s.idx}`);
    await app.db.exec("UPDATE users SET name=$1 WHERE email=$2", [`Pupil ZQ${s.idx}Q`, s.email]);
  }
  await Promise.all(world.students.map(async s => {
    s.dev = new Device(app, { ip: s.ip, ua: s.ua });
    const r = s.password ? await s.dev.login(s.email, PW) : await s.dev.signIn({ sub: `s${s.idx}`, email: s.email, name: `Pupil ZQ${s.idx}Q`, role: "student" });
    ok(r, `student ${s.idx} sign in`); s.id = r.body.user.id;
  }));
}

function enroll(world) {
  const { classes, students, app } = world, rows = [];
  students.forEach((s, i) => {
    if (i % 23 === 22) return;                                   // a few students are in no class at all
    const first = classes[i % classes.length]; s.classes.add(first.k);
    if (i % 7 === 0) { const second = classes[(i * 5 + 3) % classes.length]; if (second.teacher !== first.teacher) s.classes.add(second.k); } // some are in two teachers' classes
  });
  for (const s of students) for (const k of s.classes) { classes[k].students.push(s); rows.push([s.id, classes[k].id]); }
  return Promise.all(rows.map(([sid, cid]) => app.db.exec("INSERT INTO student_class_memberships(student_id,class_id,status,joined_at) VALUES($1,$2,'active',$3)", [sid, cid, app.clock.nowIso()])));
}

// ---- what everybody does ----
async function teacherWork(world, T) {
  const { shift } = world;
  for (const c of T.classes) {
    const H = { headers: { "x-class-id": String(c.id) } }, k = c.k;
    ok(await T.dev.post("/api/teacher/homework", { title: `HW#c${k}#1`, description: `HW#c${k}#1 instructions`, dueDate: shift(2) }, { ...H, files: [pdf(`FILE-c${k}-hw1`, `FILE-c${k}-hw1.pdf`), jpg(`FILE-c${k}-hw1`, `FILE-c${k}-hw1.jpg`)] }), `homework c${k}`);
    const test = ok(await T.dev.post("/api/teacher/tests", { title: `TEST#c${k}#1`, subject: "Physics", maxMarks: 100, testDate: shift(-1) }, { ...H, files: [pdf(`FILE-c${k}-test1`, `FILE-c${k}-test1.pdf`)] }), `test c${k}`).body;
    ok(await T.dev.post("/api/teacher/announcements", { title: `ANN#c${k}`, body: `ANN#c${k} body`, scope: "class", classIds: [c.id] }, H), `announcement c${k}`);
    ok(await T.dev.post("/api/teacher/calendar-events", { kind: "event", title: `EVT#c${k}`, startDate: world.today, scope: "class", classIds: [c.id] }, H), `event c${k}`);
    await Promise.all(c.students.map(async s => { await jitter(); ok(await T.dev.post("/api/teacher/marks", { testId: test.id, studentId: s.id, marks: 40 + (s.idx * 3) % 60, remark: `REM#c${k}` }, H), `marks c${k} s${s.idx}`); }));
    for (let d = 0; d < 3; d++) ok(await T.dev.post("/api/teacher/attendance", { date: shift(-d), records: c.students.map(s => ({ studentId: s.id, status: (s.idx + d) % 4 ? "present" : "absent" })) }, H), `attendance c${k}`);
  }
}
async function studentPlanning(world, s) {
  const { shift } = world, i = s.idx;
  for (let j = 0; j < 3; j++) { await jitter(); ok(await s.dev.post("/api/student/study-log", { category: "self-study", subject: `STUDY#s${i}`, minutes: 20 + (i % 30) + j, studyDate: shift(-j) }), `study s${i}`); }
  ok(await s.dev.put("/api/student/goals", { dailyMinutes: 60, weeklyMinutes: 300 }), `goals s${i}`);
  for (let j = 1; j <= 2; j++) ok(await s.dev.post("/api/student/plan-items", { kind: j === 1 ? "goal" : "revision", title: `PLAN#s${i}#${j}`, notes: `PLAN#s${i} note`, subject: "Physics", startDate: world.today, endDate: shift(3 + j) }), `plan s${i}`);
  ok(await s.dev.post("/api/student/exams", { subject: "Maths", title: `EXAM#s${i}`, examDate: shift(10) }), `exam s${i}`);
  ok(await s.dev.post("/api/student/parent-link", {}), `parent link s${i}`);
}
async function studentHandsIn(world, s) {
  const dash = ok(await s.dev.get("/api/student/dashboard"), `dashboard s${s.idx}`).body;
  const byClassId = new Map(world.classes.map(c => [c.id, c]));
  for (const h of dash.homework) {
    const c = byClassId.get(h.class_id); await jitter();
    ok(await s.dev.post(`/api/student/homework/${h.id}/submit`, { note: `SUB#s${s.idx}#c${c.k}` }), `submit s${s.idx}`);
    ok(await s.dev.post(`/api/student/homework/${h.id}/files`, {}, { file: pdf(`FILE-s${s.idx}-c${c.k}`, `FILE-s${s.idx}-c${c.k}.pdf`) }), `submission file s${s.idx}`);
  }
  ok(await s.dev.get("/api/notifications/unread-count"), "bell"); ok(await s.dev.get("/api/student/planner"), "planner");
}
async function teacherReads(world, T) {
  for (const c of T.classes) {
    const H = { headers: { "x-class-id": String(c.id) } };
    const ov = ok(await T.dev.get("/api/teacher/overview", H), "overview").body;
    for (const h of ov.homework) ok(await T.dev.get(`/api/teacher/homework/${h.id}/submissions`, H), "submissions");
    ok(await T.dev.get(`/api/teacher/attendance?date=${world.today}`, H), "attendance read");
  }
}

// ---- what each person can see: everything their account can read, in one string ----
const STUDENT_READS = ["/api/student/dashboard", "/api/calendar?from=2026-10-01&to=2026-10-31", "/api/notifications?limit=200", "/api/student/announcements", "/api/student/plan-items", "/api/student/planner", "/api/student/attendance", "/api/student/syllabus", "/api/student/goals", "/api/student/parent-link/preview", "/api/account/export"];
async function studentBlob(s) {
  let blob = "";
  for (const u of STUDENT_READS) { const r = await s.dev.get(u); assert.equal(r.status, 200, `${u} for student ${s.idx}: ${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`); blob += `\n${u}\n${JSON.stringify(r.body)}`; }
  return blob;
}
async function teacherBlob(world, T) {
  let blob = "";
  for (const c of T.classes) {
    const H = { headers: { "x-class-id": String(c.id) } };
    for (const u of ["/api/teacher/overview", `/api/teacher/attendance?date=${world.today}`, "/api/teacher/syllabus", "/api/teacher/announcements", "/api/calendar?from=2026-10-01&to=2026-10-31", "/api/teacher/join-requests"]) { const r = await T.dev.get(u, H); assert.equal(r.status, 200, `${u} for teacher ${T.idx}: ${r.status}`); blob += `\n${u}\n${JSON.stringify(r.body)}`; }
    const ov = (await T.dev.get("/api/teacher/overview", H)).body;
    for (const h of ov.homework) blob += JSON.stringify((await T.dev.get(`/api/teacher/homework/${h.id}/submissions`, H)).body);
    for (const sheet of ["summary", "results", "attendance", "homework"]) { const r = await T.dev.get(`/api/teacher/export?format=csv&sheet=${sheet}`, H); assert.equal(r.status, 200); blob += r.body.toString("utf8"); }
  }
  return blob;
}
const tokensIn = text => ({
  classes: new Set([...text.matchAll(/#c(\d+)\b|FILE-c(\d+)-|ZC(\d+)C/g)].map(m => Number(m[1] ?? m[2] ?? m[3]))),
  students: new Set([...text.matchAll(/#s(\d+)\b|FILE-s(\d+)-|ZQ(\d+)Q|zq(\d+)q@/g)].map(m => Number(m[1] ?? m[2] ?? m[3] ?? m[4]))),
  teachers: new Set([...text.matchAll(/ZT(\d+)T|zt(\d+)t@/g)].map(m => Number(m[1] ?? m[2]))),
});
const setDiff = (found, allowed) => [...found].filter(x => !allowed.has(x));

// ============================================================================================================
test("100+ people at once: nothing is mixed between classes, teachers, institutes or students", { timeout: 300000 }, async () => {
  const app = await createTestApp({ env: { IP_LIMIT_FACTOR: "10" }, limits: { api: undefined } }); // the REAL default limits
  const world = await buildWorld(app);
  const t0 = performance.now();

  // Round 0: everyone signs in at the same moment (teachers are already in; students sign in together, 40 from one wifi).
  await signInStudents(world); await enroll(world);
  assert.equal(world.students.filter(s => s.id).length, N_STUDENTS);
  assert.equal(new Set(world.students.map(s => s.id)).size, N_STUDENTS, "every student has a different account");

  // Round A: teachers publish content while students log study, set goals, plan and share parent links, all together.
  await Promise.all([...world.teachers.map(t => teacherWork(world, t)), ...world.students.map(s => studentPlanning(world, s))]);

  // Round B: students hand in homework with files while teachers read their dashboards, all together.
  await Promise.all([...world.students.map(s => studentHandsIn(world, s)), ...world.teachers.map(t => teacherReads(world, t))]);

  // Round C: teachers review everything while students keep reading, all together.
  await Promise.all(world.teachers.map(async T => {
    for (const c of T.classes) {
      const H = { headers: { "x-class-id": String(c.id) } };
      const ov = (await T.dev.get("/api/teacher/overview", H)).body;
      for (const h of ov.homework) await Promise.all(c.students.map(async s => { await jitter(); ok(await T.dev.post(`/api/teacher/homework/${h.id}/review`, { studentId: s.id, feedback: `FB#c${c.k}`, status: "reviewed" }, H), `review c${c.k}`); }));
    }
  }));
  const workMs = performance.now() - t0;

  // ---- 1. PEOPLE ONLY SEE THEIR OWN WORLD ----
  const studentBlobs = await Promise.all(world.students.map(async s => [s, await studentBlob(s)]));
  const leaks = [];
  for (const [s, blob] of studentBlobs) {
    const seen = tokensIn(blob), myTeachers = new Set([...s.classes].map(k => world.classes[k].teacher.idx));
    for (const k of setDiff(seen.classes, s.classes)) leaks.push(`student ${s.idx} can see class ${k}`);
    for (const x of setDiff(seen.students, new Set([s.idx]))) leaks.push(`student ${s.idx} can see student ${x}`);
    for (const x of setDiff(seen.teachers, myTeachers)) leaks.push(`student ${s.idx} can see teacher ${x} (not theirs)`);
    // and they DO see their own things (so the test is not passing because nothing was visible)
    for (const k of s.classes) for (const need of [`HW#c${k}#1`, `TEST#c${k}#1`, `ANN#c${k}`, `EVT#c${k}`, `FILE-c${k}-hw1`, `REM#c${k}`, `SUB#s${s.idx}#c${k}`, `FB#c${k}`]) if (!blob.includes(need)) leaks.push(`student ${s.idx} is missing ${need}`);
    for (const need of [`STUDY#s${s.idx}`, `PLAN#s${s.idx}#1`, `EXAM#s${s.idx}`]) if (!blob.includes(need)) leaks.push(`student ${s.idx} is missing ${need}`);
    if (s.classes.size === 0 && /HW#|TEST#|ANN#/.test(blob)) leaks.push(`student ${s.idx} is in no class but sees class content`);
  }
  const teacherBlobs = await Promise.all(world.teachers.map(async T => [T, await teacherBlob(world, T)]));
  for (const [T, blob] of teacherBlobs) {
    const seen = tokensIn(blob), myClasses = new Set(T.classes.map(c => c.k)), myStudents = new Set(T.classes.flatMap(c => c.students.map(s => s.idx)));
    for (const k of setDiff(seen.classes, myClasses)) leaks.push(`teacher ${T.idx} can see class ${k}`);
    for (const x of setDiff(seen.students, myStudents)) leaks.push(`teacher ${T.idx} can see student ${x} (not in their classes)`);
    for (const x of setDiff(seen.teachers, new Set([T.idx]))) leaks.push(`teacher ${T.idx} can see teacher ${x}`);
    for (const c of T.classes) for (const need of [`HW#c${c.k}#1`, `TEST#c${c.k}#1`, `ANN#c${c.k}`, `FILE-s${c.students[0]?.idx}-c${c.k}`]) if (!blob.includes(need)) leaks.push(`teacher ${T.idx} is missing ${need}`);
    // Study logs ARE shown to a teacher for their own students (the Study activity feature, and the student check above proves whose).
    // A student's private goals, calendar items and exams are never shown to a teacher.
    for (const m of blob.match(/(?:PLAN|EXAM)#s\d+/g) || []) leaks.push(`teacher ${T.idx} sees a student's private ${m}`);
  }
  assert.deepEqual(leaks, [], `data leaked between people:\n${leaks.slice(0, 20).join("\n")}`);

  // ---- 2. DATA IS COMPLETE, NOT DUPLICATED, NOT ORPHANED ----
  const db = app.db, count = async (sql, p = []) => (await db.one(sql, p)).n;
  const enrolledTotal = world.classes.reduce((n, c) => n + c.students.length, 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM homework"), world.classes.length); assert.equal(await count("SELECT COUNT(*) AS n FROM tests"), world.classes.length);
  assert.equal(await count("SELECT COUNT(*) AS n FROM attachments"), world.classes.length * 3, "2 homework files + 1 test file per class, none lost or doubled");
  assert.equal(await count("SELECT COUNT(*) AS n FROM marks"), enrolledTotal); assert.equal(await count("SELECT COUNT(*) AS n FROM attendance"), enrolledTotal * 3);
  assert.equal(await count("SELECT COUNT(*) AS n FROM homework_submissions"), enrolledTotal); assert.equal(await count("SELECT COUNT(*) AS n FROM submission_files"), enrolledTotal);
  assert.equal(await count("SELECT COUNT(*) AS n FROM homework_submissions WHERE status='reviewed'"), enrolledTotal);
  assert.equal(await count("SELECT COUNT(*) AS n FROM study_logs"), N_STUDENTS * 3); assert.equal(await count("SELECT COUNT(*) AS n FROM student_plan_items"), N_STUDENTS * 2);
  assert.equal(await count("SELECT COUNT(*) AS n FROM student_exams"), N_STUDENTS); assert.equal(await count("SELECT COUNT(*) AS n FROM parent_links"), N_STUDENTS);
  for (const s of world.students) assert.equal(await count("SELECT COALESCE(SUM(minutes),0) AS n FROM study_logs WHERE student_id=$1", [s.id]), 3 * (20 + (s.idx % 30)) + 3, `no study minutes lost for student ${s.idx}`);
  for (const [t, c] of [["marks", "test_id,student_id"], ["attendance", "student_id,class_id,attendance_date"], ["homework_submissions", "homework_id,student_id"]]) assert.equal((await db.many(`SELECT ${c},COUNT(*) AS n FROM ${t} GROUP BY ${c} HAVING COUNT(*)>1`)).length, 0, `no duplicate rows in ${t}`);

  // Files: every stored object is referenced by exactly one row, sits under its own owner, and holds that owner's content.
  const bucket = app.storage.buckets.get("studytrack-files"), keys = new Set(bucket.keys());
  const rows = [...await db.many("SELECT file_path,file_name,class_id,'teacher' AS who FROM attachments"), ...await db.many("SELECT file_path,file_name,class_id,'student' AS who FROM submission_files")];
  assert.equal(rows.length, keys.size, "no orphaned or missing stored files"); assert.equal(new Set(rows.map(r => r.file_path)).size, rows.length, "no two rows share a stored file");
  const classById = new Map(world.classes.map(c => [c.id, c]));
  for (const r of rows) {
    const c = classById.get(r.class_id), scope = r.file_path.split("/");
    const inst = await db.one("SELECT institute_id FROM users WHERE id=$1", [c.teacher.id]);
    assert.equal(scope[0], inst.institute_id ? `i${inst.institute_id}` : `t${c.teacher.id}`, `${r.file_name} is stored under its own teacher or institute`); assert.equal(scope[1], `c${c.id}`, `${r.file_name} is stored under its own class`);
    if (r.file_name.endsWith(".pdf") || r.file_name.endsWith(".jpg")) assert.ok((await app.storage.download("studytrack-files", r.file_path)).includes(r.file_name.replace(/\.(pdf|jpg)$/, "")), `${r.file_name} holds its own content`);
  }
  assert.equal(await count("SELECT COUNT(DISTINCT c.teacher_id) AS n FROM attachments a JOIN classes c ON c.id=a.class_id"), N_TEACHERS);

  // ---- 3. NOBODY CAN REACH ANYBODY ELSE'S DATA ON PURPOSE ----
  const ids = { hw: {}, test: {}, att: {}, subFile: {}, plan: {}, student: {} };
  for (const c of world.classes) {
    ids.hw[c.k] = (await db.one("SELECT id FROM homework WHERE class_id=$1", [c.id])).id; ids.test[c.k] = (await db.one("SELECT id FROM tests WHERE class_id=$1", [c.id])).id;
    ids.att[c.k] = (await db.one("SELECT id FROM attachments WHERE homework_id=$1 ORDER BY id LIMIT 1", [ids.hw[c.k]])).id;
  }
  for (const s of world.students) { ids.plan[s.idx] = (await db.one("SELECT id FROM student_plan_items WHERE student_id=$1 ORDER BY id LIMIT 1", [s.id])).id; ids.subFile[s.idx] = (await db.many("SELECT f.id FROM submission_files f WHERE f.student_id=$1 ORDER BY f.id", [s.id])).map(x => x.id); }
  const snap = async () => JSON.stringify(await Promise.all(["homework", "tests", "marks", "attendance", "attachments", "submission_files", "homework_submissions", "student_plan_items", "study_logs", "announcements", "calendar_events", "student_class_memberships"].map(t => db.one(`SELECT COUNT(*) AS n,COALESCE(SUM(id),0) AS s FROM ${t}`))));
  const before = await snap(), marksBefore = (await db.one("SELECT SUM(marks) AS s FROM marks")).s, attempts = [];
  const attack = (who, method, url, body, extra, allowed, label) => attempts.push({ who, method, url, body, extra, allowed, label });
  for (const s of world.students.filter(x => x.classes.size && x.idx % 3 === 0)) {
    const foreign = world.classes.find(c => !s.classes.has(c.k) && c.teacher !== world.classes[[...s.classes][0]].teacher), other = world.students.find(o => o !== s && o.classes.size && ![...o.classes].some(k => s.classes.has(k)));
    const oc = world.classes[[...other.classes][0]];
    attack(s.dev, "GET", `/api/attachments/${ids.att[foreign.k]}`, undefined, {}, [404], `student ${s.idx} opens another class's file`);
    attack(s.dev, "POST", `/api/student/homework/${ids.hw[foreign.k]}/submit`, { note: "x" }, {}, [404], `student ${s.idx} hands in to another class`);
    attack(s.dev, "GET", `/api/submission-files/${ids.subFile[other.idx][0]}`, undefined, {}, [404], `student ${s.idx} opens student ${other.idx}'s work`);
    attack(s.dev, "PATCH", `/api/student/plan-items/${ids.plan[other.idx]}`, { title: "hijack" }, {}, [404], `student ${s.idx} edits student ${other.idx}'s calendar`);
    attack(s.dev, "DELETE", `/api/student/plan-items/${ids.plan[other.idx]}`, undefined, {}, [404], `student ${s.idx} deletes student ${other.idx}'s calendar item`);
    attack(s.dev, "DELETE", `/api/student/submission-files/${ids.subFile[other.idx][0]}`, undefined, {}, [404], `student ${s.idx} deletes student ${other.idx}'s file`);
    attack(s.dev, "POST", `/api/student/homework/${ids.hw[oc.k]}/files`, {}, { file: pdf("x", "x.pdf") }, [404], `student ${s.idx} adds a file to another class's homework`);
    for (const u of ["/api/teacher/overview", "/api/teacher/export", "/api/teacher/announcements"]) attack(s.dev, "GET", u, undefined, {}, [403], `student ${s.idx} calls ${u}`);
    attack(s.dev, "POST", "/api/teacher/marks", { testId: ids.test[foreign.k], studentId: s.id, marks: 100 }, {}, [403], `student ${s.idx} gives themself marks`);
  }
  for (const T of world.teachers) {
    const foreign = world.classes.filter(c => c.teacher !== T), fc = foreign[(T.idx * 3) % foreign.length], H = { headers: { "x-class-id": String(fc.id) } }, victim = fc.students[0];
    for (const [m, u, b] of [["GET", "/api/teacher/overview"], ["GET", "/api/teacher/export"], ["POST", "/api/teacher/homework", { title: "x" }], ["POST", "/api/teacher/attendance", { date: world.today, records: [{ studentId: victim.id, status: "absent" }] }], ["POST", "/api/teacher/announcements", { title: "x", body: "y", scope: "class", classIds: [fc.id] }]]) attack(T.dev, m, u, b, H, [404, 403], `teacher ${T.idx} ${m} ${u} on another teacher's class`);
    attack(T.dev, "POST", `/api/teacher/homework/${ids.hw[fc.k]}/attach`, {}, { file: pdf("x", "x.pdf") }, [404], `teacher ${T.idx} attaches to another teacher's homework`);
    attack(T.dev, "DELETE", `/api/teacher/homework/${ids.hw[fc.k]}`, undefined, {}, [404], `teacher ${T.idx} deletes another teacher's homework`);
    attack(T.dev, "GET", `/api/teacher/homework/${ids.hw[fc.k]}/submissions`, undefined, {}, [404], `teacher ${T.idx} reads another teacher's submissions`);
    attack(T.dev, "DELETE", `/api/teacher/attachments/${ids.att[fc.k]}`, undefined, {}, [404], `teacher ${T.idx} deletes another teacher's file`);
    attack(T.dev, "GET", `/api/attachments/${ids.att[fc.k]}`, undefined, {}, [404], `teacher ${T.idx} opens another teacher's file`);
    attack(T.dev, "GET", `/api/submission-files/${ids.subFile[victim.idx][0]}`, undefined, {}, [404], `teacher ${T.idx} opens another class's student work`);
    attack(T.dev, "POST", "/api/teacher/marks", { testId: ids.test[fc.k], studentId: victim.id, marks: 1 }, {}, [404, 403], `teacher ${T.idx} changes another class's marks`);
    attack(T.dev, "POST", `/api/teacher/homework/${ids.hw[fc.k]}/review`, { studentId: victim.id, feedback: "hack", status: "reviewed" }, {}, [404], `teacher ${T.idx} reviews another class's work`);
    attack(T.dev, "GET", "/api/student/dashboard", undefined, {}, [403], `teacher ${T.idx} calls the student dashboard`);
    attack(T.dev, "GET", `/api/teacher/student/${victim.id}/homework`, undefined, H, [404, 403, 400], `teacher ${T.idx} reads another class's student`);
  }
  attack(new Device(app), "GET", "/api/student/dashboard", undefined, {}, [401], "signed-out visitor");
  attack(new Device(app), "GET", `/api/attachments/${ids.att[0]}`, undefined, {}, [401], "signed-out visitor opens a file");
  const results = await Promise.all(attempts.map(async a => ({ a, r: await a.who.call(a.method, a.url, a.body, a.extra) })));  // all at once
  const failures = results.filter(({ a, r }) => !a.allowed.includes(r.status)).map(({ a, r }) => `${a.label}: got ${r.status}, wanted ${a.allowed.join("/")}`);
  assert.deepEqual(failures, [], `access that should have been refused:\n${failures.slice(0, 15).join("\n")}`);
  assert.equal(await snap(), before, "the attacks changed nothing"); assert.equal((await db.one("SELECT SUM(marks) AS s FROM marks")).s, marksBefore);

  // ---- 4. THE SYSTEM COPED ----
  const bad = stats.filter(s => s.status >= 500 || s.status === 429 || s.status === 503);
  assert.deepEqual(bad.slice(0, 5), [], "no server errors and no rate-limit or overload refusals for normal use");
  const sorted = stats.map(s => s.ms).sort((a, b) => a - b), pct = p => sorted[Math.floor(sorted.length * p)].toFixed(1);
  console.log(`  [scale] ${world.teachers.length} teachers + ${N_STUDENTS} students, ${world.classes.length} classes, 2 institutes; ${stats.length} requests in ${(workMs / 1000).toFixed(1)}s; latency p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, p99 ${pct(0.99)} ms, max ${sorted.at(-1).toFixed(0)} ms; ${attempts.length} cross-access attempts all refused`);
});

// ============================================================================================================
test("simultaneous clicks on the same thing: joins, approvals, double submits, double uploads, same marks", { timeout: 120000 }, async () => {
  const app = await createTestApp({ env: { IP_LIMIT_FACTOR: "10" }, limits: { api: undefined } });
  const t = new Device(app, { ip: "198.51.100.1" }); ok(await t.signIn({ sub: "t1", email: "t1@gmail.com", name: "T", role: "teacher" }), "teacher");
  const cls = ok(await t.post("/api/teacher/classes", { name: "Contention" }), "class").body, H = { headers: { "x-class-id": String(cls.id) } };
  const kids = Array.from({ length: 45 }, (_, i) => new Device(app, { ip: "203.0.113.77", ua: UAS[i % UAS.length] }));   // one wifi
  await Promise.all(kids.map(async (d, i) => { const r = ok(await d.signIn({ sub: `k${i}`, email: `k${i}@gmail.com`, name: `Kid ${i}`, role: "student" }), `kid ${i}`); d.id = r.body.user.id; }));

  // 45 students ask to join at the same moment; the teacher approves all 45 at the same moment.
  const joins = await Promise.all(kids.map(d => d.post("/api/student/join-request", { classCode: cls.code })));
  assert.deepEqual([...new Set(joins.map(r => r.status))], [201], "every join request is accepted");
  const pending = ok(await t.get("/api/teacher/join-requests", H), "pending").body.pending; assert.equal(pending.length, 45);
  const approvals = await Promise.all(pending.map(p => t.post(`/api/teacher/join-requests/${p.id}/approve`, {}, H)));
  assert.deepEqual([...new Set(approvals.map(r => r.status))], [200]);
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM student_class_memberships WHERE class_id=$1 AND status='active'", [cls.id])).n, 45);
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM join_requests WHERE status='pending'")).n, 0);
  assert.equal((await app.db.many("SELECT student_id FROM student_class_memberships GROUP BY student_id,class_id HAVING COUNT(*)>1")).length, 0, "nobody joined twice");

  const hw = ok(await t.post("/api/teacher/homework", { title: "Race", dueDate: world0(app) }, H), "homework").body.created[0].id;
  // The same student double (and sextuple) clicks Submit; another uploads 8 files at once; another studies from two devices.
  const a = kids[0], b = kids[1], c1 = kids[2], c2 = new Device(app, { ip: "203.0.113.90", ua: UAS[2] });
  await c2.signIn({ sub: "k2", email: "k2@gmail.com", name: "Kid 2", role: "student" });
  const submits = await Promise.all(Array.from({ length: 6 }, () => a.post(`/api/student/homework/${hw}/submit`, { note: "once" })));
  assert.ok(submits.every(r => r.status === 200), JSON.stringify(submits.map(r => r.status)));
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM homework_submissions WHERE student_id=$1", [a.id])).n, 1, "six simultaneous submits make ONE submission");
  await b.post(`/api/student/homework/${hw}/submit`, {});
  const uploads = await Promise.all(Array.from({ length: 8 }, (_, i) => b.post(`/api/student/homework/${hw}/files`, {}, { file: pdf(`f${i}`, `f${i}.pdf`) })));
  assert.equal(uploads.filter(r => r.status === 201).length, 5, `exactly the 5-file limit is kept, even with 8 uploads at once: ${JSON.stringify(uploads.map(r => r.status))}`);
  assert.deepEqual([...new Set(uploads.filter(r => r.status !== 201).map(r => r.body.code))], ["TOO_MANY_FILES"]);
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM submission_files WHERE student_id=$1", [b.id])).n, 5); assert.equal(app.storage.buckets.get("studytrack-files").size, 5, "the refused uploads left nothing in storage");
  const logs = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? c1 : c2).post("/api/student/study-log", { category: "self-study", subject: "Physics", minutes: 10, studyDate: app.clock.today() })));
  assert.ok(logs.every(r => r.status === 201 || r.status === 200)); assert.equal((await app.db.one("SELECT SUM(minutes) AS n FROM study_logs WHERE student_id=$1", [c1.id])).n, 300, "two devices, no lost updates");

  // Teacher: 10 attendance and 10 marks requests for the same people at the same moment (two browser tabs).
  const tab2 = new Device(app, { ip: "198.51.100.1", ua: UAS[3] }); tab2.cookies = { ...t.cookies }; tab2.csrf = t.csrf;
  const test = ok(await t.post("/api/teacher/tests", { title: "T", subject: "S", maxMarks: 100, testDate: world0(app) }, H), "test").body;
  const writes = [];
  for (let i = 0; i < 10; i++) { const tab = i % 2 ? t : tab2; writes.push(tab.post("/api/teacher/attendance", { date: world0(app), records: kids.slice(0, 20).map(k => ({ studentId: k.id, status: i % 3 ? "present" : "absent" })) }, H)); writes.push(tab.post("/api/teacher/marks", { testId: test.id, studentId: kids[3].id, marks: 10 + i }, H)); }
  assert.ok((await Promise.all(writes)).every(r => r.status === 200), "all simultaneous writes succeed");
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM attendance")).n, 20, "one attendance row per student per day, not ten"); assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM marks")).n, 1, "one mark, not ten");

  // The teacher deletes the homework while 20 students hand in work; afterwards nothing is orphaned.
  const rest = kids.slice(3, 23);
  await Promise.all([t.delete(`/api/teacher/homework/${hw}`, H), ...rest.map(async d => { await d.post(`/api/student/homework/${hw}/submit`, { note: "x" }); await d.post(`/api/student/homework/${hw}/files`, {}, { file: pdf("late", "late.pdf") }); })]);
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM homework")).n, 0);
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM homework_submissions")).n, 0, "no submissions left behind for a deleted homework");
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM submission_files")).n, 0);
  assert.equal(app.storage.buckets.get("studytrack-files").size, 0, "no stored file is left without a database row");
});
const world0 = app => app.clock.shift(app.clock.today(), 0);

// ============================================================================================================
test("one wifi, 110 people: sign in, join, work. And the protections that matter are still on.", { timeout: 120000 }, async () => {
  const app = await createTestApp({ env: { IP_LIMIT_FACTOR: "10" }, limits: { api: undefined } });
  const t = new Device(app, { ip: "198.51.100.1" }); ok(await t.signIn({ sub: "t1", email: "t1@gmail.com", name: "T", role: "teacher" }), "teacher");
  const cls = ok(await t.post("/api/teacher/classes", { name: "Wifi" }), "class").body;
  const crowd = Array.from({ length: 110 }, (_, i) => new Device(app, { ip: "203.0.113.50", ua: UAS[i % UAS.length] }));
  const out = await Promise.all(crowd.map(async (d, i) => {
    const s = await d.signIn({ sub: `c${i}`, email: `c${i}@gmail.com`, name: `C${i}`, role: "student" }); if (s.status !== 200) return [s.status];
    const j = await d.post("/api/student/join-request", { classCode: cls.code }); const rest = [];
    for (let n = 0; n < 6; n++) { rest.push((await d.get("/api/student/dashboard")).status, (await d.get("/api/notifications/unread-count")).status); }
    return [s.status, j.status, ...rest];
  }));
  assert.equal(out.flat().filter(s => s === 429).length, 0, "nobody on the shared wifi is rate limited");
  assert.equal(out.flat().filter(s => s >= 400).length, 0);

  // Abuse is still stopped: a stolen/guessed-password attack on ONE account, one person hammering the server, a sign-up flood.
  const victim = new Device(app, { ip: "198.51.100.200" }); await victim.register({ email: "victim@gmail.com", password: PW }); await victim.openMailLink();
  const attacker = new Device(app, { ip: "198.51.100.201" }); let locked = 0;
  for (let i = 0; i < 12; i++) if ((await attacker.login("victim@gmail.com", `Wrong${i}Pass99`)).status === 429) locked++;
  assert.ok(locked >= 3, "repeated wrong passwords for one account are still locked out");
  assert.equal((await new Device(app, { ip: "198.51.100.201" }).login("victim@gmail.com", PW)).status, 429, "even the right password waits during the lock-out from that attacker's network");
  assert.equal((await new Device(app, { ip: "198.51.100.77" }).login("victim@gmail.com", PW)).status, 200, "but the real owner on another network is fine");
  const hammer = crowd[0]; let limited = 0; for (let i = 0; i < 700; i++) if ((await hammer.get("/api/notifications/unread-count")).status === 429) limited++;
  assert.ok(limited > 0, "a single account hammering the server is slowed down");
  assert.equal((await crowd[1].get("/api/notifications/unread-count")).status, 200, "while everybody else on the same wifi is unaffected");
  const flooder = new Device(app, { ip: "203.0.113.99" }); let refused = 0;
  for (let i = 0; i < 130; i++) if ((await flooder.register({ email: `flood${i}@gmail.com`, password: PW })).status === 429) refused++;
  assert.ok(refused > 0, "a sign-up flood from one network is still cut off (after 100 an hour)");
});

// ============================================================================================================
test("heavy moments degrade politely: upload memory budget and password-hashing queue", async () => {
  // Uploads: only so many megabytes are accepted into memory at the same moment; the rest are told to retry.
  const gate = createUploadGate({ budgetBytes: 100, maxRequestBytes: 60 });
  const mk = size => { const handlers = {}; return { req: { get: () => String(size) }, res: { on: (e, f) => { handlers[e] = f; }, set() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, handlers } }; };
  let ran = 0; const mw = gate.guard((req, res, next) => { ran++; });
  const a = mk(60), b = mk(60), c = mk(30);
  mw(a.req, a.res); mw(b.req, b.res); mw(c.req, c.res);
  assert.equal(ran, 2, "the first upload and the small one fit; the second big one is refused"); assert.equal(b.res.code, 503); assert.equal(b.res.body.code, "BUSY");
  a.res.handlers.finish(); a.res.handlers.close();                      // finishing (and closing) releases its share exactly once
  const d = mk(60); mw(d.req, d.res); assert.equal(ran, 3, "room again after one finished"); assert.deepEqual(gate.load(), { used: 90, inFlight: 2 });
  const huge = createUploadGate({ budgetBytes: 10, maxRequestBytes: 1000 }); let hr = 0; const hm = huge.guard(() => { hr++; }); const one = mk(900); hm(one.req, one.res); assert.equal(hr, 1, "a single upload is never refused just for being big");

  // Passwords: only a few hashes run at once; when a rush builds a long queue, new sign-ins are told to retry (never 'wrong password').
  process.env.PASSWORD_HASH_PARALLEL = "1"; process.env.PASSWORD_HASH_QUEUE = "5";
  const pw = await import("../src/passwords.js?busy-test");
  delete process.env.PASSWORD_HASH_PARALLEL; delete process.env.PASSWORD_HASH_QUEUE;
  const stored = await pw.hashPassword("Sunrise2026");
  const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => pw.verifyPassword("Sunrise2026", stored)));
  const busy = outcomes.filter(o => o.status === "rejected" && o.reason.code === "BUSY"), good = outcomes.filter(o => o.status === "fulfilled" && o.value === true);
  assert.ok(busy.length >= 12 && good.length >= 5 && busy.length + good.length === 20, `busy ${busy.length}, ok ${good.length}`);
  assert.ok(busy.every(o => o.reason.status === 503)); assert.deepEqual(pw.hashLoad(), { running: 0, waiting: 0 }, "the queue empties afterwards");
  assert.equal(await pw.verifyPassword("Sunrise2026", stored), true, "and normal service resumes");
});

// ============================================================================================================
test("cost does not grow with class size: the number of database queries is the same for 10 and 80 students", { timeout: 120000 }, async () => {
  async function measure(n) {
    const app = await createTestApp({ env: { IP_LIMIT_FACTOR: "10" }, limits: { api: undefined, heavy: 100000 } });
    const t = new Device(app, { ip: "198.51.100.1" }); const tr = ok(await t.signIn({ sub: "t1", email: "t1@gmail.com", name: "T", role: "teacher" }), "t");
    const cls = ok(await t.post("/api/teacher/classes", { name: "Q" }), "c").body, H = { headers: { "x-class-id": String(cls.id) } }, now = app.clock.nowIso(), today = app.clock.today(), ids = [];
    for (let i = 0; i < n; i++) { const u = await app.db.one("INSERT INTO users(email,name,role,created_at,profile_completed_at) VALUES($1,$2,'student',$3,$3) RETURNING id", [`q${i}@gmail.com`, `Q${i}`, now]); ids.push(u.id); await app.db.exec("INSERT INTO student_class_memberships(student_id,class_id,status,joined_at) VALUES($1,$2,'active',$3)", [u.id, cls.id, now]); }
    for (let k = 0; k < 6; k++) { const x = await app.db.one("INSERT INTO tests(teacher_id,class_id,title,subject,max_marks,test_date,created_at) VALUES($1,$2,$3,'P',100,$4,$5) RETURNING id", [tr.body.user.id, cls.id, `T${k}`, app.clock.shift(today, -k), now]); for (const sid of ids) await app.db.exec("INSERT INTO marks(test_id,student_id,marks,created_at) VALUES($1,$2,$3,$4)", [x.id, sid, 50, now]); }
    for (let d = 0; d < 10; d++) for (const sid of ids) await app.db.exec("INSERT INTO attendance(class_id,student_id,attendance_date,status) VALUES($1,$2,$3,'present')", [cls.id, sid, app.clock.shift(today, -d)]);
    for (const sid of ids) await app.db.exec("INSERT INTO study_logs(student_id,category,subject,minutes,study_date,created_at) VALUES($1,'self-study','P',30,$2,$3)", [sid, today, now]);
    let q = 0; for (const m of ["one", "many", "exec"]) { const o = app.db[m].bind(app.db); app.db[m] = (...a) => { q++; return o(...a); }; }
    const used = {}, probe = async (name, get) => { q = 0; const r = await get(); assert.equal(r.status, 200, name); used[name] = q; };
    await probe("teacher overview", () => t.get("/api/teacher/overview", H)); await probe("attendance", () => t.get(`/api/teacher/attendance?date=${today}`, H));
    await probe("export", () => t.get("/api/teacher/export", H)); await probe("syllabus", () => t.get("/api/teacher/syllabus", H));
    const s = new Device(app, { ip: "203.0.113.4" }); await s.signIn({ sub: "q0", email: "q0@gmail.com", name: "Q0", role: "student" });
    await probe("student dashboard", () => s.get("/api/student/dashboard")); await probe("student calendar", () => s.get("/api/calendar?from=2026-10-01&to=2026-10-31"));
    return used;
  }
  const small = await measure(10), large = await measure(80);
  assert.deepEqual(large, small, "database work per request does not depend on how many students there are");
});
