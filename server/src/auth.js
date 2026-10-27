// Authentication and authorisation middleware.
import { HttpError } from "./validate.js";
import { authenticateSession, verifyAdminToken, adminCsrfFor } from "./sessions.js";
import { csrfTokenFor, safeEqual } from "./security.js";
import { getInstitute, instituteBlock } from "./repo.js";
import { createLimiter } from "./ratelimit.js";

export const sessionCookieName = config => (config.isProd ? "__Host-st_session" : "st_session");
export const adminCookieName = config => (config.isProd ? "__Host-st_admin" : "st_admin");
export const nonceCookieName = config => (config.isProd ? "__Host-st_nonce" : "st_nonce");
const UNSAFE = method => !["GET", "HEAD", "OPTIONS"].includes(method);

export function createAuth(ctx) {
  const { db, config, clock } = ctx;
  const userLimiter = createLimiter({ now: () => clock.now().getTime(), max: 400, windowMs: 60_000, countEveryRequest: true, key: req => (req.user ? `u${req.user.id}` : null), message: "You are sending requests too quickly. Please slow down." });

  async function auth(req, res, next) {
    const session = await authenticateSession(db, req.cookies?.[sessionCookieName(config)], { clock, config });
    if (!session) throw new HttpError(401, "Please sign in to continue.", "UNAUTHENTICATED");
    const u = await db.one("SELECT id,name,email,role,institute_id,institute_role,banned,is_demo,profile_completed_at,password_hash FROM users WHERE id=$1", [session.user_id]);
    if (!u) throw new HttpError(401, "This account no longer exists.", "UNAUTHENTICATED");
    if (UNSAFE(req.method)) {
      const sent = req.get("x-csrf-token");
      if (!sent || !safeEqual(sent, csrfTokenFor(config.sessionSecret, session.id))) throw new HttpError(403, "Security check failed. Please refresh the page and try again.", "BAD_CSRF");
    }
    if (u.banned) throw new HttpError(403, "This account has been disabled. Please contact StudyTrack support.", "ACCOUNT_BANNED");
    let readOnly = false;
    if (u.role === "teacher" && u.institute_id) {
      const inst = await getInstitute(db, u.institute_id);
      const block = instituteBlock(inst, "teacher");
      if (block) throw new HttpError(403, block.message, block.code);
      readOnly = Boolean(inst && inst.control_mode === "managed" && inst.status === "active" && inst.read_only);
      if (readOnly && UNSAFE(req.method)) throw new HttpError(403, "Your institute is in read-only mode right now. Please contact StudyTrack support.", "READ_ONLY");
    }
    req.user = { id: u.id, name: u.name, email: u.email, role: u.role, institute_id: u.institute_id, institute_role: u.institute_role, readOnly, is_demo: Boolean(u.is_demo), profile_completed: Boolean(u.profile_completed_at), has_password: Boolean(u.password_hash) };
    req.session = session;
    await new Promise((resolve, reject) => userLimiter.guard(req, res, e => (e ? reject(e) : resolve())));
    next();
  }
  const role = (...roles) => (req, res, next) => (roles.includes(req.user?.role) ? next() : next(new HttpError(403, "You don't have access to this.", "FORBIDDEN")));

  function adminAuth(req, res, next) {
    const parsed = verifyAdminToken(config.sessionSecret, req.cookies?.[adminCookieName(config)], clock);
    if (!parsed) throw new HttpError(401, "Admin session expired. Please sign in again.", "ADMIN_UNAUTHENTICATED");
    if (UNSAFE(req.method)) {
      const sent = req.get("x-csrf-token");
      if (!sent || !safeEqual(sent, adminCsrfFor(config.sessionSecret, parsed.payload))) throw new HttpError(403, "Security check failed. Please refresh the page and try again.", "BAD_CSRF");
    }
    req.admin = parsed;
    next();
  }
  // Sensitive account changes need a recent Google sign-in on this session.
  const requireRecentReauth = (req, res, next) => {
    const age = clock.now() - new Date(req.session.last_reauth_at);
    if (age > 10 * 60_000) return next(new HttpError(403, "Please confirm it's you with Google first.", "REAUTH_REQUIRED"));
    next();
  };
  return { auth, role, adminAuth, requireRecentReauth, userLimiter };
}
