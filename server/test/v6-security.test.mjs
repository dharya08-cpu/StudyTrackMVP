// V6 security and privacy: no account enumeration, stronger password hashing, data export, account deletion.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createTestApp, Browser } from "./helpers.mjs";
import { hashPassword, verifyPassword, needsRehash, assertStrongPassword, SCRYPT } from "../src/passwords.js";
import { buildCsp } from "../src/security.js";

const PW = "Sunrise2026";
const passwordUser = async (app, email = "ana@gmail.com", role = "student") => {
  const b = new Browser(app);
  assert.equal((await b.register({ email, password: PW, role })).status, 201);
  assert.equal((await b.openMailLink()).status, 200);
  b.id = (await b.get("/api/me")).body.user.id;
  return b;
};
const googleUser = async (app, n, role = "student") => { const b = new Browser(app); const r = await b.signIn({ sub: `g${n}`, email: `g${n}@gmail.com`, name: `G ${n}`, role }); assert.equal(r.status, 200); b.id = r.body.user.id; return b; };

test("password hashes: current settings, old hashes still verify, and are upgraded at the next log in", async () => {
  assert.deepEqual(SCRYPT, { N: 32768, R: 8, P: 2 });
  const fresh = await hashPassword(PW);
  assert.equal(needsRehash(fresh), false); assert.ok(await verifyPassword(PW, fresh)); assert.equal(await verifyPassword("Wrong2026pw", fresh), false);
  // a hash made by V4/V5 (N=2^14, p=1)
  const salt = crypto.randomBytes(16);
  const key = await new Promise((res, rej) => crypto.scrypt(PW.normalize("NFKC"), salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
  const legacy = `scrypt$16384$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
  assert.ok(await verifyPassword(PW, legacy), "old hashes keep working"); assert.equal(needsRehash(legacy), true);
  assert.equal(needsRehash("garbage"), false); assert.equal(needsRehash(null), false);

  const app = await createTestApp(); const b = await passwordUser(app);
  await app.db.exec("UPDATE users SET password_hash=$1 WHERE id=$2", [legacy, b.id]);
  assert.equal((await new Browser(app).login("ana@gmail.com", PW)).status, 200);
  const now = (await app.db.one("SELECT password_hash FROM users WHERE id=$1", [b.id])).password_hash;
  assert.equal(needsRehash(now), false, "the stored hash was upgraded"); assert.notEqual(now, legacy);
  assert.equal((await new Browser(app).login("ana@gmail.com", PW)).status, 200, "and the password still works");
  const wrongOnLegacy = await app.db.exec("UPDATE users SET password_hash=$1 WHERE id=$2", [legacy, b.id]);
  assert.equal(wrongOnLegacy, 1);
  assert.equal((await new Browser(app).login("ana@gmail.com", "Wrong2026pw")).status, 401);
  assert.equal((await app.db.one("SELECT password_hash FROM users WHERE id=$1", [b.id])).password_hash, legacy, "a wrong password never rewrites the hash");
});

test("password policy: 10+ characters, no common words dressed up with digits", () => {
  const weak = ["Abcdef12", "short1A", "Password2026", "Qwerty@12345", "Welcome#2026", "Studytrack99", "1234567890", "aaaaaaaaaa1", "Sunrise2026Sunrise2026Sunrise2026".repeat(4)];
  for (const p of weak) assert.throws(() => assertStrongPassword(p, "someone@gmail.com"), e => e.code === "WEAK_PASSWORD", p.slice(0, 20));
  assert.throws(() => assertStrongPassword("rahul2026abc", "rahul@gmail.com"), e => e.code === "WEAK_PASSWORD", "contains the e-mail name");
  for (const ok of ["Sunrise2026", "violet-Rivers-77", "my dog ate 3 pens"]) assert.equal(assertStrongPassword(ok, "x@gmail.com"), ok);
});

test("no account enumeration: unknown Gmail, wrong password and Google-only account are indistinguishable", async () => {
  const app = await createTestApp({ limits: { pwIp: 1000 } });
  await passwordUser(app, "real@gmail.com"); await passwordUser(app, "real2@gmail.com"); await googleUser(app, 1);
  const attempt = (email, pw = "Wrong2026pw") => new Browser(app).login(email, pw);
  const [wrong, unknown, googleOnly] = [await attempt("real@gmail.com"), await attempt("ghost@gmail.com"), await attempt("g1@gmail.com")];
  for (const r of [wrong, unknown, googleOnly]) assert.equal(r.status, 401);
  assert.deepEqual(unknown.body, wrong.body); assert.deepEqual(googleOnly.body, wrong.body);
  assert.equal(wrong.body.code, "INVALID_CREDENTIALS");
  // the lock-out kicks in after the same number of tries whether or not the account exists
  const countUntilLocked = async email => { let n = 0; while (n < 40) { const r = await new Browser(app).login(email, "Nope2026pw"); if (r.status === 429) return n; n++; } return n; };
  const real = await countUntilLocked("real2@gmail.com"), ghost = await countUntilLocked("ghost2@gmail.com");
  assert.equal(real, ghost, "lock-out timing does not reveal which Gmail has an account");
  assert.ok(real > 0 && real < 40);
});

test("security headers: tighter CSP and permissions policy", async () => {
  const app = await createTestApp();
  const r = await app.request({ method: "GET", url: "/api/health" });
  const csp = r.headers["content-security-policy"];
  for (const part of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "worker-src 'none'", "media-src 'none'", "base-uri 'none'", "form-action 'self'"]) assert.ok(csp.includes(part), part);
  assert.ok(!/unsafe-eval|unsafe-inline'?\s*(;|$)/.test(csp.replace("style-src-attr 'unsafe-inline'", "")), "no unsafe-eval; inline only for style attributes");
  assert.ok(!buildCsp({ isProd: false }).includes("upgrade-insecure-requests")); assert.ok(buildCsp({ isProd: true }).includes("upgrade-insecure-requests"));
  assert.match(r.headers["permissions-policy"], /interest-cohort=\(\)/); assert.match(r.headers["permissions-policy"], /camera=\(\)/);
  assert.equal(r.headers["x-frame-options"], "DENY"); assert.equal(r.headers["cache-control"], "no-store");
});

test("download my data: everything about me, nothing secret, nothing about anyone else", async () => {
  const app = await createTestApp(); const s = await passwordUser(app, "ana@gmail.com"), other = await googleUser(app, 9);
  await s.post("/api/student/study-log", { category: "self-study", subject: "Physics", minutes: 45, studyDate: "2026-10-07" });
  await s.post("/api/student/plan-items", { kind: "revision", title: "Revise optics", subject: "Physics", startDate: "2026-10-08", endDate: "2026-10-12" });
  await other.post("/api/student/study-log", { category: "self-study", subject: "SECRET-OTHER", minutes: 10, studyDate: "2026-10-07" });
  const r = await s.get("/api/account/export");
  assert.equal(r.status, 200); assert.match(r.headers["content-disposition"], /attachment; filename="studytrack-my-data\.json"/);
  assert.equal(r.body.account.email, "ana@gmail.com"); assert.equal(r.body.study_logs.length, 1); assert.equal(r.body.my_calendar[0].title, "Revise optics");
  assert.deepEqual(r.body.account.sign_in_methods, { google: false, password: true });
  const text = JSON.stringify(r.body);
  for (const secret of ["password_hash", "scrypt$", "secret_hash", "google_sub", "SECRET-OTHER", "g9@gmail.com"]) assert.ok(!text.includes(secret), `export must not contain ${secret}`);
  const t = await googleUser(app, 5, "teacher"); await t.post("/api/teacher/classes", { name: "Physics 11" });
  const tr = await t.get("/api/account/export"); assert.equal(tr.status, 200); assert.equal(tr.body.classes[0].name, "Physics 11"); assert.ok(!("study_logs" in tr.body));
  assert.equal((await app.request({ method: "GET", url: "/api/account/export" })).status, 401);
  // limited so it cannot be used to hammer the database
  let last; for (let i = 0; i < 8; i++) last = await s.get("/api/account/export");
  assert.equal(last.status, 429);
});

test("delete my account: needs DELETE + password, removes my data and my sessions, nothing else", async () => {
  const app = await createTestApp(); const s = await passwordUser(app, "ana@gmail.com"), keep = await passwordUser(app, "keep@gmail.com");
  await s.post("/api/student/study-log", { category: "self-study", subject: "Physics", minutes: 45, studyDate: "2026-10-07" });
  await s.post("/api/student/plan-items", { kind: "task", title: "T", startDate: "2026-10-08", endDate: "2026-10-08" });
  await keep.post("/api/student/study-log", { category: "self-study", subject: "Maths", minutes: 20, studyDate: "2026-10-07" });
  const bad = async (body, status, code) => { const x = await s.call("DELETE", "/api/account", body); assert.equal(x.status, status, JSON.stringify(body)); if (code) assert.equal(x.body.code, code); };
  await bad({ password: PW }, 400, "CONFIRM_REQUIRED"); await bad({ confirm: "delete", password: PW }, 400, "CONFIRM_REQUIRED");
  await bad({ confirm: "DELETE" }, 401, "WRONG_PASSWORD"); await bad({ confirm: "DELETE", password: "Wrong2026pw" }, 401, "WRONG_PASSWORD");
  assert.equal((await s.get("/api/me")).status, 200, "still there after refused attempts");

  const ok = await s.call("DELETE", "/api/account", { confirm: "DELETE", password: PW });
  assert.equal(ok.status, 200);
  assert.equal((await s.get("/api/me")).status, 401, "the session is gone");
  assert.equal((await new Browser(app).login("ana@gmail.com", PW)).status, 401, "and so is the account");
  for (const table of ["study_logs", "student_plan_items", "sessions"]) assert.equal((await app.db.one(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table === "sessions" ? "user_id" : "student_id"}=$1`, [s.id])).n, 0, table);
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM study_logs")).n, 1, "other people's data is untouched");
  assert.equal((await keep.get("/api/me")).status, 200);
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM security_events WHERE user_id=$1", [s.id])).n, 0, "the audit trail is no longer tied to the deleted account");
});

test("delete my account: a teacher's block-list address is erased, and teachers with classes or an institute are refused", async () => {
  const app = await createTestApp(); const t = await googleUser(app, 1, "teacher"); const cls = (await t.post("/api/teacher/classes", { name: "A" })).body;
  const s = await googleUser(app, 2);
  const join = await s.post("/api/student/join-request", { classCode: cls.code }); assert.equal(join.status, 201);
  const pending = (await t.get("/api/teacher/join-requests")).body.pending[0];
  assert.equal((await t.post(`/api/teacher/join-requests/${pending.id}/deny`, { mode: "block", confirm: true })).status, 200);
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM teacher_blocks WHERE student_email='g2@gmail.com'")).n, 1);
  assert.equal((await s.call("DELETE", "/api/account", { confirm: "DELETE" })).status, 200, "a Google-only account is allowed because the sign-in is fresh");
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM teacher_blocks WHERE student_email='g2@gmail.com'")).n, 0, "the student's address is no longer stored");
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM teacher_blocks")).n, 1, "the block itself stays");

  const r = await t.call("DELETE", "/api/account", { confirm: "DELETE" }); assert.equal(r.status, 409); assert.equal(r.body.code, "CLASSES_EXIST");
  await app.db.exec("DELETE FROM classes WHERE teacher_id=$1", [t.id]);
  await app.db.exec("UPDATE users SET institute_role='head' WHERE id=$1", [t.id]);
  assert.equal((await t.call("DELETE", "/api/account", { confirm: "DELETE" })).body.code, "INSTITUTE_HEAD");
  await app.db.exec("UPDATE users SET institute_role=NULL WHERE id=$1", [t.id]);
  assert.equal((await t.call("DELETE", "/api/account", { confirm: "DELETE" })).status, 200);
});

test("delete my account: Google-only accounts must have signed in with Google recently", async () => {
  const app = await createTestApp(); const g = await googleUser(app, 3);
  app.advance(11 * 60_000);
  const r = await g.call("DELETE", "/api/account", { confirm: "DELETE" });
  assert.equal(r.status, 403); assert.equal(r.body.code, "REAUTH_REQUIRED");
  assert.equal((await g.get("/api/me")).status, 200, "nothing was deleted");
});

test("demo accounts cannot be deleted or exported-and-deleted", async () => {
  const app = await createTestApp({ env: { ALLOW_DEMO: "true" } });
  const { seedDemo } = await import("../src/demo.js"); await seedDemo(app.ctx);
  const d = new Browser(app); assert.equal((await d.login("demostudent1@coaching.com", "demostudent1")).status, 200);
  const r = await d.call("DELETE", "/api/account", { confirm: "DELETE", password: "demostudent1" }); assert.equal(r.status, 403); assert.equal(r.body.code, "DEMO_LOCKED");
});
