import test from "node:test";
import assert from "node:assert/strict";
import { createTestApp, Browser } from "./helpers.mjs";

const PW = "Sunrise2026";
const verified = async (app, email = "ana@gmail.com", role = "student", password = PW) => {
  const b = new Browser(app); assert.equal((await b.register({ email, password, role })).status, 201);
  const v = await b.openMailLink(); assert.equal(v.status, 200, JSON.stringify(v.body)); return b;
};

test("sign up -> e-mail link -> verified and signed in -> details page is next", async () => {
  const app = await createTestApp(); const b = new Browser(app);
  const r = await b.register({ email: "Ana.K@Gmail.com", password: PW });
  assert.equal(r.status, 201); assert.equal(r.body.email, "ana.k@gmail.com");
  assert.equal(app.mail.sent.length, 1); assert.equal(app.mail.last().to, "ana.k@gmail.com"); assert.match(app.mail.last().subject, /Verify/);
  assert.match(app.mail.last().text, /http:\/\/localhost\/verify\?token=[A-Za-z0-9_-]{43}/);
  assert.equal(Boolean((await app.db.one("SELECT email_verified FROM users WHERE email='ana.k@gmail.com'")).email_verified), false);
  const stored = (await app.db.one("SELECT password_hash FROM users WHERE email='ana.k@gmail.com'")).password_hash;
  assert.ok(!stored.includes(PW), "stored as a hash"); assert.match(stored, /^scrypt\$/);
  assert.equal((await b.get("/api/me")).status, 401, "not signed in until the link is opened");
  const v = await b.openMailLink(); assert.equal(v.status, 200); assert.equal(v.body.isNew, true); assert.equal(v.body.user.profile_completed, false); assert.equal(v.body.user.role, "student");
  assert.equal((await b.get("/api/me")).status, 200);
  assert.equal((await new Browser(app).post("/api/auth/verify-email", { token: app.mail.token() })).status, 400, "a link works once");
});

test("sign-up rules: Gmail only, strong password, role, duplicates, resend, mail limit, mail outage", async () => {
  const app = await createTestApp({ limits: { register: 1000, mailIp: 1000 } }); const b = new Browser(app);
  for (const [email, password, role, code] of [["x@yahoo.com", PW, "student", "GMAIL_REQUIRED"], ["x@gmail.com.evil.com", PW, "student", "GMAIL_REQUIRED"], ["not-an-email", PW, "student", "GMAIL_REQUIRED"], ["", PW, "student", "GMAIL_REQUIRED"], ["x@coaching.com", PW, "student", "GMAIL_REQUIRED"], ["x@gmail.com", "short1", "student", "WEAK_PASSWORD"], ["x@gmail.com", "password123", "student", "WEAK_PASSWORD"], ["x@gmail.com", "onlyletters", "student", "WEAK_PASSWORD"], ["xavier@gmail.com", "xavier2026", "student", "WEAK_PASSWORD"]]) {
    const r = await b.register({ email, password, role }); assert.equal(r.status, 400, `${email}/${password}`); assert.equal(r.body.code, code);
  }
  assert.equal((await b.register({ email: "x@gmail.com", password: PW, role: "admin" })).status, 400);
  assert.equal((await b.post("/api/auth/register", { email: { $ne: "" }, password: PW, role: "student" })).status, 400);
  assert.equal(app.mail.sent.length, 0); assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM users")).n, 0, "nothing created for bad input");
  await verified(app, "taken@gmail.com");
  const dup = await b.register({ email: "taken@gmail.com", password: "Another2026" }); assert.equal(dup.status, 409); assert.equal(dup.body.code, "ACCOUNT_EXISTS");
  await b.register({ email: "half@gmail.com", password: PW, role: "student" }); const first = app.mail.token();
  assert.equal((await b.register({ email: "half@gmail.com", password: "Newer2026a", role: "teacher" })).status, 201, "the newest never-verified sign-up replaces the old one");
  assert.equal((await app.db.one("SELECT role FROM users WHERE email='half@gmail.com'")).role, "teacher");
  assert.equal((await new Browser(app).login("half@gmail.com", PW)).body.code, "WRONG_PASSWORD");
  assert.equal((await b.post("/api/auth/resend-verification", { email: "half@gmail.com" })).status, 200); assert.notEqual(app.mail.token(), first);
  const before = app.mail.sent.length; assert.equal((await b.post("/api/auth/resend-verification", { email: "nobody@gmail.com" })).status, 200); assert.equal(app.mail.sent.length, before, "no mail for unknown addresses");
  assert.equal((await b.post("/api/auth/resend-verification", { email: "taken@gmail.com" })).status, 200); assert.equal(app.mail.sent.length, before, "no mail for already verified accounts");
  for (let i = 0; i < 5; i++) await b.post("/api/auth/resend-verification", { email: "half@gmail.com" });
  assert.equal((await b.post("/api/auth/resend-verification", { email: "half@gmail.com" })).status, 429, "at most 5 links per account per hour");
  app.advance(3600_001); assert.equal((await b.post("/api/auth/resend-verification", { email: "half@gmail.com" })).status, 200);
  app.mail.failNext = true; const down = await b.register({ email: "late@gmail.com", password: PW }); assert.equal(down.status, 502); assert.equal(down.body.code, "MAIL_FAILED");
  assert.equal((await b.register({ email: "late@gmail.com", password: PW })).status, 201, "can retry after the outage");
  await b.register({ email: "slow@gmail.com", password: PW }); app.advance(25 * 3600_000);
  assert.equal((await b.openMailLink()).body.code, "TOKEN_INVALID", "links expire after 24 hours");
  assert.equal((await b.post("/api/auth/verify-email", { token: "x".repeat(43) })).status, 400); assert.equal((await b.post("/api/auth/verify-email", {})).status, 400);
});

test("LOG IN page: straight in when the password matches; clear messages otherwise", async () => {
  const app = await createTestApp(); await verified(app, "ana@gmail.com");
  const b = new Browser(app);
  const ok = await b.login("ana@gmail.com", PW); assert.equal(ok.status, 200); assert.equal(ok.body.user.email, "ana@gmail.com"); assert.equal(ok.body.isNew, false);
  assert.equal((await b.get("/api/me")).status, 200);
  assert.equal((await new Browser(app).login("ANA@gmail.com ", PW)).status, 200, "e-mail is case/space tolerant");
  const wrong = await new Browser(app).login("ana@gmail.com", "WrongPass1"); assert.equal(wrong.status, 401); assert.equal(wrong.body.error, "Incorrect password."); assert.equal(wrong.body.code, "WRONG_PASSWORD");
  const none = await new Browser(app).login("nobody@gmail.com", PW); assert.equal(none.status, 404); assert.equal(none.body.code, "NO_ACCOUNT"); assert.match(none.body.error, /No StudyTrack account found/);
  for (const [e, p] of [["", PW], ["ana@gmail.com", ""], [undefined, undefined], [{ a: 1 }, PW], ["ana@gmail.com", { $ne: 1 }], ["a".repeat(300) + "@gmail.com", PW]]) assert.equal((await new Browser(app).post("/api/auth/login", { email: e, password: p })).status, 400, JSON.stringify(e));
  assert.equal((await new Browser(app).post("/api/auth/login", { email: "ana@gmail.com", password: "x'; DROP TABLE users;--" })).status, 401);
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM users")).n, 1);
  const u = new Browser(app); await u.register({ email: "new@gmail.com", password: PW });
  const unv = await new Browser(app).login("new@gmail.com", PW); assert.equal(unv.status, 403); assert.equal(unv.body.code, "EMAIL_NOT_VERIFIED");
  assert.equal((await new Browser(app).login("new@gmail.com", "WrongPass1")).body.code, "WRONG_PASSWORD", "wrong password is reported before verification status");
  const ses = (await b.get("/api/account/sessions")).body.sessions; assert.equal(ses.filter(x => x.current).length, 1);
  await app.db.exec("UPDATE users SET banned=TRUE WHERE email='ana@gmail.com'"); assert.equal((await new Browser(app).login("ana@gmail.com", PW)).body.code, "ACCOUNT_BANNED");
});

test("brute force: lock-out per network+account and per account across networks", async () => {
  const app = await createTestApp(); await verified(app, "ana@gmail.com");
  const attacker = new Browser(app, { ip: "198.51.100.1" });
  const codes = []; for (let i = 0; i < 9; i++) codes.push((await attacker.login("ana@gmail.com", "Guess" + i + "xx")).status);
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 401, 401, 401, 429]);
  assert.equal((await attacker.login("ana@gmail.com", PW)).status, 429, "even the right password is refused while locked");
  assert.equal((await new Browser(app, { ip: "198.51.100.2" }).login("ana@gmail.com", PW)).status, 200, "the owner on another network can still log in");
  const stuffer = []; for (let i = 0; i < 25; i++) stuffer.push((await new Browser(app, { ip: `203.0.113.${i + 10}` }).login("ana@gmail.com", "Wrong" + i + "pw")).status);
  assert.ok(stuffer.includes(429), "many networks guessing one account are stopped");
  app.advance(3600_001); assert.equal((await new Browser(app, { ip: "198.51.100.9" }).login("ana@gmail.com", PW)).status, 200, "lock-out expires");
  const sprayer = new Browser(app, { ip: "192.0.2.50" }); const r = []; for (let i = 0; i < 70; i++) r.push((await sprayer.login(`user${i}@gmail.com`, PW)).status);
  assert.ok(r.includes(429), "one network trying many accounts is stopped");
});

test("account takeover defences: pre-registering someone's Gmail does not give access", async () => {
  const app = await createTestApp();
  const attacker = new Browser(app); await attacker.register({ email: "victim@gmail.com", password: "Attacker2026" });
  assert.equal((await new Browser(app).login("victim@gmail.com", "Attacker2026")).body.code, "EMAIL_NOT_VERIFIED");
  const victim = new Browser(app); const g = await victim.signIn({ sub: "g-victim", email: "victim@gmail.com", name: "Vic Tim", role: "student" });
  assert.equal(g.status, 200); assert.equal(g.body.isNew, false);
  const after = await new Browser(app).login("victim@gmail.com", "Attacker2026");
  assert.notEqual(after.status, 200, "the attacker's password was wiped when Google proved the address"); assert.equal(after.body.code, "NO_PASSWORD");
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM users")).n, 1);
  const b = await verified(app, "both@gmail.com"); const id = (await b.get("/api/me")).body.user.id;
  const g2 = await new Browser(app).signIn({ sub: "g-both", email: "both@gmail.com", role: "student" }); assert.equal(g2.body.user.id, id);
  assert.equal((await new Browser(app).login("both@gmail.com", PW)).status, 200, "a verified password account keeps its password after linking Google");
});

test("Google log in vs sign up: log in never creates accounts", async () => {
  const app = await createTestApp();
  const b = new Browser(app); const n = await b.post("/api/auth/nonce");
  const login = await b.post("/api/auth/google", { credential: app.token({ sub: "g1", email: "new@gmail.com", name: "New Person", nonce: n.body.nonce }), mode: "login" });
  assert.equal(login.status, 404); assert.equal(login.body.code, "NO_ACCOUNT"); assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM users")).n, 0);
  const n2 = await b.post("/api/auth/nonce");
  const signup = await b.post("/api/auth/google", { credential: app.token({ sub: "g1", email: "new@gmail.com", name: "New Person", nonce: n2.body.nonce }), mode: "signup", role: "teacher" });
  assert.equal(signup.status, 200); assert.equal(signup.body.isNew, true); assert.equal(signup.body.user.profile_completed, false);
  const again = new Browser(app); const n3 = await again.post("/api/auth/nonce");
  const second = await again.post("/api/auth/google", { credential: app.token({ sub: "g1", email: "new@gmail.com", nonce: n3.body.nonce }), mode: "login" });
  assert.equal(second.status, 200); assert.equal(second.body.user.role, "teacher", "log in needs no role");
  assert.equal((await new Browser(app).post("/api/auth/google", { credential: "x".repeat(40), mode: "signup" })).status, 400, "sign up needs a role");
});

test("forgot / reset / change password", async () => {
  const app = await createTestApp(); const b = await verified(app, "ana@gmail.com");
  const other = new Browser(app); await other.login("ana@gmail.com", PW);
  const f1 = await new Browser(app).post("/api/auth/forgot-password", { email: "ana@gmail.com" }), f2 = await new Browser(app).post("/api/auth/forgot-password", { email: "ghost@gmail.com" });
  assert.deepEqual(f1.body, f2.body, "same answer whether or not the account exists"); assert.equal(app.mail.sent.length, 2); assert.match(app.mail.last().subject, /Reset/);
  const sent = app.mail.sent.length; await new Browser(app).post("/api/auth/forgot-password", { email: "ghost@gmail.com" }); assert.equal(app.mail.sent.length, sent);
  const token = app.mail.token();
  const c = new Browser(app); assert.equal((await c.post("/api/auth/reset-password", { token, password: "short" })).body.code, "WEAK_PASSWORD");
  assert.equal((await c.post("/api/auth/reset-password", { token: "y".repeat(43), password: "Brand2026new" })).status, 400);
  assert.equal((await c.post("/api/auth/reset-password", { token, password: "Brand2026new" })).status, 200, "a weak attempt did not use up the link");
  assert.equal((await c.post("/api/auth/reset-password", { token, password: "Another2026x" })).status, 400, "links work once");
  assert.equal((await b.get("/api/me")).status, 401); assert.equal((await other.get("/api/me")).status, 401, "all devices signed out after a reset");
  assert.equal((await new Browser(app).login("ana@gmail.com", PW)).body.code, "WRONG_PASSWORD"); assert.equal((await new Browser(app).login("ana@gmail.com", "Brand2026new")).status, 200);
  const v = new Browser(app); await v.register({ email: "zed@gmail.com", password: PW }); const vt = app.mail.token();
  assert.equal((await c.post("/api/auth/reset-password", { token: vt, password: "Brand2026new" })).status, 400, "a verify link cannot reset a password");
  await new Browser(app).post("/api/auth/forgot-password", { email: "zed@gmail.com" }); assert.equal((await c.post("/api/auth/verify-email", { token: app.mail.token() })).status, 400, "a reset link cannot verify");
  const g = new Browser(app); await g.signIn({ sub: "g9", email: "goog@gmail.com", name: "Goog Le", role: "student" });
  assert.equal((await new Browser(app).login("goog@gmail.com", PW)).body.code, "NO_PASSWORD");
  await new Browser(app).post("/api/auth/forgot-password", { email: "goog@gmail.com" }); await c.post("/api/auth/reset-password", { token: app.mail.token(), password: "Goog2026pass" });
  assert.equal((await new Browser(app).login("goog@gmail.com", "Goog2026pass")).status, 200, "reset on a Google-only account creates a password");
  const d = new Browser(app); await d.login("ana@gmail.com", "Brand2026new"); const e = new Browser(app); await e.login("ana@gmail.com", "Brand2026new");
  assert.equal((await d.post("/api/account/change-password", { currentPassword: "nope", newPassword: "Fresh2026pw" })).body.code, "WRONG_PASSWORD");
  assert.equal((await d.post("/api/account/change-password", { currentPassword: "Brand2026new", newPassword: "weak" })).body.code, "WEAK_PASSWORD");
  const ch = await d.post("/api/account/change-password", { currentPassword: "Brand2026new", newPassword: "Fresh2026pw" }); assert.equal(ch.status, 200); assert.ok(ch.body.signedOutOthers >= 1);
  assert.equal((await e.get("/api/me")).status, 401); assert.equal((await d.get("/api/me")).status, 200); assert.equal((await new Browser(app).login("ana@gmail.com", "Fresh2026pw")).status, 200);
  const many = []; for (let i = 0; i < 6; i++) many.push((await d.post("/api/account/change-password", { currentPassword: "bad" + i, newPassword: "Fresh2026pw" })).status); assert.equal(many.at(-1), 429);
  const g3 = new Browser(app); await g3.signIn({ sub: "g3", email: "only.google@gmail.com", name: "Only Google", role: "student" });
  assert.equal((await g3.post("/api/account/change-password", { newPassword: "Added2026pw" })).status, 200);
  assert.equal(Boolean((await g3.get("/api/me")).body.user.has_password), true); assert.equal((await new Browser(app).login("only.google@gmail.com", "Added2026pw")).status, 200);
  const g4 = new Browser(app); await g4.signIn({ sub: "g4", email: "late.google@gmail.com", name: "Late Google", role: "student" });
  app.advance(11 * 60_000); assert.equal((await g4.post("/api/account/change-password", { newPassword: "Added2026px" })).body.code, "REAUTH_REQUIRED");
});

test("DETAILS PAGE: Google name is suggested for confirmation; student and teacher forms; completes once", async () => {
  const app = await createTestApp();
  const g = new Browser(app); await g.signIn({ sub: "g1", email: "ravi.k@gmail.com", name: "Ravi Kumar Sharma", role: "student" });
  const pre = (await g.get("/api/profile")).body; assert.equal(pre.completed, false); assert.equal(pre.source, "google"); assert.deepEqual(pre.suggested, { first_name: "Ravi Kumar", last_name: "Sharma" });
  const form = { firstName: "Ravi", lastName: "Sharma", parentName: "Suresh Sharma", parentPhone: "+91 98765 43210", grade: "Class 11", school: "Sunrise Public School", city: "Pune" };
  for (const bad of [{ firstName: "" }, { firstName: "R4vi" }, { lastName: "" }, { parentName: "" }, { parentName: "<script>" }, { grade: "" }, { phone: "abc" }, { parentPhone: "12" }, { firstName: { a: 1 } }, { firstName: "x".repeat(60) }]) assert.equal((await g.put("/api/profile", { ...form, ...bad })).status, 400, JSON.stringify(bad));
  assert.equal((await g.get("/api/me")).body.user.profile_completed, false);
  const ok = await g.put("/api/profile", form); assert.equal(ok.status, 200); assert.equal(ok.body.user.name, "Ravi Sharma"); assert.equal(ok.body.user.profile_completed, true);
  const row = await app.db.one("SELECT * FROM users WHERE email='ravi.k@gmail.com'"); assert.equal(row.parent_name, "Suresh Sharma"); assert.equal(row.grade, "Class 11"); assert.ok(row.profile_completed_at);
  const again = new Browser(app); const lg = await again.signIn({ sub: "g1", email: "ravi.k@gmail.com", role: "student" }); assert.equal(lg.body.user.profile_completed, true, "no details page on later log-ins");
  assert.equal((await g.put("/api/profile", { ...form, city: "Mumbai" })).status, 200); assert.equal((await g.get("/api/profile")).body.profile.city, "Mumbai");
  assert.equal((await new Browser(app).get("/api/profile")).status, 401);
  const u = new Browser(app); await u.signIn({ sub: "g2", email: "u@gmail.com", name: "Ünal", role: "student" }); assert.equal((await u.put("/api/profile", { ...form, firstName: "Ünal", lastName: "O’Brien-Çelik" })).status, 200, "unicode names");
  const t = new Browser(app); await t.signIn({ sub: "t1", email: "t@gmail.com", name: "Meera Iyer", role: "teacher" });
  assert.equal((await t.put("/api/profile", { firstName: "Meera", lastName: "Iyer" })).status, 400, "subjects required");
  const tr = await t.put("/api/profile", { firstName: "Meera", lastName: "Iyer", subjects: "Physics, Maths", school: "Bright Academy", phone: "98765 43210", className: "Physics 11", classCode: "phy11a" });
  assert.equal(tr.status, 200); assert.equal(tr.body.createdClass.ok, true); assert.equal(tr.body.createdClass.code, "PHY11A");
  assert.equal((await t.get("/api/teacher/context")).body.classes[0].name, "Physics 11");
  const t2 = new Browser(app); await t2.signIn({ sub: "t2", email: "t2@gmail.com", name: "Other Teacher", role: "teacher" });
  const clash = await t2.put("/api/profile", { firstName: "Other", lastName: "Teacher", subjects: "Maths", className: "Maths", classCode: "PHY11A" });
  assert.equal(clash.status, 200, "details are saved even if the class code is taken"); assert.equal(clash.body.createdClass.ok, false); assert.match(clash.body.createdClass.error, /already taken/);
  const s = new Browser(app); await s.signIn({ sub: "s9", email: "s9@gmail.com", name: "Kid One", role: "student" });
  const joined = await s.put("/api/profile", { ...form, firstName: "Kid", lastName: "One", classCode: "phy11a" }); assert.equal(joined.body.join.ok, true); assert.equal((await t.get("/api/teacher/join-requests")).body.pending.length, 1);
  const s2 = new Browser(app); await s2.signIn({ sub: "s10", email: "s10@gmail.com", name: "Kid Two", role: "student" });
  const bad = await s2.put("/api/profile", { ...form, firstName: "Kid", lastName: "Two", classCode: "NOPE99" }); assert.equal(bad.status, 200); assert.equal(bad.body.join.ok, false); assert.equal(bad.body.user.profile_completed, true);
  const p = await verified(app, "pw.user@gmail.com", "teacher"); const pp = (await p.get("/api/profile")).body; assert.equal(pp.source, "password"); assert.deepEqual(pp.suggested, { first_name: "", last_name: "" });
});

test("when no mail provider is configured, password sign-up is off but Google still works", async () => {
  const app = await createTestApp({ mailEnabled: false }); const b = new Browser(app);
  assert.equal((await app.request({ method: "GET", url: "/api/auth/config" })).body.passwordEnabled, false);
  assert.equal((await b.register({ email: "x@gmail.com", password: PW })).body.code, "PASSWORD_SIGNUP_OFF");
  assert.equal((await b.post("/api/auth/forgot-password", { email: "x@gmail.com" })).status, 503);
  assert.equal((await new Browser(app).signIn({ sub: "g", email: "g@gmail.com", role: "student" })).status, 200);
  const on = await createTestApp(); assert.equal((await on.request({ method: "GET", url: "/api/auth/config" })).body.passwordEnabled, true);
});
