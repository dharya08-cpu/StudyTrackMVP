// Server-side sessions. The browser holds an opaque, httpOnly cookie; the database holds only a hash of its secret,
// so a database leak cannot be replayed and every session can be revoked instantly.
import crypto from "node:crypto";
import { sha256, safeEqual, maskIp, clientIp, hmac } from "./security.js";

export function parseUserAgent(ua = "") {
  const s = String(ua).slice(0, 400);
  if (!s) return { deviceType: "unknown", os: "Unknown device", browser: "" };
  let os = "Unknown", deviceType = "desktop";
  if (/Android/i.test(s)) { os = "Android"; deviceType = /Mobile/i.test(s) ? "mobile" : "tablet"; }
  else if (/iPhone|iPod/i.test(s)) { os = "iOS"; deviceType = "mobile"; }
  else if (/iPad/i.test(s)) { os = "iPadOS"; deviceType = "tablet"; }
  else if (/Windows/i.test(s)) os = "Windows";
  else if (/Mac OS X|Macintosh/i.test(s)) os = "macOS";
  else if (/CrOS/i.test(s)) os = "ChromeOS";
  else if (/Linux|X11/i.test(s)) os = "Linux";
  let browser = "Browser";
  if (/Edg(e|A|iOS)?\//.test(s)) browser = "Edge";
  else if (/OPR\/|Opera/.test(s)) browser = "Opera";
  else if (/SamsungBrowser/.test(s)) browser = "Samsung Internet";
  else if (/Firefox\/|FxiOS/.test(s)) browser = "Firefox";
  else if (/CriOS|Chrome\//.test(s)) browser = "Chrome";
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = "Safari";
  return { deviceType, os, browser };
}

// City/country only when the host adds a geo header (for example Cloudflare). Otherwise only a masked IP is shown.
export function locationFromHeaders(req) {
  const city = req.get("cf-ipcity") || req.get("x-vercel-ip-city") || "";
  const country = req.get("cf-ipcountry") || req.get("x-vercel-ip-country") || "";
  const clean = x => String(x).replace(/[^\p{L}\p{N} .,'-]/gu, "").slice(0, 60);
  let decoded = city;
  try { decoded = decodeURIComponent(city); } catch { /* keep raw */ }
  return [clean(decoded), clean(country)].filter(Boolean).join(", ");
}

const SESSION_COOKIE_RE = /^([a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/;
const addDays = (date, days) => new Date(date.getTime() + days * 86400000);

export async function createSession(db, { userId, req, clock, config }) {
  const id = crypto.randomBytes(12).toString("hex");
  const secret = crypto.randomBytes(32).toString("base64url");
  const now = clock.now();
  const nowIso = now.toISOString();
  const ua = parseUserAgent(req.get("user-agent"));
  await db.exec(
    `INSERT INTO sessions(id,user_id,secret_hash,created_at,last_seen_at,expires_at,last_reauth_at,device_type,os,browser,user_agent,ip_masked,location)
     VALUES($1,$2,$3,$4,$4,$5,$4,$6,$7,$8,$9,$10,$11)`,
    [id, userId, sha256(secret), nowIso, addDays(now, config.sessionAbsoluteDays).toISOString(), ua.deviceType, ua.os, ua.browser, String(req.get("user-agent") || "").slice(0, 300), maskIp(clientIp(req)), locationFromHeaders(req)],
  );
  // Keep at most N live sessions per account: the least recently used ones are signed out.
  // The session just created is never the one evicted (even if timestamps tie).
  const others = await db.many("SELECT id FROM sessions WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL AND expires_at>$3 ORDER BY last_seen_at DESC, created_at DESC", [userId, id, nowIso]);
  const excess = others.slice(config.maxSessionsPerUser - 1).map(r => r.id);
  for (const old of excess) await revokeSession(db, userId, old, "session limit", clock);
  return { id, cookieValue: `${id}.${secret}`, maxAgeSeconds: config.sessionAbsoluteDays * 86400 };
}

export async function authenticateSession(db, cookieValue, { clock, config }) {
  const match = SESSION_COOKIE_RE.exec(String(cookieValue || ""));
  if (!match) return null;
  const row = await db.one("SELECT * FROM sessions WHERE id=$1", [match[1]]);
  if (!row || row.revoked_at) return null;
  if (!safeEqual(sha256(match[2]), row.secret_hash)) return null;
  const now = clock.now();
  if (new Date(row.expires_at) <= now) return null;
  if (addDays(new Date(row.last_seen_at), config.sessionIdleDays) <= now) return null;
  // Touch at most once a minute so reads do not become writes.
  if (now - new Date(row.last_seen_at) > 60_000) {
    await db.exec("UPDATE sessions SET last_seen_at=$1 WHERE id=$2", [now.toISOString(), row.id]);
    row.last_seen_at = now.toISOString();
  }
  return row;
}

export async function revokeSession(db, userId, sessionId, reason, clock) {
  return db.exec("UPDATE sessions SET revoked_at=$1, revoked_reason=$2 WHERE id=$3 AND user_id=$4 AND revoked_at IS NULL", [clock.nowIso(), reason, sessionId, userId]);
}
export async function revokeOtherSessions(db, userId, keepId, reason, clock) {
  return db.exec("UPDATE sessions SET revoked_at=$1, revoked_reason=$2 WHERE user_id=$3 AND id<>$4 AND revoked_at IS NULL", [clock.nowIso(), reason, userId, keepId]);
}
export async function revokeAllSessions(db, userId, reason, clock) {
  return db.exec("UPDATE sessions SET revoked_at=$1, revoked_reason=$2 WHERE user_id=$3 AND revoked_at IS NULL", [clock.nowIso(), reason, userId]);
}

export async function listSessions(db, userId, currentId, clock) {
  const now = clock.now();
  const rows = await db.many("SELECT * FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>$2 ORDER BY last_seen_at DESC, id DESC", [userId, now.toISOString()]);
  return rows.map(r => ({
    id: r.id,
    current: r.id === currentId,
    device_type: r.device_type,
    os: r.os,
    browser: r.browser,
    location: r.location || r.ip_masked || "",
    ip_masked: r.ip_masked,
    created_at: r.created_at,
    last_seen_at: r.last_seen_at,
    active_now: now - new Date(r.last_seen_at) < 5 * 60_000,
  }));
}

export async function purgeExpired(db, clock) {
  const now = clock.nowIso();
  const cutoff = new Date(clock.now().getTime() - 30 * 86400000).toISOString();
  await db.exec("DELETE FROM login_nonces WHERE expires_at<$1", [now]);
  await db.exec("DELETE FROM sessions WHERE expires_at<$1 OR (revoked_at IS NOT NULL AND revoked_at<$2)", [now, cutoff]);
  await db.exec("DELETE FROM security_events WHERE created_at<$1", [new Date(clock.now().getTime() - 90 * 86400000).toISOString()]);
  await db.exec("DELETE FROM notifications WHERE created_at<$1", [new Date(clock.now().getTime() - 120 * 86400000).toISOString()]);
}

// ---- Owner admin sessions: HMAC-signed, short-lived, separate from user sessions -----------------------------
export function signAdminToken(secret, clock, hours = 12) {
  const payload = Buffer.from(JSON.stringify({ r: "admin", e: clock.now().getTime() + hours * 3600_000, n: crypto.randomBytes(8).toString("hex") })).toString("base64url");
  return `${payload}.${hmac(secret, `admin:${payload}`)}`;
}
export function verifyAdminToken(secret, token, clock) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig || !safeEqual(hmac(secret, `admin:${payload}`), sig)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.r !== "admin" || !(data.e > clock.now().getTime())) return null;
    return { payload, expires: data.e };
  } catch { return null; }
}
export const adminCsrfFor = (secret, payload) => hmac(secret, `admincsrf:${payload}`);
