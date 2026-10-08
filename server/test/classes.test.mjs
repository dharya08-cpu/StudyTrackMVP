import test from "node:test";
import assert from "node:assert/strict";
import { createTestApp, Browser } from "./helpers.mjs";
import { makePdf, makePng, makeDocx, upload } from "./fixtures.mjs";

const mkTeacher = async (app, n, name = `Teacher ${n}`) => { const b = new Browser(app); const r = await b.signIn({ sub: `t${n}`, email: `t${n}@gmail.com`, name, role: "teacher" }); assert.equal(r.status, 200); b.id = r.body.user.id; return b; };
const mkStudent = async (app, n) => { const b = new Browser(app); const r = await b.signIn({ sub: `s${n}`, email: `s${n}@gmail.com`, name: `Student ${n}`, role: "student" }); assert.equal(r.status, 200); b.id = r.body.user.id; return b; };
const mkClass = async (t, name, code) => { const r = await t.post("/api/teacher/classes", { name, ...(code ? { code } : {}) }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
const approveJoin = async (student, teacher, cls) => {
  const r = await student.post("/api/student/join-request", { classCode: cls.code }); assert.equal(r.status, 201, JSON.stringify(r.body));
  const pending = (await teacher.get("/api/teacher/join-requests")).body.pending.find(x => x.class_id === cls.id && x.student_id === student.id);
  const a = await teacher.post(`/api/teacher/join-requests/${pending.id}/approve`); assert.equal(a.status, 200, JSON.stringify(a.body));
};
const inClass = (cls) => ({ headers: { "x-class-id": String(cls.id) } });

test("a teacher can create many classes; codes are unique and validated", async () => {
  const app = await createTestApp(); const t = await mkTeacher(app, 1);
  const a = await mkClass(t, "Physics 11"), b = await mkClass(t, "Chemistry 11", "chem11"), c = await mkClass(t, "Biology 11");
  assert.equal(b.code, "CHEM11"); assert.equal(new Set([a.code, b.code, c.code]).size, 3);
  assert.equal((await t.post("/api/teacher/classes", { name: "Dup", code: "CHEM11" })).status, 409);
  assert.equal((await t.post("/api/teacher/classes", { name: "Bad", code: "a b" })).status, 400);
  assert.equal((await t.post("/api/teacher/classes", { name: "" })).status, 400);
  assert.equal((await t.post("/api/teacher/classes", { name: { $gt: "" } })).status, 400);
  const ctx = (await t.get("/api/teacher/context")).body;
  assert.deepEqual(ctx.classes.map(x => x.name), ["Physics 11", "Chemistry 11", "Biology 11"]);
});

test("one student joins several classes (student_class_memberships) of one teacher and of another teacher", async () => {
  const app = await createTestApp();
  const t1 = await mkTeacher(app, 1), t2 = await mkTeacher(app, 2), s = await mkStudent(app, 1);
  const phy = await mkClass(t1, "Physics Class 11"), chem = await mkClass(t1, "Chemistry Class 11"), bio = await mkClass(t2, "Biology Class 11");
  for (const [cls, teacher] of [[phy, t1], [chem, t1], [bio, t2]]) await approveJoin(s, teacher, cls);
  const rows = await app.db.many("SELECT class_id,status FROM student_class_memberships WHERE student_id=$1 ORDER BY class_id", [s.id]);
  assert.equal(rows.length, 3); assert.ok(rows.every(r => r.status === "active"));
  const classes = (await s.get("/api/student/classes")).body;
  assert.deepEqual(classes.classes.map(c => c.name), ["Physics Class 11", "Chemistry Class 11", "Biology Class 11"]);
  assert.equal(classes.pending.length, 0);
  assert.equal((await t1.get("/api/teacher/context")).body.classes[0].student_count, 1);
  // a second student only in Physics; the teacher sees per-class rosters
  const s2 = await mkStudent(app, 2); await approveJoin(s2, t1, phy);
  assert.equal((await t1.get("/api/teacher/overview", inClass(phy))).body.students.length, 2);
  assert.equal((await t1.get("/api/teacher/overview", inClass(chem))).body.students.length, 1);
  // dashboard: aggregate vs one class vs a class that is not yours
  const hw1 = (await t1.post("/api/teacher/homework", { title: "Physics HW", dueDate: "2026-10-20" }, inClass(phy))).body.created[0].id;
  await t1.post("/api/teacher/homework", { title: "Chem HW" }, inClass(chem)); await t2.post("/api/teacher/homework", { title: "Bio HW" }, inClass(bio));
  assert.deepEqual((await s.get("/api/student/dashboard")).body.homework.map(h => h.title).sort(), ["Bio HW", "Chem HW", "Physics HW"]);
  assert.deepEqual((await s.get(`/api/student/dashboard?classId=${chem.id}`)).body.homework.map(h => h.title), ["Chem HW"]);
  assert.deepEqual((await s2.get("/api/student/dashboard")).body.homework.map(h => h.title), ["Physics HW"]);
  assert.equal((await s2.get(`/api/student/dashboard?classId=${bio.id}`)).status, 404, "cannot view a class you are not in");
  assert.equal((await s.get("/api/student/dashboard?classId=abc")).status, 400);
  // removing the student from ONE class leaves the others
  assert.equal((await t1.delete(`/api/teacher/students/${s.id}`, inClass(chem))).status, 200);
  assert.deepEqual((await s.get("/api/student/classes")).body.classes.map(c => c.name), ["Physics Class 11", "Biology Class 11"]);
  assert.equal((await s.get("/api/student/dashboard")).body.homework.length, 2);
  assert.equal((await t1.delete(`/api/teacher/students/${s2.id}`, inClass(chem))).status, 404, "student not in that class");
  assert.equal((await t2.delete(`/api/teacher/students/${s.id}`, inClass(bio))).status, 200);
  assert.equal((await s.post(`/api/student/classes/${phy.id}/leave`)).status, 200);
  assert.equal((await s.post(`/api/student/classes/${phy.id}/leave`)).status, 404);
  assert.equal((await s.get("/api/student/classes")).body.classes.length, 0);
  await approveJoin(s, t1, phy);                           // re-joining after removal works
  assert.equal((await app.db.one("SELECT status FROM student_class_memberships WHERE student_id=$1 AND class_id=$2", [s.id, phy.id])).status, "active");
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM student_class_memberships WHERE student_id=$1 AND class_id=$2", [s.id, phy.id])).n, 1, "no duplicate membership rows");
  assert.ok(hw1);
});

test("join-request rules: unknown code, duplicates, deny cool-down, block, caps and notifications", async () => {
  const app = await createTestApp({ limits: { join: 100, joinIp: 100 } });
  const t = await mkTeacher(app, 1), s = await mkStudent(app, 1), other = await mkStudent(app, 2);
  const a = await mkClass(t, "A"), b = await mkClass(t, "B");
  assert.equal((await s.post("/api/student/join-request", { classCode: "NOPE99" })).status, 404);
  assert.equal((await s.post("/api/student/join-request", { classCode: "x" })).status, 400);
  assert.equal((await s.post("/api/student/join-request", { classCode: { $ne: "" } })).status, 400);
  assert.equal((await s.post("/api/student/join-request", { classCode: a.code.toLowerCase() })).status, 201, "codes are case-insensitive");
  assert.equal((await s.post("/api/student/join-request", { classCode: a.code })).status, 409, "duplicate pending request");
  assert.equal((await s.post("/api/student/join-request", { classCode: b.code })).status, 201, "a second class is allowed in parallel");
  assert.equal((await s.get("/api/student/classes")).body.pending.length, 2);
  let notes = (await t.get("/api/notifications")).body; assert.equal(notes.unread, 2); assert.match(notes.notifications[0].title, /Student 1 wants to join/);
  const pending = (await t.get("/api/teacher/join-requests")).body.pending;
  assert.equal((await t.post(`/api/teacher/join-requests/${pending[0].id}/deny`, { mode: "remove" })).status, 200);
  assert.equal((await t.post(`/api/teacher/join-requests/${pending[0].id}/deny`, { mode: "remove" })).status, 409, "already handled");
  const cool = await s.post("/api/student/join-request", { classCode: a.code }); assert.equal(cool.status, 429); assert.equal(cool.body.code, "COOLDOWN");
  app.advance(25 * 3600_000); assert.equal((await s.post("/api/student/join-request", { classCode: a.code })).status, 201, "allowed again after 24h");
  assert.equal((await s.post("/api/student/join-requests/999/cancel")).status, 404);
  const mine = (await s.get("/api/student/classes")).body.pending.find(x => x.className === "A");
  assert.equal((await other.post(`/api/student/join-requests/${mine.id}/cancel`)).status, 404, "cannot cancel someone else's request");
  assert.equal((await s.post(`/api/student/join-requests/${mine.id}/cancel`)).status, 200);
  // block needs explicit confirmation and covers every class of this teacher
  await other.post("/api/student/join-request", { classCode: a.code });
  const op = (await t.get("/api/teacher/join-requests")).body.pending.find(x => x.student_id === other.id);
  assert.equal((await t.post(`/api/teacher/join-requests/${op.id}/deny`, { mode: "block" })).body.code, "CONFIRM_REQUIRED");
  assert.equal((await t.post(`/api/teacher/join-requests/${op.id}/deny`, { mode: "block", confirm: true })).status, 200);
  const blocked = await other.post("/api/student/join-request", { classCode: b.code }); assert.equal(blocked.status, 403); assert.equal(blocked.body.code, "BLOCKED");
  assert.equal((await t.post(`/api/teacher/join-requests/${op.id}/deny`, { mode: "nuke" })).status, 400);
  const blockId = (await t.get("/api/teacher/join-requests")).body.blocked[0].id;
  assert.equal((await t.delete(`/api/teacher/blocks/${blockId}`)).status, 200);
  assert.equal((await other.post("/api/student/join-request", { classCode: b.code })).status, 201, "unblocked");
  assert.equal((await other.get("/api/notifications")).body.notifications.some(n => n.type === "join_denied"), true);
  // spam cap: at most 10 open requests
  const spammer = await mkStudent(app, 3); const teachers = [];
  for (let i = 0; i < 11; i++) { const tt = await mkTeacher(app, 100 + i); teachers.push(await mkClass(tt, `C${i}`)); }
  const results = []; for (const c of teachers) results.push((await spammer.post("/api/student/join-request", { classCode: c.code })));
  assert.equal(results.filter(r => r.status === 201).length, 10); assert.equal(results.at(-1).body.code, "TOO_MANY_PENDING");
});

test("join-code endpoint is rate limited per user and per network", async () => {
  const app = await createTestApp({ limits: { join: 5, joinIp: 8 } });
  const s = await mkStudent(app, 1);
  const codes = []; for (let i = 0; i < 7; i++) codes.push((await s.post("/api/student/join-request", { classCode: `ZZZZ${i}0` })).status);
  assert.deepEqual(codes, [404, 404, 404, 404, 404, 429, 429]);
});

test("HOMEWORK (v3 bug fixed): teacher creates homework with text only, and with PDF/JPG/PNG/DOCX attachments", async () => {
  const app = await createTestApp();
  const t = await mkTeacher(app, 1); const cls = await mkClass(t, "Physics 11"); const s = await mkStudent(app, 1); await approveJoin(s, t, cls);
  const text = await t.post("/api/teacher/homework", { title: "Read chapter 3", description: "Solve all examples", dueDate: "2026-10-12" });
  assert.equal(text.status, 201, JSON.stringify(text.body)); assert.equal(text.body.created[0].class_id, cls.id);
  const files = [["notes.pdf", makePdf(), "application/pdf"], ["board.png", makePng(), "image/png"], ["doc.docx", makeDocx(), "application/octet-stream"]];
  for (const [name, buf, mime] of files) {
    const r = await t.post("/api/teacher/homework", { title: `With ${name}`, dueDate: "2026-10-15" }, { file: upload(buf, name, mime) });
    assert.equal(r.status, 201, `${name}: ${JSON.stringify(r.body)}`); assert.equal(r.body.fileName, name);
  }
  const rows = await app.db.many("SELECT title,file_path,file_name,file_size,file_type FROM homework ORDER BY id");
  assert.equal(rows.length, 4); assert.equal(rows[0].file_path, null);
  assert.ok(rows.slice(1).every(r => /^t\d+\/c\d+\/homework\/[0-9a-f-]{36}\.(pdf|png|docx)$/.test(r.file_path)), "random stored names");
  assert.equal(app.storage.buckets.get("studytrack-files").size, 3);
  assert.equal(rows[1].file_type, "application/pdf");
  const dash = (await s.get("/api/student/dashboard")).body.homework;
  assert.equal(dash.length, 4); assert.ok(dash.filter(h => h.has_file).length === 3);
  assert.equal(JSON.stringify(dash).includes("file_path"), false, "storage keys never reach the browser");
  assert.equal((await t.get("/api/teacher/overview")).body.homework.length, 4);
  assert.equal(JSON.stringify((await t.get("/api/teacher/overview")).body).includes("file_path"), false);
  assert.equal((await s.get("/api/student/dashboard")).body.stats !== undefined, true);
  const hn = (await s.get("/api/notifications")).body.notifications; assert.equal(hn.filter(n => n.type === "homework").length, 4);
});

test("homework validation and bad uploads create nothing", async () => {
  const app = await createTestApp();
  const t = await mkTeacher(app, 1); const cls = await mkClass(t, "P");
  for (const body of [{}, { title: "" }, { title: "x".repeat(201) }, { title: "ok", dueDate: "2026-02-31" }, { title: "ok", dueDate: "tomorrow" }, { title: "ok", description: "d".repeat(5001) }, { title: ["a"] }, { title: "ok", classIds: [9999] }, { title: "ok", classIds: "nope" }]) {
    const r = await t.post("/api/teacher/homework", body); assert.ok([400, 404].includes(r.status), `${JSON.stringify(body)} -> ${r.status}`);
  }
  const bads = [["virus.exe", Buffer.from("MZ....")], ["page.html", Buffer.from("<script>1</script>")], ["fake.pdf", Buffer.from("not a pdf")], ["macro.docx", makeDocx({ "word/vbaProject.bin": "x" })], ["x.pdf", makePdf("/JavaScript 1 0 R")], ["empty.pdf", Buffer.alloc(0)]];
  for (const [name, buf] of bads) { const r = await t.post("/api/teacher/homework", { title: "Bad" }, { file: upload(buf, name, "application/pdf") }); assert.ok([400, 415].includes(r.status), `${name} -> ${r.status}`); }
  const huge = await t.post("/api/teacher/homework", { title: "Big" }, { file: upload(Buffer.concat([makePdf(), Buffer.alloc(16 * 1024 * 1024)]), "big.pdf", "application/pdf") });
  assert.equal(huge.status, 413);
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM homework")).n, 0, "rejected uploads must not leave homework rows");
  assert.equal(app.storage.buckets.get("studytrack-files")?.size ?? 0, 0, "...or storage objects");
  assert.ok((await app.db.one("SELECT COUNT(*) AS n FROM security_events WHERE type='upload_rejected'")).n >= 5, "rejections are audited");
  const none = await createTestApp({ withStorage: false }); const t2 = await mkTeacher(none, 1); await mkClass(t2, "P");
  assert.equal((await t2.post("/api/teacher/homework", { title: "x" }, { file: upload(makePdf(), "a.pdf") })).status, 503);
  assert.equal((await t2.post("/api/teacher/homework", { title: "text only still works without storage" })).status, 201);
  const noClass = await mkTeacher(app, 2); assert.equal((await noClass.post("/api/teacher/homework", { title: "x" })).body.code, "NO_CLASS");
});

test("one homework posted to several classes at once, each with its own stored copy", async () => {
  const app = await createTestApp();
  const t = await mkTeacher(app, 1), other = await mkTeacher(app, 2);
  const a = await mkClass(t, "A"), b = await mkClass(t, "B"), c = await mkClass(t, "C"), foreign = await mkClass(other, "F");
  const r = await t.post("/api/teacher/homework", { title: "Shared", classIds: JSON.stringify([a.id, b.id]) }, { file: upload(makePdf(), "s.pdf", "application/pdf") });
  assert.equal(r.status, 201); assert.deepEqual(r.body.created.map(x => x.class_id).sort(), [a.id, b.id].sort());
  const paths = (await app.db.many("SELECT file_path FROM homework")).map(x => x.file_path); assert.equal(new Set(paths).size, 2);
  assert.equal((await t.post("/api/teacher/homework", { title: "Sneaky", classIds: [a.id, foreign.id] })).status, 404, "cannot post into another teacher's class");
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM homework WHERE title='Sneaky'")).n, 0);
  assert.equal((await t.post("/api/teacher/homework", { title: "Too many", classIds: Array.from({ length: 11 }, (_, i) => i + 1) })).status, 400);
  const del = await t.delete(`/api/teacher/homework/${r.body.created[0].id}`); assert.equal(del.status, 200);
  assert.equal(app.storage.buckets.get("studytrack-files").size, 1, "deleting homework removes its file");
  assert.equal((await other.delete(`/api/teacher/homework/${r.body.created[1].id}`)).status, 404);
  assert.ok(c);
});

test("file downloads: only members of the owning class (or its teacher) get a short-lived signed link", async () => {
  const app = await createTestApp();
  const tA = await mkTeacher(app, 1), tB = await mkTeacher(app, 2);
  const clsA = await mkClass(tA, "A"), clsB = await mkClass(tB, "B"), sA = await mkStudent(app, 1), sB = await mkStudent(app, 2), outsider = await mkStudent(app, 3);
  await approveJoin(sA, tA, clsA); await approveJoin(sB, tB, clsB);
  const hwA = (await tA.post("/api/teacher/homework", { title: "Secret A" }, { file: upload(makePdf(), "a.pdf", "application/pdf"), headers: { "x-class-id": String(clsA.id) } })).body.created[0].id;
  const tst = (await tA.post("/api/teacher/tests", { title: "T", subject: "Phy", maxMarks: 50 }, { file: upload(makePng(), "t.png", "image/png") })).body.id;
  const ok = await sA.get(`/api/files/homework/${hwA}`);
  assert.equal(ok.status, 200); assert.match(ok.body.url, /^https:\/\/storage\.test\/studytrack-files\/t\d+\/c\d+\/homework\/.+\.pdf\?token=abc&exp=300&dl=a\.pdf$/); assert.equal(ok.body.expiresIn, 300);
  assert.equal((await tA.get(`/api/files/homework/${hwA}`)).status, 200);
  assert.equal((await sA.get(`/api/files/tests/${tst}`)).status, 200);
  for (const [who, name] of [[sB, "student of another institute"], [outsider, "student with no class"], [tB, "another teacher"]]) {
    const r = await who.get(`/api/files/homework/${hwA}`); assert.equal(r.status, 404, name); assert.equal(r.body.error, "File not found");
  }
  assert.equal((await sB.get("/api/files/tests/" + tst)).status, 404);
  assert.equal((await sA.get("/api/files/homework/99999")).status, 404, "unknown id looks identical to a forbidden one");
  assert.equal((await sA.get("/api/files/secrets/1")).status, 400);
  assert.equal((await sA.get("/api/files/homework/1%20OR%201=1")).status, 400);
  assert.equal((await sA.get("/api/files/homework/1;DROP")).status, 400);
  await tA.delete(`/api/teacher/students/${sA.id}`, inClass(clsA));
  assert.equal((await sA.get(`/api/files/homework/${hwA}`)).status, 404, "removed students lose access at once");
  await app.db.exec("UPDATE classes SET suspended=TRUE WHERE id=$1", [clsB.id]);
  const hwB = (await tB.post("/api/teacher/homework", { title: "x" }, { headers: { "x-class-id": String(clsB.id) } })).status; assert.equal(hwB, 403);
});

test("attach replaces the old file and cleans storage; bad attach keeps the old one", async () => {
  const app = await createTestApp(); const t = await mkTeacher(app, 1); await mkClass(t, "P");
  const id = (await t.post("/api/teacher/homework", { title: "H" }, { file: upload(makePdf(), "one.pdf", "application/pdf") })).body.created[0].id;
  const before = (await app.db.one("SELECT file_path FROM homework WHERE id=$1", [id])).file_path;
  assert.equal((await t.post(`/api/teacher/homework/${id}/attach`, {}, { file: upload(makePng(), "two.png", "image/png") })).status, 201);
  const after = await app.db.one("SELECT file_path,file_name FROM homework WHERE id=$1", [id]);
  assert.notEqual(after.file_path, before); assert.equal(after.file_name, "two.png");
  const bucket = app.storage.buckets.get("studytrack-files"); assert.equal(bucket.size, 1); assert.ok(bucket.has(after.file_path));
  assert.equal((await t.post(`/api/teacher/homework/${id}/attach`, {}, { file: upload(Buffer.from("MZ"), "x.exe") })).status, 415);
  assert.equal((await app.db.one("SELECT file_path FROM homework WHERE id=$1", [id])).file_path, after.file_path);
  assert.equal((await t.post(`/api/teacher/homework/${id}/attach`, {})).status, 400, "file required");
  const stranger = await mkTeacher(app, 2); await mkClass(stranger, "Q");
  assert.equal((await stranger.post(`/api/teacher/homework/${id}/attach`, {}, { file: upload(makePdf(), "a.pdf") })).status, 404);
});

test("institute storage quota is enforced on the real size", async () => {
  const app = await createTestApp(); const t = await mkTeacher(app, 1); await mkClass(t, "P");
  const inst = (await t.post("/api/institute/request", { instituteName: "Quota Academy", phone: "98765 43210" })).body.institute;
  await app.db.exec("UPDATE institutes SET status='active',storage_limit_mb=1 WHERE id=$1", [inst.id]);
  const big = makePdf(" ".repeat(700 * 1024));
  assert.equal((await t.post("/api/teacher/homework", { title: "1" }, { file: upload(big, "a.pdf", "application/pdf") })).status, 201);
  const r = await t.post("/api/teacher/homework", { title: "2" }, { file: upload(big, "b.pdf", "application/pdf") });
  assert.equal(r.status, 413); assert.equal(r.body.code, "STORAGE_LIMIT");
});

test("submitting homework: members only, late detection, resubmission, review, IDOR protection", async () => {
  const app = await createTestApp();
  const t = await mkTeacher(app, 1), t2 = await mkTeacher(app, 2); const cls = await mkClass(t, "P"), other = await mkClass(t2, "O");
  const s = await mkStudent(app, 1), outsider = await mkStudent(app, 2); await approveJoin(s, t, cls); await approveJoin(outsider, t2, other);
  const hw = (await t.post("/api/teacher/homework", { title: "H", dueDate: "2026-10-08" })).body.created[0].id;
  assert.equal((await outsider.post(`/api/student/homework/${hw}/submit`, { note: "hi" })).status, 404, "student of another class cannot submit");
  assert.equal((await s.post(`/api/student/homework/99999/submit`, { note: "x" })).status, 404);
  const first = await s.post(`/api/student/homework/${hw}/submit`, { note: "done" }); assert.equal(first.body.status, "submitted");
  app.setTime("2026-10-09T08:00:00.000Z");
  assert.equal((await s.post(`/api/student/homework/${hw}/submit`, { note: "redone" })).body.status, "late");
  assert.equal((await s.post(`/api/student/homework/${hw}/submit`, { note: "n".repeat(5001) })).status, 400);
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM homework_submissions")).n, 1);
  const subs = (await t.get(`/api/teacher/homework/${hw}/submissions`)).body; assert.equal(subs.submissions[0].note, "redone");
  assert.equal((await t2.get(`/api/teacher/homework/${hw}/submissions`)).status, 404);
  assert.equal((await t2.post(`/api/teacher/homework/${hw}/review`, { studentId: s.id, feedback: "x" })).status, 404, "other teacher cannot review");
  assert.equal((await t.post(`/api/teacher/homework/${hw}/review`, { studentId: outsider.id, feedback: "x" })).status, 404);
  assert.equal((await t.post(`/api/teacher/homework/${hw}/review`, { studentId: s.id, feedback: "Good work" })).status, 200);
  const view = (await s.get("/api/student/dashboard")).body.homework[0]; assert.equal(view.status, "reviewed"); assert.equal(view.feedback, "Good work");
  assert.ok((await s.get("/api/notifications")).body.notifications.some(n => n.type === "homework_reviewed"));
  assert.equal((await t.get("/api/teacher/overview")).body.homework[0].late_count, 1);
  const ov = (await t.get("/api/teacher/overview")).body; assert.equal(ov.studentSummary[0].homework_submitted, 1);
});

test("tests, marks, results, attendance and syllabus work per class and reject foreign ids", async () => {
  const app = await createTestApp();
  const t = await mkTeacher(app, 1), t2 = await mkTeacher(app, 2); const a = await mkClass(t, "A"), b = await mkClass(t, "B"), f = await mkClass(t2, "F");
  const s = await mkStudent(app, 1), s2 = await mkStudent(app, 2); await approveJoin(s, t, a); await approveJoin(s, t, b); await approveJoin(s2, t2, f);
  const test1 = (await t.post("/api/teacher/tests", { title: "Unit 1", subject: "Physics", maxMarks: 50, testDate: "2026-10-05" }, inClass(a))).body.id;
  const foreignTest = (await t2.post("/api/teacher/tests", { title: "F1", subject: "Bio", maxMarks: 20 })).body.id;
  assert.equal((await t.post("/api/teacher/marks", { testId: test1, studentId: s.id, marks: 40, remark: "ok" })).body.percentage, 80);
  assert.equal((await t.post("/api/teacher/marks", { testId: test1, studentId: s.id, marks: 45 })).status, 200, "marks can be corrected");
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM marks")).n, 1);
  for (const bad of [51, -1, "abc", null]) assert.equal((await t.post("/api/teacher/marks", { testId: test1, studentId: s.id, marks: bad })).status, 400);
  assert.equal((await t.post("/api/teacher/marks", { testId: foreignTest, studentId: s.id, marks: 5 })).status, 404, "teacher cannot grade another teacher's test");
  assert.equal((await t.post("/api/teacher/marks", { testId: test1, studentId: s2.id, marks: 5 })).status, 404, "student not in that class");
  assert.equal((await t.post("/api/teacher/tests", { title: "T", subject: "S", maxMarks: 0 })).status, 400);
  assert.equal((await t.post("/api/teacher/tests", { title: "T", subject: "S", maxMarks: 10.5 })).status, 400);
  const dash = (await s.get("/api/student/dashboard")).body; assert.equal(dash.tests.find(x => x.title === "Unit 1").percentage, 90); assert.equal(dash.stats.average_percentage, 90);
  const res = (await t.get("/api/teacher/results", inClass(a))).body; assert.equal(res.students[0].average_percentage, 90); assert.equal(res.tests[0].result_count, 1);
  assert.equal((await t.get("/api/teacher/results?from=2026-10-06", inClass(a))).body.students[0].test_count, 0);
  assert.equal((await t.get("/api/teacher/results?from=2026-13-01", inClass(a))).status, 400);
  assert.equal((await t.get("/api/teacher/results", { headers: { "x-class-id": String(f.id) } })).status, 404, "class header of another teacher is refused");
  assert.equal((await t.get("/api/teacher/results", { headers: { "x-class-id": "abc" } })).status, 404);
  // attendance is per class and day
  assert.equal((await t.post("/api/teacher/attendance", { date: "2026-10-07", records: [{ studentId: s.id, status: "present" }] }, inClass(a))).status, 200);
  assert.equal((await t.post("/api/teacher/attendance", { date: "2026-10-07", records: [{ studentId: s.id, status: "absent" }] }, inClass(b))).status, 200);
  assert.equal((await t.post("/api/teacher/attendance", { date: "2026-10-07", records: [{ studentId: s.id, status: "absent" }] }, inClass(a))).status, 200, "update, not duplicate");
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM attendance")).n, 2);
  assert.equal((await t.post("/api/teacher/attendance", { date: "2026-10-07", records: [{ studentId: s2.id, status: "present" }] }, inClass(a))).status, 404, "student not in this class");
  assert.equal((await t.post("/api/teacher/attendance", { date: "2026-10-07", records: [{ studentId: s.id, status: "late" }] }, inClass(a))).status, 400);
  assert.equal((await t.post("/api/teacher/attendance", { date: "2026-10-07", records: "x" }, inClass(a))).status, 400);
  assert.equal((await s.get(`/api/student/attendance?classId=${b.id}`)).body.present, 0);
  assert.equal((await s.get("/api/student/attendance")).body.recordedDays, 2);
  assert.equal((await t.get("/api/teacher/attendance?date=2026-10-07", inClass(a))).body.students[0].status, "absent");
  // syllabus
  assert.equal((await t.post("/api/teacher/syllabus", { subject: "Physics", chapter: "Kinematics", status: "completed" }, inClass(a))).status, 200);
  await t.post("/api/teacher/syllabus", { subject: "Physics", chapter: "Kinematics", status: "in-progress" }, inClass(a));
  assert.equal((await t.post("/api/teacher/syllabus", { subject: "Physics", chapter: "X", status: "done" }, inClass(a))).status, 400);
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM syllabus_chapters")).n, 1);
  const syl = (await s.get("/api/student/syllabus")).body.subjects; assert.equal(syl.length, 1); assert.equal(syl[0].class_name, "A"); assert.equal(syl[0].inProgress, 1);
  assert.equal((await s.get(`/api/student/syllabus?classId=${f.id}`)).status, 404);
});

test("teachers can only see students of their own classes (no IDOR on student analytics)", async () => {
  const app = await createTestApp();
  const t1 = await mkTeacher(app, 1), t2 = await mkTeacher(app, 2); const c1 = await mkClass(t1, "One"); await mkClass(t2, "Two");
  const s = await mkStudent(app, 1); await approveJoin(s, t1, c1);
  for (const sub of ["study", "analytics", "homework"]) { assert.equal((await t1.get(`/api/teacher/student/${s.id}/${sub}`)).status, 200, sub); assert.equal((await t2.get(`/api/teacher/student/${s.id}/${sub}`)).status, 404, `${sub} for foreign teacher`); }
  assert.equal((await t1.get(`/api/teacher/student/${t2.id}/study`)).status, 404, "a teacher id is not a student");
  assert.equal((await t1.get(`/api/teacher/student/abc/study`)).status, 400);
  assert.equal((await t2.get("/api/teacher/overview")).body.students.length, 0);
  assert.equal((await t2.delete(`/api/teacher/students/${s.id}`)).status, 404);
  assert.equal((await t2.get("/api/teacher/join-requests")).body.pending.length, 0);
  await s.post("/api/student/join-request", { classCode: c1.code });                 // pending approval is not membership
  const req = (await t1.get("/api/teacher/join-requests")).body.pending; assert.equal(req.length, 0, "already a member: no request shown");
});

test("study logs: validation, limits, ownership, teacher analytics", async () => {
  const app = await createTestApp(); const t = await mkTeacher(app, 1); const c = await mkClass(t, "P"); const s = await mkStudent(app, 1), s2 = await mkStudent(app, 2); await approveJoin(s, t, c);
  const log = body => s.post("/api/student/study-log", body);
  const good = { category: "self-study", subject: "Physics", minutes: 90, studyDate: "2026-10-07", note: "Kinematics" };
  assert.equal((await log(good)).status, 201);
  for (const bad of [{ ...good, category: "party" }, { ...good, minutes: 0 }, { ...good, minutes: 1441 }, { ...good, minutes: "x" }, { ...good, subject: "" }, { ...good, studyDate: "2030-01-01" }, { ...good, studyDate: "2026-02-30" }, { ...good, subject: { a: 1 } }, { ...good, minutes: 1400 }]) assert.equal((await log(bad)).status, 400, JSON.stringify(bad));
  const id = (await s.get("/api/student/dashboard")).body.logs[0].id;
  assert.equal((await s2.delete(`/api/student/study-log/${id}`)).status, 404, "cannot delete another student's log");
  assert.equal((await s.delete(`/api/student/study-log/${id}`)).status, 200);
  await log(good); await log({ ...good, subject: "Maths", minutes: 30 });
  const study = (await t.get(`/api/teacher/student/${s.id}/study?subject=Maths`)).body; assert.equal(study.total_minutes, 30);
  assert.equal((await t.get(`/api/teacher/student/${s.id}/study?category=bad`)).status, 400);
  const an = (await t.get(`/api/teacher/student/${s.id}/analytics`)).body; assert.equal(an.studyHours, 2); assert.equal(an.weeklyComparison[0].study_minutes, 120);
  const ov = (await t.get("/api/teacher/overview")).body; assert.equal(ov.metrics.today_hours, 2); assert.equal(ov.metrics.active_today, 1); assert.equal(ov.studentSummary[0].week_hours, 2);
  assert.equal((await s.get("/api/student/activity")).body.activity.length >= 0, true);
  assert.equal((await t.get("/api/teacher/activity")).body.activity.some(a => a.type === "study"), true);
});
