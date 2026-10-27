// Validation and sanitisation. Nothing from the client is trusted: types, lengths, characters and formats are checked here.
export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// Zero-width and bidirectional override characters are used for spoofing text and file names.
const SPOOF = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

export function cleanText(value, { max = 200, min = 0, multiline = false } = {}) {
  if (typeof value !== "string") return null;
  let s = value.normalize("NFC").replace(CONTROL, c => (multiline && (c === "\n" || c === "\t") ? c : "")).replace(SPOOF, "");
  if (multiline) s = s.replace(/\r\n?/g, "\n").replace(/\n{4,}/g, "\n\n\n");
  else s = s.replace(/[\n\t\r]+/g, " ");
  s = s.trim();
  const length = [...s].length;
  return length >= min && length <= max ? s : null;
}

export function safeFilename(original, forcedExt = "") {
  const base = String(original ?? "file").normalize("NFC").replace(CONTROL, "").replace(SPOOF, "").split(/[\\/]/).pop();
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/[^\p{L}\p{N} ._()-]/gu, "-").replace(/\.{2,}/g, ".").replace(/^[.\s-]+|[.\s-]+$/g, "").slice(0, 80) || "file";
  const ext = forcedExt || (dot > 0 ? base.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) : "");
  return ext ? `${stem}.${ext}` : stem;
}

const bad = (label, rule) => new HttpError(400, `${label} ${rule}`);
export const v = {
  str(value, label, { min = 1, max = 200, multiline = false } = {}) {
    if (typeof value !== "string") throw bad(label, "is required");
    const s = cleanText(value, { max, min, multiline });
    if (s === null) throw bad(label, min > 0 ? `must be ${min} to ${max} characters` : `must be ${max} characters or fewer`);
    return s;
  },
  optStr(value, label, opts = {}) {
    if (value === undefined || value === null || value === "") return "";
    return v.str(value, label, { ...opts, min: 0 });
  },
  int(value, label, { min = 0, max = 1_000_000 } = {}) {
    const n = typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
    if (!Number.isInteger(n) || n < min || n > max) throw bad(label, `must be a whole number between ${min} and ${max}`);
    return n;
  },
  optInt(value, label, opts) {
    return value === undefined || value === null || value === "" ? null : v.int(value, label, opts);
  },
  num(value, label, { min = 0, max = 1_000_000 } = {}) {
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) throw bad(label, `must be a number between ${min} and ${max}`);
    return n;
  },
  id(value, label = "id") {
    const n = typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : value;
    if (!Number.isInteger(n) || n <= 0 || n > 2_000_000_000) throw new HttpError(400, `Invalid ${label}`);
    return n;
  },
  idList(value, label, { min = 1, max = 20 } = {}) {
    if (!Array.isArray(value) || value.length < min || value.length > max) throw bad(label, `needs ${min} to ${max} items`);
    return [...new Set(value.map(x => v.id(x, label)))];
  },
  date(value, label = "Date") {
    const s = typeof value === "string" ? value : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(label, "must be a valid date (YYYY-MM-DD)");
    const d = new Date(`${s}T12:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw bad(label, "must be a valid date (YYYY-MM-DD)");
    const year = Number(s.slice(0, 4));
    if (year < 2000 || year > 2100) throw bad(label, "is out of range");
    return s;
  },
  optDate(value, label) { return value === undefined || value === null || value === "" ? null : v.date(value, label); },
  time(value, label = "Time") {
    const s = typeof value === "string" ? value : "";
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw bad(label, "must be a time like 16:30");
    return s;
  },
  oneOf(value, label, list) {
    if (typeof value !== "string" || !list.includes(value)) throw bad(label, `must be one of: ${list.join(", ")}`);
    return value;
  },
  bool(value) { return value === true; },
  code(value, label = "Code", { optional = false } = {}) {
    const s = typeof value === "string" ? value.trim().toUpperCase() : "";
    if (!s && optional) return "";
    if (!/^[A-Z0-9]{4,12}$/.test(s)) throw bad(label, "must be 4 to 12 letters or numbers");
    return s;
  },
};
export const parseId = value => { try { return v.id(value); } catch { return null; } };
