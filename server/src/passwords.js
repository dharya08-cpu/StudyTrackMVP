// Password hashing with scrypt (built into Node, memory-hard). Format: scrypt$N$r$p$salt$hash (all base64url).
import crypto from "node:crypto";
import { HttpError } from "./validate.js";

const N = 16384, R = 8, P = 1, KEYLEN = 64;
const scrypt = (password, salt, n, r, p) => new Promise((resolve, reject) => crypto.scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (e, key) => (e ? reject(e) : resolve(key))));

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
export async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts;
  try {
    const expected = Buffer.from(hash, "base64url");
    const actual = await scrypt(String(password).normalize("NFKC"), Buffer.from(salt, "base64url"), Number(n), Number(r), Number(p));
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}
// A hash of a random password: unknown e-mails are checked against it so response time does not reveal whether an account exists.
let dummy = null;
export async function burnPasswordCheck(password) { dummy ??= await hashPassword(crypto.randomBytes(12).toString("hex")); await verifyPassword(password, dummy); }

const COMMON = new Set(["password", "password1", "password123", "12345678", "123456789", "1234567890", "qwerty123", "qwertyuiop", "iloveyou", "11111111", "00000000", "abc12345", "welcome1", "letmein123", "studytrack", "studytrack1", "student123", "teacher123", "admin1234"]);
// Used when people choose a password. (Seeded demo accounts do not go through this on purpose.)
export function assertStrongPassword(password, email = "") {
  if (typeof password !== "string") throw new HttpError(400, "Password is required", "WEAK_PASSWORD");
  if (password.length < 8 || password.length > 100) throw new HttpError(400, "Password must be 8 to 100 characters long.", "WEAK_PASSWORD");
  const lower = password.toLowerCase();
  const local = String(email).split("@")[0].toLowerCase();
  if (COMMON.has(lower) || (local.length >= 4 && lower.includes(local)) || /^(.)\1+$/.test(password)) throw new HttpError(400, "That password is too easy to guess. Choose a different one.", "WEAK_PASSWORD");
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new HttpError(400, "Use at least one letter and one number in your password.", "WEAK_PASSWORD");
  return password;
}
