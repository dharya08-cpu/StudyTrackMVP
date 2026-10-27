// Builds the shared context (db, config, clock, storage, limiters, auth middleware) handed to every route module.
import { createLimiter } from "./ratelimit.js";
import { createAuth } from "./auth.js";
import { maskIp, clientIp } from "./security.js";
import { createMailer } from "./mailer.js";

export function createContext({ db, config, clock, storage = null, google, mailer = null, uploadMw = (req, res, next) => next(), limits = {} }) {
  const userKey = req => (req.user ? `u${req.user.id}` : null);
  const now = () => clock.now().getTime();
  const ctx = { db, config, clock, storage, google, uploadMw, mailer: mailer || createMailer(config) };
  const emailKey = req => String(req.body?.email || "").trim().toLowerCase().slice(0, 200) || null;
  ctx.limiters = {
    api: createLimiter({ now, max: limits.api ?? 300, windowMs: 60_000, countEveryRequest: true, message: "Too many requests. Please slow down." }),
    nonce: createLimiter({ now, max: limits.nonce ?? 30, windowMs: 10 * 60_000, countEveryRequest: true }),
    login: createLimiter({ now, max: limits.login ?? 10, windowMs: 15 * 60_000, message: "Too many failed sign-in attempts. Please wait 15 minutes and try again." }),
    adminLogin: createLimiter({ now, max: limits.adminLogin ?? 5, windowMs: 15 * 60_000, message: "Too many failed attempts. Please wait 15 minutes." }),
    join: createLimiter({ now, max: limits.join ?? 10, windowMs: 10 * 60_000, countEveryRequest: true, key: req => userKey(req) || clientIp(req), message: "Too many join attempts. Please wait a few minutes." }),
    joinIp: createLimiter({ now, max: limits.joinIp ?? 30, windowMs: 10 * 60_000, countEveryRequest: true, message: "Too many join attempts from this network. Please wait a few minutes." }),
    upload: createLimiter({ now, max: limits.upload ?? 30, windowMs: 60 * 60_000, countEveryRequest: true, key: userKey, message: "Upload limit reached. Please try again in a while." }),
    announce: createLimiter({ now, max: limits.announce ?? 20, windowMs: 60 * 60_000, countEveryRequest: true, key: userKey, message: "Announcement limit reached. Please try again later." }),
    register: createLimiter({ now, max: limits.register ?? 10, windowMs: 60 * 60_000, countEveryRequest: true, message: "Too many sign-up attempts. Please try again later." }),
    mailIp: createLimiter({ now, max: limits.mailIp ?? 15, windowMs: 60 * 60_000, countEveryRequest: true, message: "Too many e-mail requests. Please try again later." }),
    pwIp: createLimiter({ now, max: limits.pwIp ?? 60, windowMs: 15 * 60_000, countEveryRequest: true, message: "Too many log-in attempts from this network. Please wait a few minutes." }),
    pwFail: createLimiter({ now, max: limits.pwFail ?? 8, windowMs: 15 * 60_000, key: req => (emailKey(req) ? `${clientIp(req)}|${emailKey(req)}` : null), message: "Too many wrong passwords. Please wait 15 minutes, or use Forgot password." }),
    pwFailEmail: createLimiter({ now, max: limits.pwFailEmail ?? 20, windowMs: 60 * 60_000, key: emailKey, message: "This account is temporarily locked after many wrong passwords. Try again in an hour, or use Forgot password." }),
    changePw: createLimiter({ now, max: limits.changePw ?? 5, windowMs: 15 * 60_000, key: userKey, message: "Too many wrong passwords. Please wait 15 minutes." }),
    signup: createLimiter({ now, max: config.teacherSignupLimit, windowMs: 60 * 60_000, countEveryRequest: true, message: "Too many institute requests. Please try again later." }),
    heavy: createLimiter({ now, max: limits.heavy ?? 60, windowMs: 60_000, countEveryRequest: true, key: userKey, message: "Too many requests. Please slow down." }),
  };
  // Security-relevant events (failed sign-ins, revoked sessions, rejected uploads) for the owner's audit view.
  ctx.audit = async (req, type, detail = "", userId = null) => {
    try {
      await db.exec("INSERT INTO security_events(user_id,type,ip_masked,detail,created_at) VALUES($1,$2,$3,$4,$5)",
        [userId ?? req.user?.id ?? null, type, maskIp(clientIp(req)), String(detail).slice(0, 300), clock.nowIso()]);
    } catch (error) { console.error("audit failed:", error.message); }
  };
  Object.assign(ctx, createAuth(ctx));
  return ctx;
}
