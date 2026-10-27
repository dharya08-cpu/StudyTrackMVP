// Google-only sign-in, sessions and account security.
import crypto from "node:crypto";
import { HttpError, v, cleanText } from "../validate.js";
import { assertVerifiedGmail } from "../google.js";
import { sha256, safeEqual, serializeCookie, csrfTokenFor } from "../security.js";
import { createSession, listSessions, revokeSession, revokeOtherSessions, revokeAllSessions } from "../sessions.js";
import { sessionCookieName, nonceCookieName } from "../auth.js";
import { getInstitute, instituteBlock, isUniqueViolation } from "../repo.js";

export const publicUser = u => ({
  id: u.id, name: u.name, email: u.email, role: u.role, institute_id: u.institute_id ?? null, institute_role: u.institute_role ?? null,
  profile_completed: Boolean(u.profile_completed_at ?? u.profile_completed), is_demo: Boolean(u.is_demo), has_password: Boolean(u.password_hash ?? u.has_password),
});

export function authRoutes(ctx, r) {
  const { db, config, clock, google, limiters, auth } = ctx;
  const cookieOpts = { secure: config.isProd, sameSite: "Strict" };
  const setSession = (res, value, maxAge) => res.append("Set-Cookie", serializeCookie(sessionCookieName(config), value, { ...cookieOpts, maxAgeSeconds: maxAge }));

  // Verifies a Google ID token bound to this browser's nonce, then applies the verified-Gmail rule.
  async function verifyGoogleLogin(req, credential) {
    const fail = async (error, why) => { limiters.login.fail(req); await ctx.audit(req, "login_failed", why); throw error; };
    const generic = () => new HttpError(401, "Google sign-in could not be verified. Please try again.", "GOOGLE_TOKEN_INVALID");
    const nonce = req.cookies?.[nonceCookieName(config)];
    if (!nonce) await fail(new HttpError(400, "Sign-in expired. Please refresh the page and try again.", "NONCE_MISSING"), "no nonce cookie");
    let claims;
    try { claims = await google.verify(credential); }
    catch (error) { if (error.status === 503) throw error; await fail(error, error.detail || "token rejected"); }
    if (!claims.nonce || !safeEqual(claims.nonce, nonce)) await fail(generic(), "nonce mismatch");
    const used = await db.exec("DELETE FROM login_nonces WHERE nonce_hash=$1 AND expires_at>$2", [sha256(nonce), clock.nowIso()]);
    if (used !== 1) await fail(generic(), "nonce replayed or expired");
    try { return assertVerifiedGmail(claims); }
    catch (error) { await ctx.audit(req, "login_rejected", "not a verified gmail account"); throw error; }
  }

  r.get("/api/auth/config", (req, res) => {
    res.json({ googleClientId: google.enabled ? config.googleClientId : "", googleEnabled: google.enabled, passwordEnabled: ctx.mailer.enabled, demoEnabled: config.allowDemo });
  });

  r.post("/api/auth/nonce", limiters.nonce.guard, async (req, res) => {
    const nonce = crypto.randomBytes(18).toString("base64url");
    await db.exec("INSERT INTO login_nonces(nonce_hash,expires_at) VALUES($1,$2)", [sha256(nonce), new Date(clock.now().getTime() + 5 * 60_000).toISOString()]);
    res.append("Set-Cookie", serializeCookie(nonceCookieName(config), nonce, { ...cookieOpts, maxAgeSeconds: 300 }));
    res.json({ nonce });
  });

  // mode "login": the account must already exist. mode "signup" (or a role is given): the account is created if it is new.
  r.post("/api/auth/google", limiters.login.guard, async (req, res) => {
    const mode = req.body?.mode === "login" || (req.body?.mode === undefined && req.body?.role === undefined) ? "login" : "signup";
    const role = mode === "signup" ? v.oneOf(req.body?.role, "Role", ["student", "teacher"]) : null;
    const identity = await verifyGoogleLogin(req, req.body?.credential);
    let user = await db.one("SELECT * FROM users WHERE google_sub=$1", [identity.sub]);
    if (!user) {
      user = await db.one("SELECT * FROM users WHERE email=$1", [identity.email]);
      if (user && user.google_sub && user.google_sub !== identity.sub) throw new HttpError(403, "This Gmail address is linked to a different Google account.", "ACCOUNT_CONFLICT");
    }
    let isNew = false;
    if (user) {
      if (role && user.role !== role) throw new HttpError(403, `This Gmail is registered as a ${user.role}. Please use the ${user.role} sign-in.`, "ROLE_MISMATCH");
      if (user.banned) throw new HttpError(403, "This account has been disabled. Please contact StudyTrack support.", "ACCOUNT_BANNED");
      if (user.role === "teacher" && user.institute_id) {
        const block = instituteBlock(await getInstitute(db, user.institute_id), "teacher");
        if (block) throw new HttpError(403, block.message, block.code);
      }
      await db.exec("UPDATE users SET google_sub=$1,last_login_at=$2,email_verified=TRUE WHERE id=$3", [identity.sub, clock.nowIso(), user.id]);
      // A password someone set before this address was proven to be theirs must not survive Google verifying it.
      if (!user.email_verified) { await db.exec("UPDATE users SET password_hash=NULL WHERE id=$1", [user.id]); user.password_hash = null; }
      // A renamed Gmail address follows the Google account, unless another StudyTrack account already uses it.
      if (user.email !== identity.email) await db.exec("UPDATE users SET email=$1 WHERE id=$2 AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.email=$1 AND u2.id<>$2)", [identity.email, user.id]);
      user.google_sub = identity.sub;
    } else {
      if (mode === "login") throw new HttpError(404, "No StudyTrack account found for this Gmail. Please sign up first.", "NO_ACCOUNT");
      try {
        user = await db.one("INSERT INTO users(google_sub,name,email,role,last_login_at,created_at) VALUES($1,$2,$3,$4,$5,$5) RETURNING *", [identity.sub, identity.name, identity.email, role, clock.nowIso()]);
        isNew = true;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        user = await db.one("SELECT * FROM users WHERE google_sub=$1", [identity.sub]); // two tabs signing in at once
        if (!user || user.role !== role) throw new HttpError(409, "Please try signing in again.");
      }
    }
    const session = await createSession(db, { userId: user.id, req, clock, config });
    setSession(res, session.cookieValue, session.maxAgeSeconds);
    await ctx.audit(req, isNew ? "signup" : "login", "google", user.id);
    res.json({ user: publicUser(user), csrfToken: csrfTokenFor(config.sessionSecret, session.id), isNew });
  });

  r.get("/api/me", auth, async (req, res) => {
    const institute = req.user.institute_id ? await getInstitute(db, req.user.institute_id) : null;
    res.json({
      user: publicUser(req.user),
      institute: institute && { id: institute.id, name: institute.name, code: institute.code, status: institute.status, control_mode: institute.control_mode, my_role: req.user.institute_role },
      csrfToken: csrfTokenFor(config.sessionSecret, req.session.id),
    });
  });

  r.post("/api/auth/logout", auth, async (req, res) => {
    await revokeSession(db, req.user.id, req.session.id, "logout", clock);
    setSession(res, "", 0);
    res.json({ ok: true });
  });
  r.post("/api/auth/logout-all", auth, async (req, res) => {
    const count = await revokeAllSessions(db, req.user.id, "logout everywhere", clock);
    setSession(res, "", 0);
    await ctx.audit(req, "logout_all", `${count} sessions`);
    res.json({ ok: true, revoked: count });
  });

  // ---- Security -> Active sessions ----
  r.get("/api/account/sessions", auth, async (req, res) => {
    res.json({ sessions: await listSessions(db, req.user.id, req.session.id, clock) });
  });
  r.delete("/api/account/sessions/:id", auth, async (req, res) => {
    const id = String(req.params.id || "");
    if (!/^[a-f0-9]{24}$/.test(id)) throw new HttpError(404, "Session not found");
    const count = await revokeSession(db, req.user.id, id, "revoked by user", clock); // scoped to the caller: no other user's session can be touched
    if (!count) throw new HttpError(404, "Session not found");
    if (id === req.session.id) setSession(res, "", 0);
    await ctx.audit(req, "session_revoked", "single");
    res.json({ ok: true });
  });
  r.post("/api/account/sessions/revoke-others", auth, async (req, res) => {
    const count = await revokeOtherSessions(db, req.user.id, req.session.id, "logged out other devices", clock);
    await ctx.audit(req, "sessions_revoked_others", `${count} sessions`);
    res.json({ ok: true, revoked: count });
  });

  // ---- Re-verification with Google ----
  r.post("/api/account/reauth", auth, limiters.login.guard, async (req, res) => {
    const identity = await verifyGoogleLogin(req, req.body?.credential);
    const me = await db.one("SELECT google_sub FROM users WHERE id=$1", [req.user.id]);
    if (!me.google_sub || me.google_sub !== identity.sub) throw new HttpError(403, "That is a different Google account. Please choose the account you signed in with.", "WRONG_ACCOUNT");
    await db.exec("UPDATE sessions SET last_reauth_at=$1 WHERE id=$2", [clock.nowIso(), req.session.id]);
    res.json({ ok: true });
  });
  // Changing the linked Gmail: the NEW Gmail must prove ownership with its own Google sign-in.
  r.post("/api/account/change-email", auth, ctx.requireRecentReauth, limiters.login.guard, async (req, res) => {
    if (req.user.is_demo) throw new HttpError(403, "Demo accounts can't change their e-mail.", "DEMO_LOCKED");
    const identity = await verifyGoogleLogin(req, req.body?.credential);
    const me = await db.one("SELECT * FROM users WHERE id=$1", [req.user.id]);
    if (identity.sub === me.google_sub) throw new HttpError(400, "That is already your linked Gmail.");
    const taken = await db.one("SELECT id FROM users WHERE (google_sub=$1 OR email=$2) AND id<>$3", [identity.sub, identity.email, me.id]);
    if (taken) throw new HttpError(409, "That Gmail is already used by another StudyTrack account.", "EMAIL_TAKEN");
    await db.tx(async t => {
      await t.exec("UPDATE users SET email=$1,google_sub=$2 WHERE id=$3", [identity.email, identity.sub, me.id]);
      await t.exec("UPDATE teacher_blocks SET student_email=$1 WHERE student_id=$2 AND student_email<>$1 AND NOT EXISTS (SELECT 1 FROM teacher_blocks b WHERE b.teacher_id=teacher_blocks.teacher_id AND b.student_email=$1)", [identity.email, me.id]);
      await revokeOtherSessions(t, me.id, req.session.id, "email changed", clock);
    });
    await ctx.audit(req, "email_changed", "linked Gmail changed");
    res.json({ ok: true, email: identity.email });
  });

  r.patch("/api/account/profile", auth, async (req, res) => {
    const name = v.str(req.body?.name, "Name", { min: 1, max: 100 });
    await db.exec("UPDATE users SET name=$1 WHERE id=$2", [name, req.user.id]);
    res.json({ ok: true, name });
  });
}
