// One-time e-mail links. Only a hash is stored, links work once and expire.
import crypto from "node:crypto";
import { sha256 } from "./security.js";
import { HttpError } from "./validate.js";

export const TOKEN_TTL_MINUTES = { verify: 24 * 60, reset: 60 };

export async function createEmailToken(db, clock, userId, purpose) {
  // No mail bombing: at most 5 links per account per hour.
  const hourAgo = new Date(clock.now().getTime() - 3600_000).toISOString();
  if ((await db.one("SELECT COUNT(*) AS n FROM email_tokens WHERE user_id=$1 AND created_at>=$2", [userId, hourAgo])).n >= 5) {
    throw new HttpError(429, "We already sent several e-mails to this address. Please check your inbox and spam folder, or try again in an hour.", "MAIL_LIMIT");
  }
  const raw = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(clock.now().getTime() + TOKEN_TTL_MINUTES[purpose] * 60_000).toISOString();
  await db.exec("INSERT INTO email_tokens(user_id,purpose,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5)", [userId, purpose, sha256(raw), clock.nowIso(), expires]);
  return raw;
}

// Marks the token used and returns its user id, or null if it is unknown, used, expired or for another purpose.
export async function consumeEmailToken(db, clock, raw, purpose) {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const row = await db.one("SELECT id,user_id FROM email_tokens WHERE token_hash=$1 AND purpose=$2 AND used_at IS NULL AND expires_at>$3", [sha256(raw), purpose, clock.nowIso()]);
  if (!row) return null;
  const done = await db.exec("UPDATE email_tokens SET used_at=$1 WHERE id=$2 AND used_at IS NULL", [clock.nowIso(), row.id]);
  return done ? row.user_id : null;
}
