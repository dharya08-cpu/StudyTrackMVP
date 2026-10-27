// Password accounts (sign up, e-mail verification, log in, forgot/reset/change password) and the one-time details page.
import { HttpError, v } from "../validate.js";
import { serializeCookie, csrfTokenFor } from "../security.js";
import { createSession, revokeAllSessions, revokeOtherSessions } from "../sessions.js";
import { sessionCookieName } from "../auth.js";
import { hashPassword, verifyPassword, burnPasswordCheck, assertStrongPassword } from "../passwords.js";
import { createEmailToken, consumeEmailToken } from "../tokens.js";
import { verificationEmail, resetEmail } from "../emails.js";
import { getInstitute, instituteBlock } from "../repo.js";
import { splitName, validateProfile, PROFILE_COLUMNS } from "../profile.js";
import { requestToJoin, createClassFor } from "../joins.js";
import { publicUser } from "./auth.js";

const GMAIL_RE = /^[a-z0-9._%+-]{1,64}@(gmail|googlemail)\.com$/;
export function assertGmailAddress(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!GMAIL_RE.test(email)) throw new HttpError(400, "Enter a valid Gmail address (it must end in @gmail.com).", "GMAIL_REQUIRED");
  return email;
}

export function accountRoutes(ctx, r) {
  const { db, config, clock, limiters, auth, mailer } = ctx;
  const cookieOpts = { secure: config.isProd, sameSite: "Strict" };
  const setSession = (res, value, maxAge) => res.append("Set-Cookie", serializeCookie(sessionCookieName(config), value, { ...cookieOpts, maxAgeSeconds: maxAge }));
  const linkBase = () => config.appOrigins[0];
  const requireMail = () => { if (!mailer.enabled) throw new HttpError(503, "Sign-up with a password isn't available right now. Please use Continue with Google.", "PASSWORD_SIGNUP_OFF"); };
  async function sendMail(req, to, message) {
    try { await mailer.send({ to, ...message }); }
    catch (error) { console.error("Mail failed:", error.message); await ctx.audit(req, "mail_failed", error.message); throw new HttpError(502, "We couldn't send the e-mail right now. Please try again in a few minutes.", "MAIL_FAILED"); }
  }
  async function startSession(req, res, user, event) {
    const session = await createSession(db, { userId: user.id, req, clock, config });
    setSession(res, session.cookieValue, session.maxAgeSeconds);
    await db.exec("UPDATE users SET last_login_at=$1 WHERE id=$2", [clock.nowIso(), user.id]);
    await ctx.audit(req, event, "password", user.id);
    return { user: publicUser(user), csrfToken: csrfTokenFor(config.sessionSecret, session.id) };
  }
  async function assertCanEnter(user) {
    if (user.banned) throw new HttpError(403, "This account has been disabled. Please contact StudyTrack support.", "ACCOUNT_BANNED");
    if (user.role === "teacher" && user.institute_id) {
      const block = instituteBlock(await getInstitute(db, user.institute_id), "teacher");
      if (block) throw new HttpError(403, block.message, block.code);
    }
  }

  // ---- Sign up (creates the account, then an e-mail link must be opened) ----
  r.post("/api/auth/register", limiters.register.guard, async (req, res) => {
    requireMail();
    const role = v.oneOf(req.body?.role, "Account type", ["student", "teacher"]);
    const email = assertGmailAddress(req.body?.email);
    const password = assertStrongPassword(req.body?.password, email);
    const existing = await db.one("SELECT * FROM users WHERE email=$1", [email]);
    if (existing && (existing.email_verified || existing.is_demo)) throw new HttpError(409, "An account with this Gmail already exists. Please log in.", "ACCOUNT_EXISTS");
    const hash = await hashPassword(password);
    let userId;
    if (existing) { // never verified: the newest sign-up replaces the old attempt (nothing is attached to it yet)
      await db.exec("UPDATE users SET password_hash=$1,role=$2,password_changed_at=$3 WHERE id=$4", [hash, role, clock.nowIso(), existing.id]);
      userId = existing.id;
    } else {
      const name = v.str(email.split("@")[0].slice(0, 60) || "New user", "Name", { min: 1, max: 100 });
      userId = (await db.one("INSERT INTO users(name,email,role,password_hash,password_changed_at,email_verified,created_at) VALUES($1,$2,$3,$4,$5,FALSE,$5) RETURNING id", [name, email, role, hash, clock.nowIso()])).id;
    }
    const token = await createEmailToken(db, clock, userId, "verify");
    await sendMail(req, email, verificationEmail(`${linkBase()}/verify?token=${token}`));
    await ctx.audit(req, "signup_started", role, userId);
    res.status(201).json({ ok: true, email, message: "We sent a verification link to your Gmail. Open it to finish creating your account." });
  });

  r.post("/api/auth/resend-verification", limiters.mailIp.guard, async (req, res) => {
    requireMail();
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const user = email && await db.one("SELECT id,email_verified,password_hash,is_demo FROM users WHERE email=$1", [email]);
    if (user && !user.email_verified && user.password_hash && !user.is_demo) {
      const token = await createEmailToken(db, clock, user.id, "verify");
      await sendMail(req, email, verificationEmail(`${linkBase()}/verify?token=${token}`));
    }
    res.json({ ok: true, message: "If that address is waiting for verification, we sent a new link." });
  });

  // Opening the link only shows a page; this POST is what verifies, so mail scanners that pre-open links cannot use up the token.
  r.post("/api/auth/verify-email", limiters.pwIp.guard, async (req, res) => {
    const userId = await consumeEmailToken(db, clock, req.body?.token, "verify");
    if (!userId) throw new HttpError(400, "This link is invalid or has expired. Please request a new one from the log-in page.", "TOKEN_INVALID");
    await db.exec("UPDATE users SET email_verified=TRUE WHERE id=$1", [userId]);
    const user = await db.one("SELECT * FROM users WHERE id=$1", [userId]);
    await assertCanEnter(user);
    res.json({ ...(await startSession(req, res, user, "verified")), isNew: !user.profile_completed_at });
  });

  // ---- Log in: Gmail + password only ----
  r.post("/api/auth/login", limiters.pwIp.guard, limiters.pwFail.guard, limiters.pwFailEmail.guard, async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!email || !password || email.length > 200 || password.length > 200) throw new HttpError(400, "Enter your Gmail and your password.", "MISSING_FIELDS");
    const user = await db.one("SELECT * FROM users WHERE email=$1", [email]);
    if (!user || (user.is_demo && !config.allowDemo)) {
      await burnPasswordCheck(password);
      throw new HttpError(404, "No StudyTrack account found for this Gmail. Please sign up first.", "NO_ACCOUNT");
    }
    if (!user.password_hash) throw new HttpError(400, "This account signs in with Google. Use Continue with Google, or choose Forgot password to create a password.", "NO_PASSWORD");
    if (!(await verifyPassword(password, user.password_hash))) {
      limiters.pwFail.fail(req); limiters.pwFailEmail.fail(req);
      await ctx.audit(req, "login_failed", "wrong password", user.id);
      throw new HttpError(401, "Incorrect password.", "WRONG_PASSWORD");
    }
    if (!user.email_verified) throw new HttpError(403, "Please verify your Gmail first. Open the link we sent when you signed up.", "EMAIL_NOT_VERIFIED");
    await assertCanEnter(user);
    res.json({ ...(await startSession(req, res, user, "login")), isNew: false });
  });

  // ---- Forgot / reset password ----
  r.post("/api/auth/forgot-password", limiters.mailIp.guard, async (req, res) => {
    requireMail();
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const user = email && await db.one("SELECT id,is_demo FROM users WHERE email=$1", [email]);
    if (user && !user.is_demo) {
      try { await sendMail(req, email, resetEmail(`${linkBase()}/reset?token=${await createEmailToken(db, clock, user.id, "reset")}`)); }
      catch (error) { if (error.code !== "MAIL_LIMIT") throw error; }
    }
    res.json({ ok: true, message: "If an account exists for that Gmail, we sent a link to reset the password." });
  });
  r.post("/api/auth/reset-password", limiters.pwIp.guard, async (req, res) => {
    assertStrongPassword(req.body?.password);
    const userId = await consumeEmailToken(db, clock, req.body?.token, "reset");
    if (!userId) throw new HttpError(400, "This link is invalid or has expired. Please request a new one.", "TOKEN_INVALID");
    const hash = await hashPassword(req.body.password);
    await db.exec("UPDATE users SET password_hash=$1,password_changed_at=$2,email_verified=TRUE WHERE id=$3", [hash, clock.nowIso(), userId]);
    await db.exec("UPDATE email_tokens SET used_at=$1 WHERE user_id=$2 AND purpose='reset' AND used_at IS NULL", [clock.nowIso(), userId]);
    await revokeAllSessions(db, userId, "password reset", clock);
    await ctx.audit(req, "password_reset", "", userId);
    res.json({ ok: true, message: "Your password was changed. Please log in." });
  });

  // ---- Change password (or add one to a Google-only account) ----
  r.post("/api/account/change-password", auth, async (req, res) => {
    if (req.user.is_demo) throw new HttpError(403, "Demo accounts can't change their password.", "DEMO_LOCKED");
    const me = await db.one("SELECT email,password_hash FROM users WHERE id=$1", [req.user.id]);
    if (me.password_hash) {
      await new Promise((resolve, reject) => limiters.changePw.guard(req, res, e => (e ? reject(e) : resolve())));
      if (typeof req.body?.currentPassword !== "string" || !(await verifyPassword(req.body.currentPassword, me.password_hash))) {
        limiters.changePw.fail(req);
        throw new HttpError(401, "Your current password is not correct.", "WRONG_PASSWORD");
      }
    } else await new Promise((resolve, reject) => ctx.requireRecentReauth(req, res, e => (e ? reject(e) : resolve()))); // Google-only account: confirm with Google first
    assertStrongPassword(req.body?.newPassword, me.email);
    await db.exec("UPDATE users SET password_hash=$1,password_changed_at=$2 WHERE id=$3", [await hashPassword(req.body.newPassword), clock.nowIso(), req.user.id]);
    const others = await revokeOtherSessions(db, req.user.id, req.session.id, "password changed", clock);
    await ctx.audit(req, "password_changed", `${others} other sessions signed out`);
    res.json({ ok: true, signedOutOthers: others });
  });

  // ---- The details page after sign-up (also lets people edit their details later) ----
  r.get("/api/profile", auth, async (req, res) => {
    const u = await db.one("SELECT * FROM users WHERE id=$1", [req.user.id]);
    const suggested = u.first_name || u.last_name ? { first_name: u.first_name, last_name: u.last_name } : splitName(u.google_sub ? u.name : "");
    res.json({ completed: Boolean(u.profile_completed_at), role: u.role, email: u.email, source: u.google_sub ? "google" : "password", suggested, profile: Object.fromEntries(PROFILE_COLUMNS.map(k => [k, u[k]])) });
  });

  r.put("/api/profile", auth, async (req, res) => {
    const p = validateProfile(req.user.role, req.body);
    const full = `${p.first_name} ${p.last_name}`.trim();
    await db.exec(`UPDATE users SET first_name=$1,last_name=$2,phone=$3,parent_name=$4,parent_phone=$5,grade=$6,school=$7,city=$8,subjects=$9,name=$10,profile_completed_at=COALESCE(profile_completed_at,$11) WHERE id=$12`,
      [p.first_name, p.last_name, p.phone, p.parent_name, p.parent_phone, p.grade, p.school, p.city, p.subjects, full, clock.nowIso(), req.user.id]);
    const out = {};
    // Optional extras never block saving the details: their result is reported next to it.
    if (req.user.role === "student" && req.body?.classCode) {
      try { out.join = { ok: true, ...(await requestToJoin(ctx, req.user, req.body.classCode)) }; } catch (e) { if (!(e instanceof HttpError)) throw e; out.join = { ok: false, error: e.message }; }
    }
    if (req.user.role === "teacher" && req.body?.className) {
      try { out.createdClass = { ok: true, ...(await createClassFor(ctx, req.user, { name: req.body.className, code: req.body.classCode })) }; } catch (e) { if (!(e instanceof HttpError)) throw e; out.createdClass = { ok: false, error: e.message }; }
    }
    res.json({ ok: true, user: publicUser(await db.one("SELECT * FROM users WHERE id=$1", [req.user.id])), ...out });
  });
}
