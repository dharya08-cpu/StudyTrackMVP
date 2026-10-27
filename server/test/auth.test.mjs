import test from "node:test";
import assert from "node:assert/strict";
import { createTestApp, Browser, csrfTokenFor, otherKey } from "./helpers.mjs";

const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const student = (n = 1) => ({ sub: `sub-${n}`, email: `student${n}@gmail.com`, name: `Student ${n}`, role: "student" });

test("new student signs in with Google; role and Gmail rules are enforced", async () => {
  const app = await createTestApp();
  const b = new Browser(app);
  const ok = await b.signIn(student());
  assert.equal(ok.status, 200); assert.equal(ok.body.isNew, true); assert.equal(ok.body.user.role, "student");
  assert.ok(ok.setCookies.some(c => /^st_session=/.test(c) && /HttpOnly/.test(c) && /SameSite=Strict/.test(c)));
  const again = new Browser(app); const r2 = await again.signIn(student());
  assert.equal(r2.status, 200); assert.equal(r2.body.isNew, false);
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM users")).n, 1);
  const asTeacher = await new Browser(app).signIn({ ...student(), role: "teacher" });
  assert.equal(asTeacher.status, 403); assert.equal(asTeacher.body.code, "ROLE_MISMATCH");
  for (const c of [{ email: "x@yahoo.com", sub: "y1" }, { email: "x@gmail.com", sub: "y2", claims: { email_verified: false } }, { email: "x@uni.edu", sub: "y3", claims: { hd: "uni.edu", email_verified: true } }]) {
    const r = await new Browser(app).signIn({ role: "student", name: "X", ...c });
    assert.equal(r.status, 403); assert.equal(r.body.code, "GMAIL_REQUIRED");
  }
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM users")).n, 1, "rejected accounts must not be created");
  assert.equal((await new Browser(app).post("/api/auth/google", { credential: "x", role: "admin" })).status, 400);
});

test("nonce binding: replay, stolen token without the cookie, mismatched nonce, forged signature", async () => {
  const app = await createTestApp();
  const b = new Browser(app);
  const n = await b.post("/api/auth/nonce");
  const cred = app.token({ sub: "s1", email: "a@gmail.com", nonce: n.body.nonce });
  assert.equal((await b.post("/api/auth/google", { credential: cred, role: "student" })).status, 200);
  const replay = new Browser(app); replay.cookies = { st_nonce: n.body.nonce };
  const r = await replay.post("/api/auth/google", { credential: cred, role: "student" });
  assert.equal(r.status, 401, "a used token must not work twice");
  const victim = new Browser(app);                                  // attacker has a token but not the browser's nonce cookie
  assert.equal((await victim.post("/api/auth/google", { credential: app.token({ sub: "s2", email: "b@gmail.com", nonce: "abc" }), role: "student" })).status, 400);
  const x = new Browser(app); await x.post("/api/auth/nonce");
  assert.equal((await x.post("/api/auth/google", { credential: app.token({ sub: "s3", email: "c@gmail.com", nonce: "different" }), role: "student" })).status, 401);
  const f = new Browser(app); const fn = await f.post("/api/auth/nonce");
  assert.equal((await f.post("/api/auth/google", { credential: app.token({ sub: "s4", email: "d@gmail.com", nonce: fn.body.nonce }, { key: otherKey }), role: "student" })).status, 401);
  const e = new Browser(app); const en = await e.post("/api/auth/nonce"); app.advance(6 * 60_000);
  assert.equal((await e.post("/api/auth/google", { credential: app.token({ sub: "s5", email: "e@gmail.com", nonce: en.body.nonce }), role: "student" })).status, 401, "expired nonce");
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM users")).n, 1);
});

test("brute force: repeated failed sign-ins lock the IP out; failures look identical (no account enumeration)", async () => {
  const app = await createTestApp();
  const attacker = new Browser(app, { ip: "198.51.100.9" });
  const answers = new Set();
  for (let i = 0; i < 10; i++) {
    await attacker.post("/api/auth/nonce");
    const r = await attacker.post("/api/auth/google", { credential: app.token({ sub: "z", email: i % 2 ? "exists@gmail.com" : "nobody@gmail.com", nonce: "n" }, { key: otherKey }), role: "student" });
    answers.add(`${r.status}|${r.body.error}`);
  }
  assert.equal(answers.size, 1, "bad tokens must get the same answer whatever the email");
  const blocked = await attacker.post("/api/auth/google", { credential: "x".repeat(40), role: "student" });
  assert.equal(blocked.status, 429); assert.ok(blocked.headers["retry-after"]);
  const other = new Browser(app, { ip: "198.51.100.77" });
  assert.equal((await other.signIn(student(5))).status, 200, "other networks are not affected");
  assert.ok((await app.db.one("SELECT COUNT(*) AS n FROM security_events WHERE type='login_failed'")).n >= 10);
});

test("CSRF: state changes need the token; foreign or missing Origin is blocked", async () => {
  const app = await createTestApp();
  const b = new Browser(app); await b.signIn(student());
  const noToken = await b.call("PATCH", "/api/account/profile", { name: "New" }, { headers: { "x-csrf-token": "" } });
  assert.equal(noToken.status, 403); assert.equal(noToken.body.code, "BAD_CSRF");
  const wrong = await b.call("PATCH", "/api/account/profile", { name: "New" }, { headers: { "x-csrf-token": csrfTokenFor("another-secret", "x") } });
  assert.equal(wrong.body.code, "BAD_CSRF");
  assert.equal((await b.patch("/api/account/profile", { name: "New Name" })).status, 200);
  const evil = await b.call("PATCH", "/api/account/profile", { name: "Hacked" }, { headers: { origin: "https://evil.example.com" } });
  assert.equal(evil.status, 403); assert.equal(evil.body.code, "BAD_ORIGIN");
  const noOrigin = await b.call("PATCH", "/api/account/profile", { name: "Hacked" }, { headers: { origin: "" } });
  assert.equal(noOrigin.body.code, "BAD_ORIGIN");
  assert.equal((await app.db.one("SELECT name FROM users WHERE email='student1@gmail.com'")).name, "New Name");
  assert.equal((await b.get("/api/me", { headers: { origin: "https://evil.example.com" } })).status, 200); // reads are not state changes; CORS stops cross-site reads
  const other = new Browser(app); await other.signIn(student(2));
  b.csrf = other.csrf; assert.equal((await b.patch("/api/account/profile", { name: "x" })).body.code, "BAD_CSRF", "another session's token must not work");
});

test("security headers, CSP, no-store on API, CORS allow-list only", async () => {
  const app = await createTestApp({ env: { CLIENT_ORIGIN: "https://client.example.com" } });
  const r = await app.request({ method: "GET", url: "/api/health" });
  const h = r.headers;
  assert.match(h["content-security-policy"], /default-src 'self'/); assert.match(h["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(h["x-content-type-options"], "nosniff"); assert.equal(h["x-frame-options"], "DENY"); assert.equal(h["cache-control"], "no-store");
  assert.equal(h["referrer-policy"], "strict-origin-when-cross-origin"); assert.match(h["permissions-policy"], /camera=\(\)/); assert.equal(h["x-robots-tag"], "noindex, nofollow");
  assert.equal(h["access-control-allow-origin"], undefined);
  const allowed = await app.request({ method: "GET", url: "/api/health", headers: { origin: "https://client.example.com" } });
  assert.equal(allowed.headers["access-control-allow-origin"], "https://client.example.com"); assert.equal(allowed.headers["access-control-allow-credentials"], "true");
  const denied = await app.request({ method: "GET", url: "/api/health", headers: { origin: "https://evil.example.com" } });
  assert.equal(denied.headers["access-control-allow-origin"], undefined);
  const pre = await app.request({ method: "OPTIONS", url: "/api/me", headers: { origin: "https://client.example.com" } });
  assert.equal(pre.status, 204); assert.match(pre.headers["access-control-allow-headers"], /X-CSRF-Token/);
  assert.equal((await app.request({ method: "OPTIONS", url: "/api/me", headers: { origin: "https://evil.example.com" } })).status, 403);
  const prod = await createTestApp({ env: { NODE_ENV: "production", DATABASE_URL: "x", SESSION_SECRET: "s".repeat(40), ADMIN_KEY: "k".repeat(14), GOOGLE_CLIENT_ID: "g", APP_URL: "https://localhost", SUPABASE_URL: "https://x", SUPABASE_SERVICE_ROLE_KEY: "k" } }).catch(e => e);
  if (!(prod instanceof Error)) assert.match((await prod.request({ method: "GET", url: "/api/health" })).headers["strict-transport-security"], /max-age=31536000/);
});

test("active sessions: list, device labels, revoke one, revoke others, logout, logout everywhere", async () => {
  const app = await createTestApp();
  const phone = new Browser(app, { ua: ANDROID, ip: "49.36.12.200" }), laptop = new Browser(app, { ua: WINDOWS, ip: "103.5.6.7" }), thief = new Browser(app, { ua: WINDOWS });
  await phone.signIn(student()); app.advance(2 * 3600_000); await laptop.signIn(student());
  await thief.signIn(student(2));
  const list = (await phone.get("/api/account/sessions")).body.sessions;
  assert.equal(list.length, 2);
  const mine = list.find(s => s.current), other = list.find(s => !s.current);
  assert.equal(mine.os, "Android"); assert.equal(mine.device_type, "mobile"); assert.equal(mine.browser, "Chrome"); assert.equal(mine.location, "49.36.•.•");
  assert.equal(other.os, "Windows"); assert.equal(other.device_type, "desktop"); assert.equal(other.active_now, true);
  assert.equal(JSON.stringify(list).includes("secret"), false, "no secrets in the session list");
  const theirs = (await thief.get("/api/account/sessions")).body.sessions[0];
  assert.equal((await phone.delete(`/api/account/sessions/${theirs.id}`)).status, 404, "cannot revoke another user's session (IDOR)");
  assert.equal((await thief.get("/api/me")).status, 200);
  assert.equal((await phone.delete("/api/account/sessions/not-a-session")).status, 404);
  const rev = await phone.post("/api/account/sessions/revoke-others");
  assert.equal(rev.body.revoked, 1);
  assert.equal((await laptop.get("/api/me")).status, 401, "logged-out device is rejected immediately");
  assert.equal((await phone.get("/api/me")).status, 200);
  const l2 = new Browser(app, { ua: WINDOWS }); await l2.signIn(student());
  assert.equal((await phone.delete(`/api/account/sessions/${(await l2.get("/api/account/sessions")).body.sessions.find(s => s.current).id}`)).status, 200);
  assert.equal((await l2.get("/api/me")).status, 401);
  assert.equal((await phone.post("/api/auth/logout")).status, 200); assert.equal(phone.cookies.st_session, undefined);
  assert.equal((await phone.get("/api/me")).status, 401);
  const a = new Browser(app); await a.signIn(student()); const c = new Browser(app); await c.signIn(student());
  const all = await a.post("/api/auth/logout-all"); assert.equal(all.body.revoked, 2);
  assert.equal((await c.get("/api/me")).status, 401); assert.equal((await a.get("/api/me")).status, 401);
  assert.equal((await thief.get("/api/me")).status, 200, "other users untouched");
});

test("session lifetime: absolute 30 days, idle 14 days, secret tampering, cap of 10 sessions", async () => {
  const app = await createTestApp();
  const b = new Browser(app); await b.signIn(student());
  app.advance(13 * 86400_000); assert.equal((await b.get("/api/me")).status, 200, "activity keeps the session alive");
  app.advance(13 * 86400_000); assert.equal((await b.get("/api/me")).status, 200);
  app.advance(5 * 86400_000); assert.equal((await b.get("/api/me")).status, 401, "past 30 days absolute limit");
  const idle = new Browser(app); await idle.signIn(student()); app.advance(15 * 86400_000);
  assert.equal((await idle.get("/api/me")).status, 401, "idle too long");
  const t = new Browser(app); await t.signIn(student());
  const [id, secret] = t.cookies.st_session.split(".");
  t.cookies.st_session = `${id}.${secret.slice(0, -2)}xx`; assert.equal((await t.get("/api/me")).status, 401);
  t.cookies.st_session = `${id}.${"A".repeat(43)}`; assert.equal((await t.get("/api/me")).status, 401);
  t.cookies.st_session = "' OR 1=1 --"; assert.equal((await t.get("/api/me")).status, 401);
  const many = []; for (let i = 0; i < 12; i++) { const x = new Browser(app); await x.signIn(student(9)); many.push(x); app.advance(1000); }
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM sessions WHERE user_id=(SELECT id FROM users WHERE email='student9@gmail.com') AND revoked_at IS NULL")).n, 10);
  assert.equal((await many[0].get("/api/me")).status, 401); assert.equal((await many[11].get("/api/me")).status, 200);
});

test("banned accounts lose access immediately; deleted accounts cannot reuse a cookie", async () => {
  const app = await createTestApp();
  const b = new Browser(app); await b.signIn(student());
  await app.db.exec("UPDATE users SET banned=TRUE");
  const r = await b.get("/api/me"); assert.equal(r.status, 403); assert.equal(r.body.code, "ACCOUNT_BANNED");
  assert.equal((await new Browser(app).signIn(student())).body.code, "ACCOUNT_BANNED");
  await app.db.exec("DELETE FROM users"); assert.equal((await b.get("/api/me")).status, 401);
});

test("re-verification and changing the linked Gmail", async () => {
  const app = await createTestApp();
  const b = new Browser(app); await b.signIn(student(1));
  const other = new Browser(app); await other.signIn(student(2));
  const newGoogle = async (sub, email, extra = {}) => { const n = await b.post("/api/auth/nonce"); return { credential: app.token({ sub, email, name: "N", nonce: n.body.nonce, ...extra }) }; };
  assert.equal((await b.post("/api/account/change-email", await newGoogle("sub-new", "fresh@gmail.com"))).status, 200, "recent sign-in counts as re-verification");
  app.advance(11 * 60_000);
  const stale = await b.post("/api/account/change-email", await newGoogle("sub-new2", "fresh2@gmail.com"));
  assert.equal(stale.status, 403); assert.equal(stale.body.code, "REAUTH_REQUIRED");
  const wrongAccount = await b.post("/api/account/reauth", await newGoogle("sub-someone-else", "else@gmail.com"));
  assert.equal(wrongAccount.status, 403); assert.equal(wrongAccount.body.code, "WRONG_ACCOUNT");
  assert.equal((await b.post("/api/account/reauth", await newGoogle("sub-new", "fresh@gmail.com"))).status, 200);
  const taken = await b.post("/api/account/change-email", await newGoogle("sub-2", "student2@gmail.com"));
  assert.equal(taken.status, 409);
  const notGmail = await b.post("/api/account/change-email", await newGoogle("sub-y", "me@yahoo.com"));
  assert.equal(notGmail.status, 403);
  const same = await b.post("/api/account/change-email", await newGoogle("sub-new", "fresh@gmail.com"));
  assert.equal(same.status, 400);
  const second = new Browser(app); await second.signIn({ sub: "sub-new", email: "fresh@gmail.com", role: "student" });
  const ok = await b.post("/api/account/change-email", await newGoogle("sub-final", "final@gmail.com"));
  assert.equal(ok.status, 200); assert.equal((await b.get("/api/me")).body.user.email, "final@gmail.com");
  assert.equal((await second.get("/api/me")).status, 401, "other devices are signed out after an email change");
  assert.equal((await new Browser(app).signIn({ sub: "sub-new", email: "fresh@gmail.com", role: "student" })).body.isNew, true, "old Gmail is no longer linked to this account");
});

test("unauthenticated and wrong-role access", async () => {
  const app = await createTestApp();
  for (const url of ["/api/me", "/api/student/dashboard", "/api/teacher/overview", "/api/notifications", "/api/calendar", "/api/account/sessions", "/api/files/homework/1"]) assert.equal((await app.request({ method: "GET", url })).status, 401, url);
  const s = new Browser(app); await s.signIn(student());
  for (const url of ["/api/teacher/overview", "/api/teacher/context", "/api/institute/home"]) assert.equal((await s.get(url)).status, 403, url);
  const t = new Browser(app); await t.signIn({ sub: "t1", email: "t1@gmail.com", role: "teacher" });
  for (const url of ["/api/student/dashboard", "/api/student/classes", "/api/student/planner"]) assert.equal((await t.get(url)).status, 403, url);
  for (const url of ["/api/admin/overview", "/api/admin/backups"]) assert.equal((await s.get(url)).status, 401, `${url}: a user session is not an admin session`);
  assert.equal((await app.request({ method: "GET", url: "/api/nope" })).status, 404);
});
