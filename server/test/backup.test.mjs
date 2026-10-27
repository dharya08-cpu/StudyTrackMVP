import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { createTestApp, createTestDb, Browser } from "./helpers.mjs";
import { createSnapshot, restoreSnapshot, verifySnapshot, parseSnapshot, BACKUP_TABLES } from "../src/backup.js";
import { applyMigrations } from "../src/migrate.js";
import { makePdf, upload } from "./fixtures.mjs";

async function populate(app) {
  const t = new Browser(app); await t.signIn({ sub: "t1", email: "t1@gmail.com", name: "Teacher", role: "teacher" });
  const cls = (await t.post("/api/teacher/classes", { name: "Physics 11" })).body;
  const s = new Browser(app); const sr = await s.signIn({ sub: "s1", email: "s1@gmail.com", name: "Ana", role: "student" });
  await app.db.exec("INSERT INTO student_class_memberships(student_id,class_id,status,joined_at) VALUES($1,$2,'active',$3)", [sr.body.user.id, cls.id, app.clock.nowIso()]);
  await t.post("/api/teacher/homework", { title: "HW", description: "Ünïcödé ✓ \"quotes\" 'single'", dueDate: "2026-10-12" }, { file: upload(makePdf(), "a.pdf", "application/pdf") });
  const test1 = (await t.post("/api/teacher/tests", { title: "T1", subject: "Phy", maxMarks: 50, testDate: "2026-10-01" })).body.id;
  await t.post("/api/teacher/marks", { testId: test1, studentId: sr.body.user.id, marks: 37.5, remark: "good" });
  await s.post("/api/student/study-log", { category: "self-study", subject: "Physics", minutes: 90, studyDate: "2026-10-07" });
  await s.put("/api/student/goals", { dailyMinutes: 240, weeklyMinutes: 1680 });
  await t.post("/api/teacher/announcements", { title: "Hi", body: "there", scope: "class", classIds: [cls.id] });
  await t.post("/api/teacher/schedule", { weekday: 3, startTime: "17:00", endTime: "18:00", subject: "Physics" });
  return { t, s, cls };
}
const dump = async db => Object.fromEntries(await Promise.all(BACKUP_TABLES.map(async x => [x, await db.many(`SELECT * FROM ${x} ORDER BY 1`)])));

test("backup -> restore round-trips every row exactly (incl. unicode, decimals, booleans, nulls)", async () => {
  const app = await createTestApp(); await populate(app);
  const snap = await createSnapshot(app.db, app.clock);
  assert.ok(snap.rowCounts.users === 2 && snap.rowCounts.homework === 1 && snap.rowCounts.marks === 1 && snap.rowCounts.notifications >= 2);
  const fresh = await createTestDb(); await applyMigrations(fresh);
  const out = await restoreSnapshot(snap.buffer, fresh, { expectedSha256: snap.sha256 });
  assert.equal(out.total, Object.values(snap.rowCounts).reduce((a, b) => a + b, 0));
  assert.deepEqual(await dump(fresh), await dump(app.db), "restored database must equal the original");
  const hw = await fresh.one("SELECT description FROM homework"); assert.equal(hw.description, "Ünïcödé ✓ \"quotes\" 'single'");
  assert.equal((await fresh.one("SELECT marks FROM marks")).marks, 37.5);
  // new rows after restore get fresh ids (no collisions)
  const maxBefore = (await fresh.one("SELECT MAX(id) AS m FROM users")).m;
  const newId = (await fresh.one("INSERT INTO users(name,email,role,created_at) VALUES('New','new@gmail.com','student',$1) RETURNING id", [app.clock.nowIso()])).id; assert.ok(newId > maxBefore);
});

test("backups never contain session secrets, nonces or the audit log", async () => {
  const app = await createTestApp(); await populate(app);
  const text = zlib.gunzipSync((await createSnapshot(app.db, app.clock)).buffer).toString();
  assert.ok(!text.includes("secret_hash") && !text.includes("nonce_hash") && !text.includes("\"t\":\"sessions\"") && !text.includes("security_events"));
  assert.ok((await app.db.one("SELECT COUNT(*) AS n FROM sessions")).n > 0);
});

test("a corrupted or tampered backup is detected, not silently restored", async () => {
  const app = await createTestApp(); await populate(app);
  const snap = await createSnapshot(app.db, app.clock);
  const fresh = async () => { const d = await createTestDb(); await applyMigrations(d); return d; };
  await assert.rejects(restoreSnapshot(snap.buffer, await fresh(), { expectedSha256: "0".repeat(64) }), /checksum/);
  await assert.rejects(restoreSnapshot(snap.buffer.subarray(0, 40), await fresh()), /gzip|valid/);
  const lines = zlib.gunzipSync(snap.buffer).toString().split("\n").filter(Boolean);
  const regz = ls => zlib.gzipSync(Buffer.from(ls.join("\n") + "\n"));
  const edited = lines.map(l => (l.includes('"t":"users"') ? l.replace("Teacher", "Hacker") : l));
  await assert.rejects(restoreSnapshot(regz(edited), await fresh()), /integrity check failed for table users/);
  await assert.rejects(restoreSnapshot(regz(lines.filter(l => !l.includes('"t":"marks"'))), await fresh()), /integrity check failed for table marks/);
  const inject = [...lines.slice(0, -1), JSON.stringify({ t: "users; DROP TABLE users;--", r: { id: 1 } }), lines.at(-1)];
  await assert.rejects(restoreSnapshot(regz(inject), await fresh()), /unknown table/);
  const colInject = lines.map(l => (l.includes('"t":"classes"') ? l.replace('"name"', '"name) VALUES (1); DROP TABLE users;--"') : l));
  await assert.rejects(restoreSnapshot(regz(colInject), await fresh()), /invalid column name/);
  await assert.rejects(restoreSnapshot(regz(lines.slice(0, -1)), await fresh()), /manifest/);
  const target = await fresh(); await restoreSnapshot(snap.buffer, target);
  await assert.rejects(restoreSnapshot(snap.buffer, target), /not empty/, "never silently overwrites an existing database");
  await restoreSnapshot(snap.buffer, target, { wipe: true });
  assert.equal((await target.one("SELECT COUNT(*) AS n FROM users")).n, 2, "wipe restore replaces the data");
  assert.throws(() => parseSnapshot(Buffer.from("junk")), /gzip/);
});

test("restore test (verify) uses a throw-away database and proves the backup works", async () => {
  const app = await createTestApp(); await populate(app);
  const snap = await createSnapshot(app.db, app.clock);
  const before = await dump(app.db);
  const out = await verifySnapshot(app.db, snap.buffer, snap.sha256); assert.equal(out.total, Object.values(snap.rowCounts).reduce((a, b) => a + b, 0));
  assert.deepEqual(await dump(app.db), before, "verification must never touch live data");
});

test("backup service: daily + weekly schedule, idempotent, retention, failure retry, weekly restore drill", async () => {
  const app = await createTestApp({ env: { BACKUP_DAILY_KEEP: "2", BACKUP_WEEKLY_KEEP: "1" }, startTime: "2026-10-07T08:00:00.000Z" }); await populate(app); // Wednesday
  const svc = app.ctx.backups;
  const first = await svc.tick(); assert.equal(first.daily.ok, true); assert.equal(first.weekly, undefined, "weekly runs on Sunday");
  assert.deepEqual(await svc.tick(), {}, "second tick the same day does nothing");
  const bucket = app.storage.buckets.get("studytrack-backups"); assert.equal(bucket.size, 1);
  app.setTime("2026-10-08T08:00:00.000Z"); assert.equal((await svc.tick()).daily.ok, true);
  app.setTime("2026-10-09T08:00:00.000Z"); assert.equal((await svc.tick()).daily.ok, true);
  assert.equal((await app.db.many("SELECT * FROM backup_runs WHERE kind='daily' AND status='ok'")).length, 2, "keeps only the newest 2 daily backups");
  assert.equal(bucket.size, 2, "old backup files are deleted from storage");
  app.setTime("2026-10-11T08:00:00.000Z"); // Sunday
  const sun = await svc.tick(); assert.equal(sun.daily.ok, true); assert.equal(sun.weekly.ok, true); assert.equal(sun.verify.ok, true, "weekly backup is test-restored automatically");
  const row = await app.db.one("SELECT * FROM backup_runs WHERE kind='weekly'"); assert.equal(row.verify_status, "ok"); assert.match(row.verify_detail, /restored into a temporary schema/); assert.ok(row.verified_at);
  const sum = await svc.summary(); assert.equal(sum.stale, false); assert.ok(sum.last_weekly && sum.last_daily && sum.last_verified); assert.equal(sum.runs[0].row_counts.users, 2);
  // concurrency: a second instance cannot run the same period
  assert.equal((await svc.run("daily")).skipped, true);
  // failure then retry after an hour
  app.setTime("2026-10-12T08:00:00.000Z"); const realUpload = app.storage.upload; app.storage.upload = async () => { throw new Error("storage down"); };
  const bad = await svc.tick(); assert.equal(bad.daily.ok, false); assert.match(bad.daily.error, /storage down/);
  assert.deepEqual(await svc.tick(), {}, "no immediate retry storm"); app.advance(61 * 60_000); app.storage.upload = realUpload;
  assert.equal((await svc.tick()).daily.ok, true, "retries once an hour has passed");
  assert.equal((await app.db.many("SELECT * FROM backup_runs WHERE period_key='daily:2026-10-12'")).length, 1);
  // interrupted run is cleaned up
  await app.db.exec("INSERT INTO backup_runs(period_key,kind,status,started_at) VALUES('manual:x','manual','running',$1)", [new Date(app.clock.now() - 3600_000).toISOString()]);
  await svc.tick(); assert.equal((await app.db.one("SELECT status FROM backup_runs WHERE period_key='manual:x'")).status, "failed");
  // no storage configured -> clear failure, never a crash
  const none = await createTestApp({ withStorage: false }); const r = await none.ctx.backups.run("manual"); assert.equal(r.ok, false); assert.match(r.error, /not configured/);
  assert.equal((await none.ctx.backups.summary()).stale, true);
});

test("a corrupted stored backup fails verification and says so", async () => {
  const app = await createTestApp(); await populate(app);
  const run = await app.ctx.backups.run("manual"); assert.equal(run.ok, true);
  assert.equal((await app.ctx.backups.verify(run.id)).ok, true);
  const bucket = app.storage.buckets.get("studytrack-backups"); const key = [...bucket.keys()][0]; const f = bucket.get(key); f.buf = Buffer.concat([f.buf.subarray(0, 50), Buffer.from([1, 2, 3]), f.buf.subarray(53)]);
  const bad = await app.ctx.backups.verify(run.id); assert.equal(bad.ok, false); assert.match(bad.error, /checksum|gzip/);
  const row = await app.db.one("SELECT verify_status FROM backup_runs WHERE id=$1", [run.id]); assert.equal(row.verify_status, "failed");
  assert.equal((await app.ctx.backups.verify(9999)).ok, false);
});

test("admin can run a backup and test-restore it from the panel API", async () => {
  const app = await createTestApp(); await populate(app);
  const a = new Browser(app); a.csrf = (await a.post("/api/admin/login", { key: "owner-key-123456" })).body.csrfToken;
  const run = await a.post("/api/admin/backups/run"); assert.equal(run.status, 201); assert.ok(run.body.size_bytes > 0);
  const v = await a.post(`/api/admin/backups/${run.body.id}/verify`); assert.equal(v.body.ok, true);
  const list = (await a.get("/api/admin/backups")).body; assert.equal(list.runs[0].verify_status, "ok"); assert.equal(list.stale, false);
  assert.equal(JSON.stringify(list).includes("storage_path"), false, "storage paths are not exposed");
  assert.equal((await a.post("/api/admin/backups/abc/verify")).status, 400);
  assert.equal((await new Browser(app).get("/api/admin/backups")).status, 401);
});
