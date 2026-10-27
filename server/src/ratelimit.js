// In-memory rate limiting. Counters live in this server process (one instance); see README "Known limits".
import { HttpError } from "./validate.js";
import { clientIp } from "./security.js";

const MAX_KEYS = 50_000; // memory cap: an attacker cannot grow the table without bound

export function createLimiter({ max, windowMs, key = req => clientIp(req), countEveryRequest = false, message = "Too many attempts. Please try again later.", now = () => Date.now() }) {
  const entries = new Map();
  const current = k => {
    const t = now();
    let entry = entries.get(k);
    if (!entry || t >= entry.reset) {
      if (!entry && entries.size >= MAX_KEYS) {
        for (const [key2, e] of entries) if (t >= e.reset) entries.delete(key2);
        if (entries.size >= MAX_KEYS) for (const key2 of [...entries.keys()].slice(0, Math.ceil(MAX_KEYS / 10))) entries.delete(key2);
      }
      entry = { count: 0, reset: t + windowMs };
      entries.set(k, entry);
    }
    return entry;
  };
  const sweeper = setInterval(() => { const t = now(); for (const [k, e] of entries) if (t >= e.reset) entries.delete(k); }, 60_000);
  sweeper.unref?.();
  return {
    guard(req, res, next) {
      const k = key(req);
      if (!k) return next();
      const entry = current(k);
      if (entry.count >= max) {
        res.set("Retry-After", String(Math.max(1, Math.ceil((entry.reset - now()) / 1000))));
        return next(new HttpError(429, message, "RATE_LIMITED"));
      }
      if (countEveryRequest) entry.count++;
      next();
    },
    fail(req) { const k = key(req); if (k) current(k).count++; },
    clear(req) { const k = key(req); if (k) entries.delete(k); },
    count(req) { const k = key(req); return k && entries.has(k) ? entries.get(k).count : 0; },
    size: () => entries.size,
    stop: () => clearInterval(sweeper),
  };
}
