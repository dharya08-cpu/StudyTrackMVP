// V6: many files per homework/test (every file stays viewable) and the student's own calendar.
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { createTestApp, createTestDb, Browser } from "./helpers.mjs";
import { makePdf, makePng, makeDocx, upload } from "./fixtures.mjs";
import { createSnapshot, restoreSnapshot } from "../src/backup.js";
import { applyMigrations } from "../src/migrate.js";
import { backfillLegacyFiles } from "../src/attachments.js";

const mkTeacher = async (app, n) => { const b = new Browser(app); const r = await b.signIn({ sub: `t${n}`, email: `t${n}@gmail.com`, name: `Teacher ${n}`, role: "teacher" }); assert.equal(r.status, 200); b.id = r.body.user.id; return b; };
const mkStudent = async (app, n) => { const b = new Browser(app); const r = await b.signIn({ sub: `s${n}`, email: `s${n}@gmail.com`, name: `Student ${n}`, role: "student" }); assert.equal(r.status, 200); b.id = r.body.user.id; return b; };
const mkClass = async (t, name) => { const r = await t.post("/api/teacher/classes", { name }); assert.equal(r.status, 201); return r.body; };
const enroll = (app, s, cls) => app.db.exec("INSERT INTO student_class_memberships(student_id,class_id,status,joined_at) VALUES($1,$2,'active',$3)", [s.id, cls.id, app.clock.nowIso()]);
const pdf = name => upload(makePdf(`% ${name}`), name, "application/pdf");
const png = name => upload(makePng(), name, "image/png");
const bucket = app => app.storage.buckets.get("studytrack-files");

test("THE FILE BUG: the first file stays viewable after more files are attached (homework)", async () => {
  const app = await createTestApp(); const t = await mkTeacher(app, 1); const cls = await mkClass(t, "Physics"); const s = await mkStudent(app, 1); await enroll(app, s, cls);
  const made = await t.post("/api/teacher/homework", { title: "Worksheet" }, { files: [pdf("first.pdf"), png("second.png")] });
  assert.equal(made.status, 201, JSON.stringify(made.body)); assert.deepEqual(made.body.fileNames, ["first.pdf", "second.png"]);
  const hw = made.body.created[0].id;
  for (const [name, f] of [["third.pdf", pdf("third.pdf")], ["fourth.png", png("fourth.png")]]) assert.equal((await t.post(`/api/teacher/homework/${hw}/attach`, {}, { file: f })).status, 201, name);

  const seen = (await s.get("/api/student/dashboard")).body.homework[0];
  assert.deepEqual(seen.attachments.map(a => a.name), ["first.pdf", "second.png", "third.pdf", "fourth.png"], "all four files are listed, oldest first");
  assert.equal(seen.has_file, true); assert.equal(seen.file_name, "first.pdf");
  assert.ok(seen.attachments.every(a => a.id && a.type && typeof a.viewable === "boolean" && a.size > 0));
  assert.equal(JSON.stringify(seen).includes("file_path"), false, "storage keys never reach the browser");

  // every single file can be opened, including the very first one
  for (const a of seen.attachments) {
    const r = await s.get(`/api/attachments/${a.id}`);
    assert.equal(r.status, 200, a.name); assert.equal(r.body.fileName, a.name);
    assert.match(r.body.url, /dl=($|&)/, "view link has no forced download name");
  }
  const dl = await s.get(`/api/attachments/${seen.attachments[0].id}?disposition=attachment`);
  assert.match(dl.body.url, /dl=first\.pdf/);
  assert.equal((await s.get(`/api/attachments/${seen.attachments[0].id}?disposition=sideways`)).status, 400);
  assert.equal(bucket(app).size, 4);
  const overview = (await t.get("/api/teacher/overview")).body.homework[0];
  assert.equal(overview.attachments.length, 4);
});

test("tests can carry many files too; removing one file keeps the rest", async () => {
  const app = await createTestApp(); const t = await mkTeacher(app, 1); const cls = await mkClass(t, "Chem"); const s = await mkStudent(app, 1); await enroll(app, s, cls);
  const made = await t.post("/api/teacher/tests", { title: "Unit 1", subject: "Chem", maxMarks: 50 }, { files: [pdf("paper.pdf"), pdf("solutions.pdf"), upload(makeDocx(), "notes.docx")] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal((await t.post(`/api/teacher/tests/${made.body.id}/attach`, {}, { file: png("scan.png") })).status, 201);
  const mine = (await s.get("/api/student/dashboard")).body.tests[0];
  assert.deepEqual(mine.attachments.map(a => a.name), ["paper.pdf", "solutions.pdf", "notes.docx", "scan.png"]);
  assert.deepEqual(mine.attachments.map(a => a.viewable), [true, true, false, true], "Word files can only be downloaded");

  assert.equal((await t.delete(`/api/teacher/attachments/${mine.attachments[1].id}`)).status, 200);
  const after = (await s.get("/api/student/dashboard")).body.tests[0];
  assert.deepEqual(after.attachments.map(a => a.name), ["paper.pdf", "notes.docx", "scan.png"]);
  assert.equal(bucket(app).size, 3, "the removed file is deleted from storage, the others stay");
  assert.equal((await s.get(`/api/attachments/${mine.attachments[1].id}`)).status, 404);
  assert.equal((await s.get(`/api/attachments/${mine.attachments[0].id}`)).status, 200);
});

test("file access: only the owning teacher and active members of the class; ids cannot be probed", async () => {
  const app = await createTestApp();
  const t = await mkTeacher(app, 1), other = await mkTeacher(app, 2); const cls = await mkClass(t, "A"); await mkClass(other, "B");
  const member = await mkStudent(app, 1), outsider = await mkStudent(app, 2); await enroll(app, member, cls);
  const hw = (await t.post("/api/teacher/homework", { title: "H" }, { files: [pdf("a.pdf")] })).body.created[0].id;
  const id = (await app.db.one("SELECT id FROM attachments WHERE homework_id=$1", [hw])).id;
  assert.equal((await member.get(`/api/attachments/${id}`)).status, 200);
  assert.equal((await t.get(`/api/attachments/${id}`)).status, 200);
  for (const [who, name] of [[outsider, "outsider"], [other, "other teacher"]]) { const r = await who.get(`/api/attachments/${id}`); assert.equal(r.status, 404, name); assert.equal(r.body.error, "File not found"); }
  assert.equal((await member.get("/api/attachments/99999")).status, 404, "unknown looks the same as forbidden");
  assert.equal((await member.get("/api/attachments/1%20OR%201=1")).status, 400);
  assert.equal((await app.request({ method: "GET", url: `/api/attachments/${id}` })).status, 401);
  assert.equal((await other.delete(`/api/teacher/attachments/${id}`)).status, 404, "another teacher cannot delete it");
  assert.equal((await member.delete(`/api/teacher/attachments/${id}`)).status, 403, "students cannot delete files");
  await app.db.exec("UPDATE student_class_memberships SET status='removed' WHERE student_id=$1", [member.id]);
  assert.equal((await member.get(`/api/attachments/${id}`)).status, 404, "removed students lose access at once");
  // the older URL still works and opens the first file as a download
  const legacy = await t.get(`/api/files/homework/${hw}`); assert.equal(legacy.status, 200); assert.match(legacy.body.url, /dl=a\.pdf/);
});

test("upload limits: 5 files per request, 10 per item, bad files reject the whole request", async () => {
  const app = await createTestApp(); const t = await mkTeacher(app, 1); await mkClass(t, "P");
  assert.equal((await t.post("/api/teacher/homework", { title: "six" }, { files: ["1", "2", "3", "4", "5", "6"].map(n => pdf(`${n}.pdf`)) })).status, 400);
  const bad = await t.post("/api/teacher/homework", { title: "one bad" }, { files: [pdf("ok.pdf"), upload(Buffer.from("MZ"), "evil.pdf", "application/pdf")] });
  assert.equal(bad.status, 415);
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM homework")).n, 0, "nothing was created");
  assert.equal(bucket(app)?.size ?? 0, 0, "nothing was stored");
  const id = (await t.post("/api/teacher/homework", { title: "cap" }, { files: [1, 2, 3, 4, 5].map(n => pdf(`a${n}.pdf`)) })).body.created[0].id;
  for (let n = 6; n <= 10; n++) assert.equal((await t.post(`/api/teacher/homework/${id}/attach`, {}, { file: pdf(`a${n}.pdf`) })).status, 201);
  const over = await t.post(`/api/teacher/homework/${id}/attach`, {}, { file: pdf("a11.pdf") });
  assert.equal(over.status, 400); assert.equal(over.body.code, "TOO_MANY_FILES");
  assert.equal(bucket(app).size, 10, "the refused file was not stored");
});

test("several classes each get their own copy of every file; deleting homework removes all its stored files", async () => {
  const app = await createTestApp(); const t = await mkTeacher(app, 1); const a = await mkClass(t, "A"), b = await mkClass(t, "B");
  const r = await t.post("/api/teacher/homework", { title: "Shared", classIds: JSON.stringify([a.id, b.id]) }, { files: [pdf("x.pdf"), png("y.png")] });
  assert.equal(r.status, 201); assert.equal(bucket(app).size, 4);
  assert.equal((await app.db.one("SELECT COUNT(DISTINCT file_path) AS n FROM attachments")).n, 4);
  assert.equal((await t.delete(`/api/teacher/homework/${r.body.created[0].id}`)).status, 200);
  assert.equal(bucket(app).size, 2); assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM attachments")).n, 2);
});

test("institute storage quota counts every attached file", async () => {
  const app = await createTestApp(); const t = await mkTeacher(app, 1); await mkClass(t, "P");
  const inst = (await t.post("/api/institute/request", { instituteName: "Quota Academy", phone: "98765 43210" })).body.institute;
  await app.db.exec("UPDATE institutes SET status='active',storage_limit_mb=1 WHERE id=$1", [inst.id]);
  const big = name => upload(makePdf(" ".repeat(400 * 1024)), name, "application/pdf");
  const id = (await t.post("/api/teacher/homework", { title: "1" }, { files: [big("a.pdf"), big("b.pdf")] })).body.created[0].id;
  const r = await t.post(`/api/teacher/homework/${id}/attach`, {}, { file: big("c.pdf") });
  assert.equal(r.status, 413); assert.equal(r.body.code, "STORAGE_LIMIT");
});

test("files from before V6 (old single-file columns) become attachments, and old backups still restore", async () => {
  const app = await createTestApp(); const t = await mkTeacher(app, 1); const cls = await mkClass(t, "Old"); const s = await mkStudent(app, 1); await enroll(app, s, cls);
  const hw = (await t.post("/api/teacher/homework", { title: "Legacy" })).body.created[0].id;
  const tst = (await t.post("/api/teacher/tests", { title: "T", subject: "S", maxMarks: 10 })).body.id;
  await app.storage.upload("studytrack-files", "t1/c1/homework/legacy.pdf", makePdf(), {});
  await app.db.exec("UPDATE homework SET file_path='t1/c1/homework/legacy.pdf',file_name='legacy.pdf',file_size=100,file_type='application/pdf' WHERE id=$1", [hw]);
  await app.db.exec("UPDATE tests SET file_path='t1/c1/tests/legacy-t.pdf',file_name='legacy-t.pdf',file_size=50,file_type='application/pdf' WHERE id=$1", [tst]);
  await backfillLegacyFiles(app.db);
  const seen = (await s.get("/api/student/dashboard")).body;
  assert.deepEqual(seen.homework[0].attachments.map(a => a.name), ["legacy.pdf"]); assert.deepEqual(seen.tests[0].attachments.map(a => a.name), ["legacy-t.pdf"]);
  assert.equal((await s.get(`/api/attachments/${seen.homework[0].attachments[0].id}`)).status, 200);

  // a backup written by the previous version has no attachments / student_plan_items tables in its manifest
  await app.db.exec("DELETE FROM attachments");
  const snap = await createSnapshot(app.db, app.clock);
  const lines = zlib.gunzipSync(snap.buffer).toString().split("\n").filter(Boolean);
  const manifest = JSON.parse(lines.pop()).manifest;
  delete manifest.tables.attachments; delete manifest.tables.student_plan_items;
  const old = zlib.gzipSync(Buffer.from([...lines.filter(l => !/^\{"t":"(attachments|student_plan_items)"/.test(l)), JSON.stringify({ manifest })].join("\n") + "\n"));
  const fresh = await createTestDb(); await applyMigrations(fresh);
  await restoreSnapshot(old, fresh);
  assert.deepEqual((await fresh.many("SELECT file_name FROM attachments ORDER BY id")).map(x => x.file_name), ["legacy.pdf", "legacy-t.pdf"], "old single files were turned into attachments");
});

test("a V6 backup carries attachments and calendar items through a restore", async () => {
  const app = await createTestApp(); const t = await mkTeacher(app, 1); const cls = await mkClass(t, "P"); const s = await mkStudent(app, 1); await enroll(app, s, cls);
  await t.post("/api/teacher/homework", { title: "H" }, { files: [pdf("a.pdf"), pdf("b.pdf")] });
  await s.post("/api/student/plan-items", { kind: "revision", title: "Revise optics", subject: "Physics", startDate: "2026-10-08", endDate: "2026-10-12" });
  const snap = await createSnapshot(app.db, app.clock);
  assert.equal(snap.rowCounts.attachments, 2); assert.equal(snap.rowCounts.student_plan_items, 1);
  const fresh = await createTestDb(); await applyMigrations(fresh);
  await restoreSnapshot(snap.buffer, fresh, { expectedSha256: snap.sha256 });
  assert.equal((await fresh.one("SELECT COUNT(*) AS n FROM attachments")).n, 2);
  assert.equal((await fresh.one("SELECT title FROM student_plan_items")).title, "Revise optics");
});

// ---------------------------------------------------------------------------------------------------------
// The student's own calendar
// ---------------------------------------------------------------------------------------------------------
const item = (o = {}) => ({ kind: "revision", title: "Finish Physics revision", subject: "Physics", startDate: "2026-10-07", endDate: "2026-10-12", ...o });

test("my calendar: add, list, edit, mark done, delete (all private to the student)", async () => {
  const app = await createTestApp(); const s = await mkStudent(app, 1), other = await mkStudent(app, 2);
  const made = await s.post("/api/student/plan-items", item({ notes: "Chapters 1 to 6", startTime: "18:00", endTime: "19:30" }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.item.id; assert.equal(made.body.item.done, false); assert.equal(made.body.item.start_time, "18:00");
  assert.equal((await s.post("/api/student/plan-items", item({ kind: "goal", title: "Read 20 pages a day", startDate: "2026-10-07", endDate: "2026-10-07" }))).status, 201);

  const list = (await s.get("/api/student/plan-items")).body; assert.equal(list.items.length, 2); assert.equal(list.today, "2026-10-07");
  assert.deepEqual(list.items.map(x => x.title), ["Read 20 pages a day", "Finish Physics revision"], "soonest deadline first");

  const edited = await s.patch(`/api/student/plan-items/${id}`, { title: "Finish Physics + Maths revision", endDate: "2026-10-15" });
  assert.equal(edited.status, 200); assert.equal(edited.body.item.end_date, "2026-10-15"); assert.equal(edited.body.item.subject, "Physics", "fields not sent stay as they were");
  const done = await s.patch(`/api/student/plan-items/${id}`, { done: true }); assert.equal(done.body.item.done, true); assert.ok(done.body.item.done_at);
  assert.equal((await s.get("/api/student/plan-items?status=open")).body.items.length, 1);
  assert.equal((await s.get("/api/student/plan-items?status=done")).body.items.length, 1);
  assert.equal((await s.patch(`/api/student/plan-items/${id}`, { done: false })).body.item.done, false);
  assert.equal((await s.patch(`/api/student/plan-items/${id}`, { done: "yes" })).status, 400);

  // privacy: nobody else can see, change or delete it; the id of someone else's item looks like a missing one
  assert.equal((await other.get("/api/student/plan-items")).body.items.length, 0);
  assert.equal((await other.patch(`/api/student/plan-items/${id}`, { title: "hijack" })).status, 404);
  assert.equal((await other.delete(`/api/student/plan-items/${id}`)).status, 404);
  const t = await mkTeacher(app, 1);
  assert.equal((await t.get("/api/student/plan-items")).status, 403, "teachers have no access");
  assert.equal((await app.request({ method: "GET", url: "/api/student/plan-items" })).status, 401);

  assert.equal((await s.delete(`/api/student/plan-items/${id}`)).status, 200);
  assert.equal((await s.get("/api/student/plan-items")).body.items.length, 1);
  assert.equal((await s.delete(`/api/student/plan-items/${id}`)).status, 404);
});

test("my calendar: validation", async () => {
  const app = await createTestApp(); const s = await mkStudent(app, 1);
  const bad = async (o, why) => assert.equal((await s.post("/api/student/plan-items", item(o))).status, 400, why);
  await bad({ kind: "party" }, "unknown type"); await bad({ title: "" }, "empty title"); await bad({ title: "x".repeat(121) }, "long title");
  await bad({ title: { $ne: 1 } }, "object title"); await bad({ startDate: "07/10/2026" }, "bad date"); await bad({ startDate: "2026-02-31" }, "impossible date");
  await bad({ startDate: "2026-10-12", endDate: "2026-10-07" }, "deadline before start"); await bad({ startDate: "2026-01-01", endDate: "2027-06-01" }, "over a year");
  await bad({ startTime: "25:00" }, "bad time"); await bad({ endTime: "19:00" }, "end time without a start"); await bad({ startTime: "19:00", endTime: "18:00" }, "end before start");
  await bad({ notes: "n".repeat(1001) }, "long notes"); await bad({ subject: "s".repeat(101) }, "long subject");
  const clean = await s.post("/api/student/plan-items", item({ title: "  Padded\u200B title  ", notes: "<b>x</b>\n\n\n\n\nend" }));
  assert.equal(clean.body.item.title, "Padded title", "zero-width characters are stripped and the text is trimmed");
  assert.equal((await s.post("/api/student/plan-items", { kind: "task", title: "Only a day", startDate: "2026-10-09" })).body.item.end_date, "2026-10-09", "the deadline defaults to the start day");
});

test("my calendar: at most 500 items", async () => {
  const app = await createTestApp(); const s = await mkStudent(app, 1);
  const rows = Array.from({ length: 500 }, (_, i) => `(${s.id},'task','t${i}','','', '2026-10-07','2026-10-07','${app.clock.nowIso()}','${app.clock.nowIso()}')`).join(",");
  await app.db.exec(`INSERT INTO student_plan_items(student_id,kind,title,subject,notes,start_date,end_date,created_at,updated_at) VALUES ${rows}`);
  assert.equal((await s.post("/api/student/plan-items", item())).status, 400);
});

test("my calendar shows on the student's own calendar only, on every day of its window with the deadline marked", async () => {
  const app = await createTestApp(); const t = await mkTeacher(app, 1); const cls = await mkClass(t, "Phys"); const s = await mkStudent(app, 1), other = await mkStudent(app, 2); await enroll(app, s, cls);
  await s.post("/api/student/plan-items", item({ startDate: "2026-10-08", endDate: "2026-10-10" }));
  const mine = (await s.get("/api/calendar?from=2026-10-05&to=2026-10-18")).body;
  const rev = mine.entries.filter(e => e.kind === "revision");
  assert.deepEqual(rev.map(e => e.date), ["2026-10-08", "2026-10-09", "2026-10-10"]);
  assert.deepEqual(rev.map(e => e.is_deadline), [false, false, true]); assert.ok(rev.every(e => e.item_id && e.done === false && e.detail === "Physics"));
  assert.equal(mine.today, "2026-10-07"); assert.equal(rev[0].notes, "", "notes travel with the entry so it can be edited from the calendar");
  // a class filter means "just that class": personal items are left out
  assert.equal((await s.get(`/api/calendar?from=2026-10-05&to=2026-10-18&classId=${cls.id}`)).body.entries.filter(e => e.kind === "revision").length, 0);
  assert.equal((await other.get("/api/calendar?from=2026-10-05&to=2026-10-18")).body.entries.filter(e => e.kind === "revision").length, 0, "other students do not see it");
  assert.equal((await t.get("/api/calendar?from=2026-10-05&to=2026-10-18")).body.entries.filter(e => e.kind === "revision").length, 0, "teachers do not see it");
  await s.patch(`/api/student/plan-items/${rev[0].item_id}`, { done: true });
  assert.ok((await s.get("/api/calendar?from=2026-10-05&to=2026-10-18")).body.entries.filter(e => e.kind === "revision").every(e => e.done));
});

test("an open revision goal pushes its subject up 'what to study today'; finishing it removes the push", async () => {
  const app = await createTestApp(); const s = await mkStudent(app, 1);
  await s.post("/api/student/study-log", { category: "self-study", subject: "Chemistry", minutes: 30, studyDate: "2026-10-07" });
  await s.post("/api/student/study-log", { category: "self-study", subject: "Physics", minutes: 30, studyDate: "2026-10-07" });
  const base = (await s.get("/api/student/planner")).body.suggestions.items;
  assert.ok(!base.some(i => i.reasons.some(r => /goal/i.test(r))));
  const g = (await s.post("/api/student/plan-items", item({ subject: "Physics", startDate: "2026-10-07", endDate: "2026-10-09" }))).body.item;
  const withGoal = (await s.get("/api/student/planner")).body.suggestions.items;
  const phys = withGoal.find(i => i.subject === "Physics"); assert.ok(phys, "Physics is suggested"); assert.ok(phys.reasons.some(r => /goal for this subject is due in 2 days/i.test(r)), JSON.stringify(phys));
  assert.equal(withGoal[0].subject, "Physics", "and it comes first");
  await s.patch(`/api/student/plan-items/${g.id}`, { done: true });
  assert.ok(!(await s.get("/api/student/planner")).body.suggestions.items.some(i => i.reasons.some(r => /goal/i.test(r))));
});
