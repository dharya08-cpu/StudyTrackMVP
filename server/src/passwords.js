// Password hashing with scrypt (built into Node, memory-hard). Format: scrypt$N$r$p$salt$hash (all base64url).
// V6 raised the cost (N 2^14 -> 2^15, p 1 -> 2). Older hashes still verify, and are upgraded on the user's next log in.
import crypto from "node:crypto";
import { HttpError } from "./validate.js";

// PASSWORD_HASH_PROFILE=balanced keeps the V4/V5 cost (about 4x less CPU) for small hosts that cannot sustain the default.
// Hashes already stored with a higher cost are never downgraded.
export const SCRYPT = process.env.PASSWORD_HASH_PROFILE === "balanced" ? { N: 16384, R: 8, P: 1 } : { N: 32768, R: 8, P: 2 };
const { N, R, P } = SCRYPT, KEYLEN = 64;

// Hashing is the heaviest thing a request can ask for. Only a few run at once (leaving threads free for everything else),
// and if a rush builds a long queue, new sign-ins are told to retry in a moment instead of waiting until they time out.
const MAX_PARALLEL = Math.max(1, Number(process.env.PASSWORD_HASH_PARALLEL) || 3), MAX_WAITING = Math.max(1, Number(process.env.PASSWORD_HASH_QUEUE) || 80);
let running = 0; const waiting = [];
export const hashLoad = () => ({ running, waiting: waiting.length });
function withSlot(task) {
  return new Promise((resolve, reject) => {
    const run = () => { running++; task().then(resolve, reject).finally(() => { running--; waiting.shift()?.(); }); };
    if (running < MAX_PARALLEL) run();
    else if (waiting.length >= MAX_WAITING) reject(new HttpError(503, "Sign-in is very busy right now. Please wait a few seconds and try again.", "BUSY"));
    else waiting.push(run);
  });
}
const scrypt = (password, salt, n, r, p) => withSlot(() => new Promise((resolve, reject) => crypto.scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 96 * 1024 * 1024 }, (e, key) => (e ? reject(e) : resolve(key)))));

// True when a stored hash was made with weaker settings than today's.
export function needsRehash(stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  return Number(parts[1]) < N || Number(parts[2]) < R || Number(parts[3]) < P;
}

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
  } catch (error) { if (error instanceof HttpError) throw error; return false; } // "busy" must never look like "wrong password"
}
// A hash of a random password: unknown e-mails are checked against it so response time does not reveal whether an account exists.
let dummy = null;
export async function burnPasswordCheck(password) { dummy ??= await hashPassword(crypto.randomBytes(12).toString("hex")); await verifyPassword(password, dummy); }

const COMMON = new Set(["password", "password1", "password123", "12345678", "123456789", "1234567890", "qwerty123", "qwertyuiop", "iloveyou", "11111111", "00000000", "abc12345", "welcome1", "letmein123", "studytrack", "studytrack1", "student123", "teacher123", "admin1234"]);
// Passwords that are only a well-known word dressed up with digits or symbols ("Password2026", "Qwerty@123").
const BASE_WORDS = new Set(["password", "passw0rd", "qwerty", "qwertyuiop", "asdfghjkl", "zxcvbnm", "iloveyou", "letmein", "welcome", "admin", "administrator", "student", "teacher", "studytrack", "school", "college", "coaching", "monkey", "dragon", "football", "cricket", "india", "abcdef", "abcdefgh", "sunshine", "princess", "superman", "batman", "master", "login"]);
// Used when people choose a password. (Seeded demo accounts do not go through this on purpose.)
export function assertStrongPassword(password, email = "") {
  if (typeof password !== "string") throw new HttpError(400, "Password is required", "WEAK_PASSWORD");
  if (password.length < 10 || password.length > 100) throw new HttpError(400, "Password must be 10 to 100 characters long.", "WEAK_PASSWORD");
  const lower = password.toLowerCase();
  const local = String(email).split("@")[0].toLowerCase();
  const letters = lower.replace(/[^a-z]/g, "");
  if (COMMON.has(lower) || BASE_WORDS.has(letters) || (local.length >= 4 && lower.includes(local)) || /^(.)\1+$/.test(password) || new Set(lower).size < 5) throw new HttpError(400, "That password is too easy to guess. Choose a different one.", "WEAK_PASSWORD");
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new HttpError(400, "Use at least one letter and one number in your password.", "WEAK_PASSWORD");
  return password;
}
