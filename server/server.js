import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import { createClient } from "@supabase/supabase-js";
import multer from "multer";
import ws from "ws";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const app = express();
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const trustProxyHops = Number(process.env.TRUST_PROXY);
// Behind Render's proxy the real client IP is in X-Forwarded-For; without this every user shares one rate-limit bucket.
app.set("trust proxy", Number.isInteger(trustProxyHops) ? trustProxyHops : (IS_PRODUCTION ? 1 : false));
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? "" : "studytrack-dev-secret");
if (process.env.NODE_ENV === "production" && !JWT_SECRET) { throw new Error("JWT_SECRET must be configured in production"); }
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const SUPABASE_BUCKET = String(process.env.SUPABASE_BUCKET || "").trim();
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { realtime: { transport: ws } })
  : null;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configuredDbPath = process.env.DB_PATH;
if (process.env.NODE_ENV === "production" && !configuredDbPath) { throw new Error("DB_PATH must be configured in production and should point to persistent storage"); }
const dbPath = configuredDbPath ? (path.isAbsolute(configuredDbPath) ? configuredDbPath : path.resolve(process.cwd(), configuredDbPath)) : path.join(__dirname, "studytrack.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");

const allowedOrigin = process.env.CLIENT_ORIGIN;
app.use(cors({ origin: allowedOrigin || (process.env.NODE_ENV === "production" ? false : true) }));
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });

// Core schema. Existing tables are intentionally preserved.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('teacher','student')),
  class_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(teacher_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS homework (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  file_url TEXT,
  file_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(teacher_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  max_marks INTEGER NOT NULL,
  solution TEXT NOT NULL DEFAULT '',
  test_date TEXT,
  file_url TEXT,
  file_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(teacher_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  marks REAL NOT NULL,
  remark TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(test_id, student_id),
  FOREIGN KEY(test_id) REFERENCES tests(id) ON DELETE CASCADE,
  FOREIGN KEY(student_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS homework_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  homework_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(homework_id, student_id),
  FOREIGN KEY(homework_id) REFERENCES homework(id) ON DELETE CASCADE,
  FOREIGN KEY(student_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS study_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('tuition','self-study','outside')),
  subject TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  study_date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(student_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  attendance_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('present','absent')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(student_id, attendance_date),
  FOREIGN KEY(student_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS syllabus_chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL,
  subject TEXT NOT NULL,
  chapter TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not-started' CHECK(status IN ('not-started','in-progress','completed')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(class_id, subject, chapter),
  FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
);
`);

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn("homework_submissions", "status", "TEXT NOT NULL DEFAULT 'submitted'");
ensureColumn("homework_submissions", "feedback", "TEXT NOT NULL DEFAULT ''");
ensureColumn("homework_submissions", "reviewed_at", "TEXT");
ensureColumn("homework", "file_url", "TEXT");
ensureColumn("homework", "file_name", "TEXT");
ensureColumn("tests", "file_url", "TEXT");
ensureColumn("tests", "file_name", "TEXT");
db.exec(`
CREATE INDEX IF NOT EXISTS idx_study_logs_student_date ON study_logs(student_id, study_date);
CREATE INDEX IF NOT EXISTS idx_study_logs_student_subject ON study_logs(student_id, subject);
CREATE INDEX IF NOT EXISTS idx_marks_student ON marks(student_id);
CREATE INDEX IF NOT EXISTS idx_homework_submissions_student ON homework_submissions(student_id);
CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON attendance(student_id, attendance_date);
CREATE INDEX IF NOT EXISTS idx_syllabus_class_subject ON syllabus_chapters(class_id, subject);
`);

// ---------------------------------------------------------------------------
// V3 migrations: institutes, join requests, blocks, admin log, usage tracking.
// Everything here is additive, so databases created by earlier versions keep
// all of their data.
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS institutes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  head_id INTEGER,
  owner_email TEXT NOT NULL,
  contact_phone TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  expected_teachers INTEGER,
  expected_students INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','rejected','suspended','banned')),
  status_reason TEXT NOT NULL DEFAULT '',
  control_mode TEXT NOT NULL DEFAULT 'managed' CHECK(control_mode IN ('managed','independent')),
  read_only INTEGER NOT NULL DEFAULT 0,
  max_teachers INTEGER,
  max_students INTEGER,
  storage_limit_mb INTEGER,
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT,
  FOREIGN KEY(head_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS join_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','blocked','cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  FOREIGN KEY(student_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS teacher_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL,
  student_id INTEGER,
  student_email TEXT NOT NULL,
  student_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(teacher_id, student_email),
  FOREIGN KEY(teacher_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER,
  target_label TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
ensureColumn("users", "institute_id", "INTEGER REFERENCES institutes(id) ON DELETE SET NULL");
ensureColumn("users", "institute_role", "TEXT");
ensureColumn("users", "institute_note", "TEXT NOT NULL DEFAULT ''");
ensureColumn("users", "banned", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("users", "ban_reason", "TEXT NOT NULL DEFAULT ''");
ensureColumn("classes", "suspended", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("classes", "suspend_reason", "TEXT NOT NULL DEFAULT ''");
ensureColumn("homework", "file_size", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("tests", "file_size", "INTEGER NOT NULL DEFAULT 0");
db.exec(`
CREATE INDEX IF NOT EXISTS idx_users_class_code ON users(class_code);
CREATE INDEX IF NOT EXISTS idx_users_institute ON users(institute_id);
CREATE INDEX IF NOT EXISTS idx_classes_teacher ON classes(teacher_id);
CREATE INDEX IF NOT EXISTS idx_join_requests_class_status ON join_requests(class_id, status);
CREATE INDEX IF NOT EXISTS idx_join_requests_student ON join_requests(student_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_join_requests_one_pending ON join_requests(student_id) WHERE status='pending';
`);

const STUDYTRACK_TIMEZONE = process.env.STUDYTRACK_TIMEZONE || "Asia/Kolkata";
function localDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: STUDYTRACK_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const map = Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}
function shiftDate(dateString, days) {
  const d = new Date(`${dateString}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function today() { return localDateString(); }
function dateDaysAgo(n) { return shiftDate(today(), -n); }
function previousWeekStart() { return shiftDate(startOfWeek(), -7); }
function startOfWeek() {
  const d = new Date(`${today()}T12:00:00Z`);
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}
function validDate(value) { const v=String(value||""); if(!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false; const d=new Date(`${v}T12:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10)===v; }
function boundedText(value, max, required=false) { const v=String(value ?? "").trim(); return (!required || v.length > 0) && v.length <= max ? v : null; }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value||"").trim()); }
function pct(marks, max) { return max ? Number((marks * 100 / max).toFixed(1)) : 0; }
function minutesToHours(m) { return Number((Number(m || 0) / 60).toFixed(1)); }
function studentForTeacher(studentId, teacherId) {
  return db.prepare(`SELECT u.id,u.name,u.email,u.class_code FROM users u JOIN classes c ON c.code=u.class_code WHERE u.id=? AND u.role='student' AND c.teacher_id=?`).get(studentId, teacherId);
}
function studentsForClass(code) { return db.prepare("SELECT id,name,email,class_code FROM users WHERE role='student' AND class_code=? ORDER BY name").all(code); }
function seed() {
  const existingTeacher = db.prepare("SELECT id FROM users WHERE role='teacher' ORDER BY id LIMIT 1").get();
  if (existingTeacher) return;
  const production = process.env.NODE_ENV === "production";
  const providedPassword = String(process.env.INITIAL_TEACHER_PASSWORD || "");
  // Teachers now create their own accounts, so a fresh production database simply starts empty
  // unless INITIAL_TEACHER_PASSWORD is provided to seed a demo teacher.
  if (production && providedPassword.length < 12) {
    console.log("No demo teacher seeded (set INITIAL_TEACHER_PASSWORD with 12+ characters to seed one). Teachers can sign up in the app.");
    return;
  }
  const teacherPassword = providedPassword || "teacher123";
  const teacherEmail = String(process.env.INITIAL_TEACHER_EMAIL || "teacher@coaching.com").trim().toLowerCase();
  const teacherName = String(process.env.INITIAL_TEACHER_NAME || "StudyTrack Teacher").trim();
  const classCode = String(process.env.INITIAL_CLASS_CODE || "DEMO01").trim().toUpperCase();
  const className = String(process.env.INITIAL_CLASS_NAME || "Demo Class").trim();
  const teacherId = db.prepare("INSERT INTO users(name,email,password_hash,role,class_code) VALUES(?,?,?,?,?)").run(teacherName,teacherEmail,bcrypt.hashSync(teacherPassword,10),"teacher",classCode).lastInsertRowid;
  const classId = db.prepare("INSERT INTO classes(teacher_id,name,code) VALUES(?,?,?)").run(teacherId,className,classCode).lastInsertRowid;
  const studentPassword = production ? String(process.env.INITIAL_STUDENT_PASSWORD || "") : String(process.env.INITIAL_STUDENT_PASSWORD || "student123");
  if (studentPassword.length >= (production ? 12 : 6)) {
    const studentId = db.prepare("INSERT INTO users(name,email,password_hash,role,class_code) VALUES(?,?,?,?,?)").run("Demo Student","student@coaching.com",bcrypt.hashSync(studentPassword,10),"student",classCode).lastInsertRowid;
    const hwId = db.prepare("INSERT INTO homework(teacher_id,class_id,title,description,due_date) VALUES(?,?,?,?,?)").run(teacherId,classId,"Physics: Motion Practice","Complete questions 1–20 from the worksheet.",dateDaysAgo(-4)).lastInsertRowid;
    const testId = db.prepare("INSERT INTO tests(teacher_id,class_id,title,subject,max_marks,solution,test_date) VALUES(?,?,?,?,?,?,?)").run(teacherId,classId,"Weekly Physics Test","Physics",50,"Review equations of motion and graph interpretation.",dateDaysAgo(1)).lastInsertRowid;
    db.prepare("INSERT INTO marks(test_id,student_id,marks,remark) VALUES(?,?,?,?)").run(testId,studentId,38,"Good attempt. Improve numerical accuracy.");
    db.prepare("INSERT INTO study_logs(student_id,category,subject,minutes,study_date,note) VALUES(?,?,?,?,?,?)").run(studentId,"self-study","Physics",90,dateDaysAgo(3),"Kinematics revision");
    db.prepare("INSERT INTO homework_submissions(homework_id,student_id,note,status) VALUES(?,?,?,?)").run(hwId,studentId,"Completed questions 1–20.","submitted");
  }
  ["Units & Measurements","Kinematics","Laws of Motion","Work, Energy & Power","Rotational Motion"].forEach((chapter,i)=>db.prepare("INSERT INTO syllabus_chapters(class_id,subject,chapter,status) VALUES(?,?,?,?)").run(classId,"Physics",chapter,i<2?"completed":i===2?"in-progress":"not-started"));
}
seed();

// Keep the bundled demo account useful even when an older database already existed.
function ensureDemoData(){
  const teacher=db.prepare("SELECT id,class_code FROM users WHERE email=?").get("teacher@coaching.com");
  if(!teacher)return;
  const cls=db.prepare("SELECT id FROM classes WHERE teacher_id=? AND code=?").get(teacher.id,teacher.class_code);
  const student=db.prepare("SELECT id FROM users WHERE email=?").get("student@coaching.com");
  if(!cls||!student)return;
  const syllabusCount=db.prepare("SELECT COUNT(*) n FROM syllabus_chapters WHERE class_id=?").get(cls.id).n;
  if(!syllabusCount){
    [
      ["Physics","Units & Measurements","completed"],["Physics","Kinematics","completed"],["Physics","Laws of Motion","in-progress"],
      ["Physics","Work, Energy & Power","not-started"],["Physics","Rotational Motion","not-started"]
    ].forEach(([subject,chapter,status])=>db.prepare("INSERT OR IGNORE INTO syllabus_chapters(class_id,subject,chapter,status) VALUES(?,?,?,?)").run(cls.id,subject,chapter,status));
  }
}
ensureDemoData();

// ---------------------------------------------------------------------------
// Errors, small helpers, rate limiting, authentication and access gates
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_PATTERN = /^[A-Z0-9]{4,12}$/;
const ADMIN_AUDIENCE = "studytrack-admin";
const INSTITUTE_ROLES = ["head", "co_head", "teacher"];

function cleanCode(value) { return String(value ?? "").trim().toUpperCase(); }
function normalizeEmail(value) { return String(value ?? "").trim().toLowerCase(); }
function isHeadRole(instituteRole) { return instituteRole === "head" || instituteRole === "co_head"; }
function optionalInt(value, min, max, label) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} must be a whole number between ${min} and ${max}`);
  return n;
}
function codeInUse(code) {
  return Boolean(db.prepare("SELECT 1 FROM classes WHERE code=?").get(code) || db.prepare("SELECT 1 FROM institutes WHERE code=?").get(code));
}
function generateUniqueCode(length = 6) {
  for (let attempt = 0; attempt < 40; attempt++) {
    let code = "";
    for (let i = 0; i < length; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!codeInUse(code)) return code;
  }
  throw new HttpError(503, "Could not generate a unique code. Please try again.");
}
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function isUniqueViolation(error) { return String(error?.code || "").startsWith("SQLITE_CONSTRAINT") || /UNIQUE constraint/i.test(String(error?.message || "")); }
function parseId(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : null; }
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, class_code: u.class_code ?? null, institute_id: u.institute_id ?? null, institute_role: u.institute_role ?? null };
}
function signUser(u) {
  return jwt.sign({ id: u.id, name: u.name, email: u.email, role: u.role, class_code: u.class_code }, JWT_SECRET, { expiresIn: "7d" });
}
function logAdmin(action, targetType, targetId, targetLabel, detail = "") {
  db.prepare("INSERT INTO admin_log(action,target_type,target_id,target_label,detail) VALUES(?,?,?,?,?)").run(action, targetType, targetId ?? null, String(targetLabel || ""), String(detail || ""));
}

// In-memory limiter, keyed by client IP. "failure" limiters only count the
// attempts a route reports through fail(); "countEveryRequest" limiters count
// every request that reaches them.
function createLimiter({ max, windowMs, countEveryRequest = false, keyFn = null }) {
  const entries = new Map();
  const keyOf = keyFn || (req => String(req.ip || "unknown").replace(/^::ffff:/, ""));
  const current = key => {
    const now = Date.now();
    let entry = entries.get(key);
    if (!entry || now > entry.reset) { entry = { count: 0, reset: now + windowMs }; entries.set(key, entry); }
    return entry;
  };
  setInterval(() => { const now = Date.now(); for (const [k, e] of entries) if (now > e.reset) entries.delete(k); }, 60 * 1000).unref();
  return {
    guard(req, res, next) {
      const key = keyOf(req);
      if (!key) return next();
      const entry = current(key);
      if (entry.count >= max) return res.status(429).json({ error: "Too many attempts. Please try again later." });
      if (countEveryRequest) entry.count++;
      next();
    },
    fail(req) { const key = keyOf(req); if (key) current(key).count++; },
    clear(req) { const key = keyOf(req); if (key) entries.delete(key); },
  };
}
const loginLimiter = createLimiter({ max: 20, windowMs: 10 * 60 * 1000 });
const joinCodeLimiter = createLimiter({ max: 15, windowMs: 10 * 60 * 1000 });
const adminLimiter = createLimiter({ max: 8, windowMs: 15 * 60 * 1000 });
const teacherSignupLimiter = createLimiter({ max: Number(process.env.TEACHER_SIGNUP_LIMIT) || 20, windowMs: 60 * 60 * 1000, countEveryRequest: true });
// Per-account limiter: stops distributed password guessing against one email,
// and is not reset by somebody else logging in successfully from the same IP.
const accountLimiter = createLimiter({ max: 10, windowMs: 15 * 60 * 1000, keyFn: req => normalizeEmail(req.body?.email) });

// ---- Access gates: suspension, bans and read-only mode -----------------------
function instituteBlock(inst, audience) {
  if (!inst || inst.control_mode === "independent") return null;
  if (inst.status !== "suspended" && inst.status !== "banned") return null;
  const word = inst.status === "banned" ? "disabled" : "paused";
  if (audience === "student") {
    return { code: inst.status === "banned" ? "INSTITUTE_BANNED" : "INSTITUTE_SUSPENDED", message: `Your coaching institute's access is ${word}. Please contact your teacher.` };
  }
  const reason = inst.status_reason ? ` Reason: ${inst.status_reason}.` : "";
  return { code: inst.status === "banned" ? "INSTITUTE_BANNED" : "INSTITUTE_SUSPENDED", message: `Access for "${inst.name}" is ${word}.${reason} Please contact StudyTrack support.` };
}
function accessFor(u) {
  if (u.banned) return { blocked: true, code: "ACCOUNT_BANNED", message: "This account has been disabled. Please contact StudyTrack support." };
  if (u.role === "teacher") {
    const inst = u.institute_id ? db.prepare("SELECT * FROM institutes WHERE id=?").get(u.institute_id) : null;
    const block = instituteBlock(inst, "teacher");
    if (block) return { blocked: true, ...block };
    return { blocked: false, readOnly: Boolean(inst && inst.control_mode === "managed" && inst.status === "active" && inst.read_only) };
  }
  if (u.role === "student" && u.class_code) {
    const row = db.prepare("SELECT c.suspended,t.banned teacher_banned,t.institute_id FROM classes c JOIN users t ON t.id=c.teacher_id WHERE c.code=?").get(u.class_code);
    if (row) {
      if (row.suspended) return { blocked: true, code: "CLASS_SUSPENDED", message: "Your class is paused right now. Please contact your teacher." };
      if (row.teacher_banned) return { blocked: true, code: "CLASS_UNAVAILABLE", message: "Your class is unavailable right now. Please contact your teacher." };
      const inst = row.institute_id ? db.prepare("SELECT * FROM institutes WHERE id=?").get(row.institute_id) : null;
      const block = instituteBlock(inst, "student");
      if (block) return { blocked: true, ...block };
      return { blocked: false, readOnly: Boolean(inst && inst.control_mode === "managed" && inst.status === "active" && inst.read_only) };
    }
  }
  return { blocked: false, readOnly: false };
}
function bearerToken(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}
function auth(req, res, next) {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: "Authentication required" });
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: "Invalid or expired token" }); }
  if (payload.aud === ADMIN_AUDIENCE || !Number.isInteger(payload.id)) return res.status(401).json({ error: "Invalid or expired token" });
  // The database is the source of truth, so bans, deletions and role changes apply immediately.
  const u = db.prepare("SELECT id,name,email,role,class_code,institute_id,institute_role,banned FROM users WHERE id=?").get(payload.id);
  if (!u) return res.status(401).json({ error: "This account no longer exists" });
  const access = accessFor(u);
  if (access.blocked) return res.status(403).json({ error: access.message, code: access.code });
  if (access.readOnly && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return res.status(403).json({ error: "Your institute is in read-only mode right now. Please contact StudyTrack support.", code: "READ_ONLY" });
  }
  req.user = { id: u.id, name: u.name, email: u.email, role: u.role, class_code: u.class_code, institute_id: u.institute_id, institute_role: u.institute_role, readOnly: Boolean(access.readOnly) };
  next();
}
function role(...roles) { return (req, res, next) => { if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" }); next(); }; }
function adminAuth(req, res, next) {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: "Admin sign-in required" });
  try {
    const payload = jwt.verify(token, JWT_SECRET, { audience: ADMIN_AUDIENCE });
    if (payload.role !== "admin") throw new Error("not admin");
    next();
  } catch { res.status(401).json({ error: "Admin session expired. Please sign in again." }); }
}
function requireClass(req, res, next) {
  const row = db.prepare("SELECT class_code FROM users WHERE id=?").get(req.user.id);
  if (!row?.class_code) return res.status(409).json({ error: "Join a class first", code: "NO_CLASS" });
  next();
}

// Resolves the class a teacher is currently working in. The client sends the
// selected class in the x-class-id header; an unknown or foreign id is an error,
// never silently replaced by another class.
function classForReq(req) {
  const raw = req.get("x-class-id");
  let cls;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    const id = parseId(raw);
    if (!id) throw new HttpError(400, "Invalid class selection");
    cls = db.prepare("SELECT * FROM classes WHERE id=? AND teacher_id=?").get(id, req.user.id);
    if (!cls) throw new HttpError(404, "Class not found");
  } else {
    cls = db.prepare("SELECT * FROM classes WHERE teacher_id=? ORDER BY suspended,id LIMIT 1").get(req.user.id);
    if (!cls) return null;
  }
  if (cls.suspended) throw new HttpError(403, "This class has been suspended by StudyTrack. Please contact StudyTrack support.", "CLASS_SUSPENDED");
  return cls;
}

// ---- Institute helpers -------------------------------------------------------
function instituteEnforced(inst) { return Boolean(inst) && inst.control_mode === "managed"; }
function teacherCountFor(instituteId) { return db.prepare("SELECT COUNT(*) n FROM users WHERE institute_id=? AND role='teacher'").get(instituteId).n; }
function studentCountFor(instituteId) {
  return db.prepare("SELECT COUNT(*) n FROM users s JOIN classes c ON c.code=s.class_code JOIN users t ON t.id=c.teacher_id WHERE s.role='student' AND t.institute_id=?").get(instituteId).n;
}
function classCountFor(instituteId) { return db.prepare("SELECT COUNT(*) n FROM classes c JOIN users t ON t.id=c.teacher_id WHERE t.institute_id=?").get(instituteId).n; }
function storageBytesFor(instituteId) {
  const homework = db.prepare("SELECT COALESCE(SUM(h.file_size),0) n FROM homework h JOIN classes c ON c.id=h.class_id JOIN users t ON t.id=c.teacher_id WHERE t.institute_id=?").get(instituteId).n;
  const tests = db.prepare("SELECT COALESCE(SUM(x.file_size),0) n FROM tests x JOIN classes c ON c.id=x.class_id JOIN users t ON t.id=c.teacher_id WHERE t.institute_id=?").get(instituteId).n;
  return homework + tests;
}
function recordCountFor(instituteId) {
  return ["study_logs", "marks", "attendance", "homework_submissions"].reduce((sum, table) => {
    const row = db.prepare(`SELECT COUNT(*) n FROM ${table} x JOIN users s ON s.id=x.student_id JOIN classes c ON c.code=s.class_code JOIN users t ON t.id=c.teacher_id WHERE t.institute_id=?`).get(instituteId);
    return sum + row.n;
  }, 0);
}
function instituteUsage(instituteId) {
  return {
    teachers: teacherCountFor(instituteId),
    classes: classCountFor(instituteId),
    students: studentCountFor(instituteId),
    records: recordCountFor(instituteId),
    storage_bytes: storageBytesFor(instituteId),
  };
}
function instituteSummaryFor(user) {
  if (!user.institute_id) return null;
  const inst = db.prepare("SELECT * FROM institutes WHERE id=?").get(user.institute_id);
  if (!inst) return null;
  return {
    id: inst.id,
    name: inst.name,
    status: inst.status,
    status_reason: inst.status_reason,
    role: user.institute_role || "teacher",
    code: isHeadRole(user.institute_role) ? inst.code : undefined,
    read_only: instituteEnforced(inst) && inst.status === "active" && Boolean(inst.read_only),
  };
}
function findJoinableInstitute(code) {
  if (!code) return null;
  const inst = db.prepare("SELECT * FROM institutes WHERE code=? AND status='active'").get(code);
  return inst || null;
}
function assertTeacherSeat(inst) {
  if (instituteEnforced(inst) && inst.max_teachers != null && teacherCountFor(inst.id) >= inst.max_teachers) {
    throw new HttpError(403, "This institute has reached its teacher limit. Ask the institute head to contact StudyTrack.", "LIMIT_TEACHERS");
  }
}
function parseInstituteDetails(body) {
  const name = boundedText(body?.instituteName, 80, true);
  if (!name || name.length < 3) throw new HttpError(400, "Institute name must be 3 to 80 characters");
  const code = cleanCode(body?.coachingCode);
  if (code && !CODE_PATTERN.test(code)) throw new HttpError(400, "Coaching code must be 4 to 12 letters or numbers");
  const phone = String(body?.phone ?? "").trim();
  if (!/^[0-9+\-\s()]{6,20}$/.test(phone)) throw new HttpError(400, "Enter a valid contact phone number");
  const city = boundedText(body?.city, 80, false);
  if (city === null) throw new HttpError(400, "City must be 80 characters or fewer");
  const description = boundedText(body?.description, 500, false);
  if (description === null) throw new HttpError(400, "Description must be 500 characters or fewer");
  return {
    name, code, phone, city, description,
    expectedTeachers: optionalInt(body?.expectedTeachers, 0, 100000, "Expected teachers"),
    expectedStudents: optionalInt(body?.expectedStudents, 0, 1000000, "Expected students"),
  };
}

function storageConfigured(){return Boolean(supabase && SUPABASE_BUCKET);}
function uploadSingleFile(req,res,next){
  upload.single("file")(req,res,error=>{
    if(!error)return next();
    if(error instanceof multer.MulterError && error.code==="LIMIT_FILE_SIZE"){
      return res.status(413).json({error:"File must be 20MB or smaller"});
    }
    return res.status(400).json({error:"A single file upload is required"});
  });
}
function safeStorageFilename(originalName){
  const filename=path.basename(String(originalName||"file")).replace(/[^a-zA-Z0-9._-]/g,"-").replace(/-+/g,"-").slice(0,180);
  return filename||"file";
}
function attachmentRecord(type,id){
  const table=type==="homework"?"homework":"tests";
  return db.prepare(`SELECT ${table}.*,c.code class_code,c.teacher_id class_teacher_id FROM ${table} JOIN classes c ON c.id=${table}.class_id WHERE ${table}.id=?`).get(id);
}
function canAccessAttachment(record,user){
  if(user.role==="teacher")return record.class_teacher_id===user.id;
  if(user.role!=="student")return false;
  return Boolean(db.prepare("SELECT id FROM users WHERE id=? AND role='student' AND class_code=?").get(user.id,record.class_code));
}
async function attachFile(req,res,type){
  const record=attachmentRecord(type,req.params.id);
  if(!record)return res.status(404).json({error:`${type==="homework"?"Homework":"Test"} not found`});
  if(record.class_teacher_id!==req.user.id)return res.status(404).json({error:`${type==="homework"?"Homework":"Test"} not found`});
  if(!req.file)return res.status(400).json({error:"A file is required"});
  if(!storageConfigured())return res.status(503).json({error:"File storage is not configured"});

  const teacherRow=db.prepare("SELECT institute_id FROM users WHERE id=?").get(record.class_teacher_id);
  const inst=teacherRow?.institute_id?db.prepare("SELECT * FROM institutes WHERE id=?").get(teacherRow.institute_id):null;
  if(instituteEnforced(inst)&&inst.storage_limit_mb!=null&&storageBytesFor(inst.id)-(record.file_size||0)+req.file.size>inst.storage_limit_mb*1024*1024){
    return res.status(413).json({error:"Your institute's storage limit has been reached. Contact StudyTrack to increase it.",code:"STORAGE_LIMIT"});
  }
  const filename=safeStorageFilename(req.file.originalname);
  const storagePath=`${record.class_code}/${type}/${Date.now()}-${record.id}-${filename}`;
  const bucket=supabase.storage.from(SUPABASE_BUCKET);
  const uploaded=await bucket.upload(storagePath,req.file.buffer,{contentType:req.file.mimetype||"application/octet-stream",upsert:false});
  if(uploaded.error)return res.status(502).json({error:"File upload failed"});
  try{
    db.prepare(`UPDATE ${type} SET file_url=?,file_name=?,file_size=? WHERE id=?`).run(storagePath,req.file.originalname,req.file.size,record.id);
  }catch(error){
    await bucket.remove([storagePath]).catch(()=>{});
    throw error;
  }
  if(record.file_url&&record.file_url!==storagePath)await bucket.remove([record.file_url]).catch(()=>{});
  res.status(201).json({fileName:req.file.originalname});
}
async function downloadFile(req,res,type){
  const record=attachmentRecord(type,req.params.id);
  if(!record||!record.file_url)return res.status(404).json({error:"File not found"});
  if(!canAccessAttachment(record,req.user))return res.status(403).json({error:"Forbidden"});
  if(!storageConfigured())return res.status(503).json({error:"File storage is not configured"});
  const signed=await supabase.storage.from(SUPABASE_BUCKET).createSignedUrl(record.file_url,60*60);
  if(signed.error||!signed.data?.signedUrl)return res.status(502).json({error:"File download is unavailable"});
  res.json({url:signed.data.signedUrl,fileName:record.file_name,expiresIn:60*60});
}

app.get("/api/health",(_,res)=>res.json({ok:true}));
// ---------------------------------------------------------------------------
// Authentication routes
// ---------------------------------------------------------------------------
function sessionResponse(userId, extra = {}) {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  return { token: signUser(u), user: publicUser(u), ...extra };
}

app.post("/api/auth/login", loginLimiter.guard, accountLimiter.guard, (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");
  const requestedRole = req.body?.role;
  const u = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!u || (requestedRole && u.role !== requestedRole) || !bcrypt.compareSync(password, u.password_hash)) {
    loginLimiter.fail(req);
    accountLimiter.fail(req);
    return res.status(401).json({ error: "Invalid credentials or role" });
  }
  accountLimiter.clear(req);
  const access = accessFor(u);
  if (access.blocked) return res.status(403).json({ error: access.message, code: access.code });
  res.json({ token: signUser(u), user: publicUser(u) });
});

// Students register with name, email and password only. They enter their class
// code on the next screen and wait for the teacher to approve them.
app.post("/api/auth/register", loginLimiter.guard, (req, res) => {
  const name = boundedText(req.body?.name, 100, true);
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");
  if (!name || !validEmail(email) || password.length < 6 || password.length > 128) {
    loginLimiter.fail(req);
    return res.status(400).json({ error: "Name, valid email and a 6-128 character password are required" });
  }
  if (db.prepare("SELECT 1 FROM users WHERE email=?").get(email)) {
    loginLimiter.fail(req);
    return res.status(409).json({ error: "An account with this email already exists. Try logging in instead." });
  }
  let id;
  try {
    id = db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,'student')").run(name, email, bcrypt.hashSync(password, 10)).lastInsertRowid;
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ error: "An account with this email already exists. Try logging in instead." });
    throw error;
  }
  res.status(201).json(sessionResponse(Number(id)));
});

// Teachers create their own account and first class. The class code is stored
// in the database and shows up in the owner's admin panel; no approval needed.
app.post("/api/auth/teacher-register", teacherSignupLimiter.guard, (req, res) => {
  const name = boundedText(req.body?.name, 100, true);
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password ?? "");
  const className = boundedText(req.body?.className, 100, true);
  let code = cleanCode(req.body?.classCode);
  if (!name || !validEmail(email) || password.length < 6 || password.length > 128 || !className) {
    return res.status(400).json({ error: "Teacher name, valid email, a 6-128 character password and class name are required" });
  }
  if (code && !CODE_PATTERN.test(code)) return res.status(400).json({ error: "Class code must be 4 to 12 letters or numbers" });
  if (db.prepare("SELECT 1 FROM users WHERE email=?").get(email)) return res.status(409).json({ error: "An account with this email already exists. Try logging in instead." });
  if (code && codeInUse(code)) return res.status(409).json({ error: "That class code is already taken. Choose another or leave it blank to generate one." });
  if (!code) code = generateUniqueCode();
  const passwordHash = bcrypt.hashSync(password, 10);
  let teacherId;
  try {
    teacherId = Number(db.transaction(() => {
      const id = db.prepare("INSERT INTO users(name,email,password_hash,role,class_code) VALUES(?,?,?,'teacher',?)").run(name, email, passwordHash, code).lastInsertRowid;
      db.prepare("INSERT INTO classes(teacher_id,name,code) VALUES(?,?,?)").run(id, className, code);
      return id;
    })());
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ error: "Email or class code is already taken" });
    throw error;
  }
  res.status(201).json(sessionResponse(teacherId, { landing: "class" }));
});

// A teacher joins an existing coaching institute with its coaching code. A new
// account is created, or an existing independent teacher account is used when
// the password matches. The code is verified before anything is written.
app.post("/api/auth/teacher-join-institute", teacherSignupLimiter.guard, loginLimiter.guard, accountLimiter.guard, (req, res) => {
  const name = boundedText(req.body?.name, 100, true);
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password ?? "");
  const code = cleanCode(req.body?.coachingCode);
  if (!validEmail(email) || !password || password.length > 128 || !code) {
    return res.status(400).json({ error: "Email, password and the coaching code are required" });
  }
  const inst = findJoinableInstitute(code);
  if (!inst) {
    loginLimiter.fail(req);
    return res.status(404).json({ error: "No active coaching institute found with that code. Check it with your institute head." });
  }
  const existing = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (existing) {
    if (!bcrypt.compareSync(password, existing.password_hash)) {
      loginLimiter.fail(req);
      accountLimiter.fail(req);
      return res.status(401).json({ error: "Invalid credentials" });
    }
    if (existing.role !== "teacher") return res.status(409).json({ error: "This email belongs to a student account. Use a different email for teacher access." });
    if (existing.banned) return res.status(403).json({ error: "This account has been disabled. Please contact StudyTrack support.", code: "ACCOUNT_BANNED" });
    if (existing.institute_id) return res.status(409).json({ error: "This account already belongs to a coaching institute." });
  } else if (!name || password.length < 6) {
    return res.status(400).json({ error: "Teacher name and a 6-128 character password are required" });
  }
  assertTeacherSeat(inst);
  let teacherId;
  try {
    teacherId = db.transaction(() => {
      let id = existing?.id;
      if (!id) id = Number(db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,'teacher')").run(name, email, bcrypt.hashSync(password, 10)).lastInsertRowid);
      db.prepare("UPDATE users SET institute_id=?,institute_role='teacher' WHERE id=?").run(inst.id, id);
      return id;
    })();
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ error: "An account with this email already exists" });
    throw error;
  }
  accountLimiter.clear(req);
  res.status(existing ? 200 : 201).json(sessionResponse(teacherId, { landing: "institute" }));
});

// "Create your own coaching institute". Works for brand-new heads (account is
// created) and for existing teachers (password is re-entered to confirm). The
// institute stays "pending" until the owner approves it in the admin panel.
app.post("/api/auth/institute-request", teacherSignupLimiter.guard, loginLimiter.guard, accountLimiter.guard, (req, res) => {
  const details = parseInstituteDetails(req.body);
  const name = boundedText(req.body?.name, 100, true);
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password ?? "");
  if (!validEmail(email) || !password || password.length > 128) return res.status(400).json({ error: "A valid email and password are required" });
  const existing = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  let rejectedInstituteId = null;
  if (existing) {
    if (!bcrypt.compareSync(password, existing.password_hash)) {
      loginLimiter.fail(req);
      accountLimiter.fail(req);
      return res.status(401).json({ error: "Invalid credentials" });
    }
    if (existing.role !== "teacher") return res.status(409).json({ error: "This email belongs to a student account. Use a different email for the institute head account." });
    if (existing.banned) return res.status(403).json({ error: "This account has been disabled. Please contact StudyTrack support.", code: "ACCOUNT_BANNED" });
    if (existing.institute_id) {
      const current = db.prepare("SELECT id,status FROM institutes WHERE id=?").get(existing.institute_id);
      if (current && current.status === "rejected" && existing.institute_role === "head") rejectedInstituteId = current.id;
      else return res.status(409).json({ error: "This account already belongs to a coaching institute." });
    }
  } else {
    if (!name) return res.status(400).json({ error: "Your name is required to create the institute head account" });
    if (!validEmail(email) || password.length < 6) return res.status(400).json({ error: "A valid email and a 6-128 character password are required" });
  }
  if (details.code && codeInUse(details.code)) {
    // A rejected request that belongs to this same head may reuse its own code.
    const own = rejectedInstituteId && db.prepare("SELECT 1 FROM institutes WHERE id=? AND code=?").get(rejectedInstituteId, details.code);
    if (!own) return res.status(409).json({ error: "That coaching code is already taken. Choose another or leave it blank to generate one." });
  }
  const code = details.code || generateUniqueCode(8);
  let result;
  try {
    result = db.transaction(() => {
      let userId = existing?.id;
      if (rejectedInstituteId) {
        db.prepare("UPDATE users SET institute_id=NULL,institute_role=NULL WHERE id=?").run(userId);
        db.prepare("DELETE FROM institutes WHERE id=?").run(rejectedInstituteId);
      }
      if (!userId) userId = Number(db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,'teacher')").run(name, email, bcrypt.hashSync(password, 10)).lastInsertRowid);
      const instituteId = Number(db.prepare(`INSERT INTO institutes(name,code,head_id,owner_email,contact_phone,city,description,expected_teachers,expected_students)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(details.name, code, userId, email, details.phone, details.city, details.description, details.expectedTeachers, details.expectedStudents).lastInsertRowid);
      db.prepare("UPDATE users SET institute_id=?,institute_role='head' WHERE id=?").run(instituteId, userId);
      return { userId, instituteId };
    })();
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ error: "That email or coaching code is already taken" });
    throw error;
  }
  accountLimiter.clear(req);
  res.status(201).json(sessionResponse(result.userId, { landing: "institute", institute: { id: result.instituteId, name: details.name, code, status: "pending" } }));
});

app.get("/api/me", auth, (req, res) => {
  const u = db.prepare("SELECT id,name,email,role,class_code,institute_id,institute_role FROM users WHERE id=?").get(req.user.id);
  res.json({ user: publicUser(u), institute: u.role === "teacher" ? instituteSummaryFor(u) : null });
});

function homeworkForClass(classId){return db.prepare(`SELECT h.*,COUNT(DISTINCT hs.student_id) submitted_count,SUM(CASE WHEN hs.status='reviewed' THEN 1 ELSE 0 END) reviewed_count,SUM(CASE WHEN hs.submitted_at IS NOT NULL AND h.due_date IS NOT NULL AND date(hs.submitted_at)>date(h.due_date) THEN 1 ELSE 0 END) late_count FROM homework h LEFT JOIN homework_submissions hs ON hs.homework_id=h.id WHERE h.class_id=? GROUP BY h.id ORDER BY h.created_at DESC`).all(classId);}
function testResultsForClass(classId){return db.prepare(`SELECT t.id,t.title,t.subject,t.max_marks,t.test_date,t.created_at,t.file_url,t.file_name,COUNT(m.id) result_count,ROUND(AVG(CASE WHEN m.id IS NULL THEN NULL ELSE m.marks*100.0/t.max_marks END),1) average_percentage FROM tests t LEFT JOIN marks m ON m.test_id=t.id WHERE t.class_id=? GROUP BY t.id ORDER BY t.test_date DESC,t.created_at DESC`).all(classId);}

app.get("/api/teacher/overview",auth,role("teacher"),(req,res)=>{
  const cls=classForReq(req); if(!cls)return res.json({class:null,students:[],homework:[],tests:[],metrics:{}});
  const students=studentsForClass(cls.code); const hw=homeworkForClass(cls.id); const tests=testResultsForClass(cls.id);
  const metrics=db.prepare(`SELECT (SELECT COUNT(*) FROM users WHERE role='student' AND class_code=?) students,(SELECT COUNT(DISTINCT s.student_id) FROM study_logs s JOIN users u ON u.id=s.student_id WHERE u.role='student' AND u.class_code=? AND s.study_date=?) active_today,(SELECT COALESCE(SUM(s.minutes),0) FROM study_logs s JOIN users u ON u.id=s.student_id WHERE u.class_code=? AND s.study_date=?) today_minutes,(SELECT COALESCE(SUM(s.minutes),0) FROM study_logs s JOIN users u ON u.id=s.student_id WHERE u.class_code=? AND s.study_date>=?) week_minutes,(SELECT COUNT(*) FROM homework h WHERE h.class_id=? AND (h.due_date IS NULL OR h.due_date>=?)) open_homework,(SELECT COUNT(*) FROM homework_submissions hs JOIN homework h ON h.id=hs.homework_id WHERE h.class_id=? AND hs.status IN ('submitted','late')) pending_reviews`).get(cls.code,cls.code,today(),cls.code,today(),cls.code,startOfWeek(),cls.id,today(),cls.id);
  const studentSummary=students.map(s=>studentSummaryFor(s.id));
  const activity=buildActivityForClass(cls.code,20);
  res.json({class:cls,students,homework:hw,tests,metrics:{...metrics,today_hours:minutesToHours(metrics.today_minutes),week_hours:minutesToHours(metrics.week_minutes),inactive_today:students.length-metrics.active_today},studentSummary,activity});
});

function studentSummaryFor(studentId){
  const s=db.prepare("SELECT id,name,email,class_code FROM users WHERE id=?").get(studentId);
  const study=db.prepare("SELECT COALESCE(SUM(CASE WHEN study_date=? THEN minutes ELSE 0 END),0) today,COALESCE(SUM(CASE WHEN study_date>=? THEN minutes ELSE 0 END),0) week,COALESCE(SUM(CASE WHEN study_date>=? AND study_date<? THEN minutes ELSE 0 END),0) prevweek FROM study_logs WHERE student_id=?").get(today(),startOfWeek(),previousWeekStart(),startOfWeek(),studentId);
  const score=db.prepare("SELECT COALESCE(AVG(m.marks*100.0/t.max_marks),0) avg, (SELECT m2.marks*100.0/t2.max_marks FROM marks m2 JOIN tests t2 ON t2.id=m2.test_id WHERE m2.student_id=? AND t2.class_id=(SELECT id FROM classes WHERE code=(SELECT class_code FROM users WHERE id=?)) ORDER BY COALESCE(t2.test_date,t2.created_at) DESC,t2.id DESC LIMIT 1) latest FROM marks m JOIN tests t ON t.id=m.test_id WHERE m.student_id=? AND t.class_id=(SELECT id FROM classes WHERE code=(SELECT class_code FROM users WHERE id=?))").get(studentId,studentId,studentId,studentId);
  const hw=db.prepare(`SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN hs.id IS NOT NULL THEN 1 ELSE 0 END),0) submitted
    FROM homework h JOIN users u ON u.id=? AND u.class_code=(SELECT class_code FROM users WHERE id=?)
    LEFT JOIN homework_submissions hs ON hs.homework_id=h.id AND hs.student_id=?
    WHERE h.class_id=(SELECT id FROM classes WHERE code=u.class_code LIMIT 1)`).get(studentId,studentId,studentId);
  const studyTrend=trend(study.week,study.prevweek);
  const homeworkTotal=hw?.total||0, homeworkSubmitted=hw?.submitted||0;
  const homeworkRate=homeworkTotal?homeworkSubmitted/homeworkTotal:1;
  const avg=Number(score.avg||0);
  let status="on-track";
  if (study.week===0 || (studyTrend==="declining" && avg<60) || homeworkRate<0.5) status="needs-attention";
  if ((study.week===0 && avg<50) || (studyTrend==="declining" && avg<45) || homeworkRate<0.25) status="at-risk";
  return {...s,today_hours:minutesToHours(study.today),week_hours:minutesToHours(study.week),prevweek_hours:minutesToHours(study.prevweek),study_trend:studyTrend,average_percentage:avg.toFixed(1),latest_percentage:score.latest==null?null:Number(score.latest.toFixed(1)),homework_total:homeworkTotal,homework_submitted:homeworkSubmitted,status};
}
function trend(current,previous){if(!previous)return current>0?"new":"stable";const change=(current-previous)/previous*100;return change>5?"improving":change<-5?"declining":"stable";}
function parseFilterDates(query){const from=query.from?String(query.from):"",to=query.to?String(query.to):"";const fromDate=from&&validDate(from)?from:null,toDate=to&&validDate(to)?to:null;if((from&&!fromDate)||(to&&!toDate))return {error:"Invalid date filter"};if(fromDate&&toDate&&fromDate>toDate)return {error:"Start date cannot be after end date"};return {from:fromDate,to:toDate};}

app.get("/api/teacher/student/:id/study",auth,role("teacher"),(req,res)=>{const s=studentForTeacher(req.params.id,req.user.id);if(!s)return res.status(404).json({error:"Student not found"});const dateFilter=parseFilterDates(req.query);if(dateFilter.error)return res.status(400).json({error:dateFilter.error});const {from,to}=dateFilter,subject=req.query.subject?String(req.query.subject).trim():"",category=req.query.category?String(req.query.category).trim():"";if(subject.length>100)return res.status(400).json({error:"Subject filter is too long"});if(category&&!['tuition','self-study','outside'].includes(category))return res.status(400).json({error:"Invalid study type filter"});const conditions=["student_id=?"],params=[s.id];if(from){conditions.push("study_date>=?");params.push(from)}if(to){conditions.push("study_date<=?");params.push(to)}if(subject){conditions.push("subject=?");params.push(subject)}if(category){conditions.push("category=?");params.push(category)}const where=conditions.join(" AND ");const logs=db.prepare(`SELECT * FROM study_logs WHERE ${where} ORDER BY study_date DESC,id DESC`).all(...params);const daily=db.prepare(`SELECT study_date,SUM(minutes) minutes FROM study_logs WHERE ${where} GROUP BY study_date ORDER BY study_date`).all(...params);const subjects=db.prepare(`SELECT subject,SUM(minutes) minutes FROM study_logs WHERE ${where} GROUP BY subject ORDER BY minutes DESC`).all(...params);const categories=db.prepare(`SELECT category,SUM(minutes) minutes FROM study_logs WHERE ${where} GROUP BY category`).all(...params);const thisWeek=db.prepare("SELECT COALESCE(SUM(minutes),0) m FROM study_logs WHERE student_id=? AND study_date>=?").get(s.id,startOfWeek()).m;const prevWeek=db.prepare("SELECT COALESCE(SUM(minutes),0) m FROM study_logs WHERE student_id=? AND study_date>=? AND study_date<?").get(s.id,previousWeekStart(),startOfWeek()).m;res.json({student:s,logs,daily,subjects,categories,total_minutes:logs.reduce((a,x)=>a+x.minutes,0),this_week_minutes:thisWeek,previous_week_minutes:prevWeek,trend:trend(thisWeek,prevWeek),change_percentage:prevWeek?Number(((thisWeek-prevWeek)*100/prevWeek).toFixed(1)):null,filters:{from,to,subject,category}});});

app.get("/api/teacher/student/:id/analytics",auth,role("teacher"),(req,res)=>{
  const s=studentForTeacher(req.params.id,req.user.id);
  if(!s)return res.status(404).json({error:"Student not found"});
  const scores=db.prepare("SELECT t.id,t.title,t.subject,t.max_marks,m.marks,m.remark,t.test_date,ROUND(m.marks*100.0/t.max_marks,1) percentage FROM marks m JOIN tests t ON t.id=m.test_id WHERE m.student_id=? ORDER BY COALESCE(t.test_date,t.created_at) ASC,t.id ASC").all(s.id);
  const study=db.prepare("SELECT category,SUM(minutes) minutes FROM study_logs WHERE student_id=? GROUP BY category").all(s.id);
  const avg=scores.length?scores.reduce((a,x)=>a+x.percentage,0)/scores.length:0;
  const first=scores[0]?.percentage||0,last=scores.at(-1)?.percentage||0;
  const week=db.prepare("SELECT COALESCE(SUM(minutes),0)m FROM study_logs WHERE student_id=? AND study_date>=?").get(s.id,startOfWeek()).m;
  const prevWeek=db.prepare("SELECT COALESCE(SUM(minutes),0)m FROM study_logs WHERE student_id=? AND study_date>=? AND study_date<?").get(s.id,previousWeekStart(),startOfWeek()).m;
  const weekly=db.prepare(`SELECT week_start,study_minutes,test_percentage FROM (
    SELECT date(study_date,'-' || ((strftime('%w',study_date)+6)%7) || ' days') week_start,SUM(minutes) study_minutes,NULL test_percentage FROM study_logs WHERE student_id=? GROUP BY week_start
    UNION ALL SELECT date(COALESCE(t.test_date,t.created_at),'-' || ((strftime('%w',COALESCE(t.test_date,t.created_at))+6)%7) || ' days') week_start,NULL study_minutes,AVG(m.marks*100.0/t.max_marks) test_percentage FROM marks m JOIN tests t ON t.id=m.test_id WHERE m.student_id=? GROUP BY week_start
  ) ORDER BY week_start`).all(s.id,s.id);
  const byWeek=new Map();
  weekly.forEach(r=>{const x=byWeek.get(r.week_start)||{week_start:r.week_start,study_minutes:0,test_percentage:null};if(r.study_minutes!=null)x.study_minutes+=r.study_minutes;if(r.test_percentage!=null)x.test_percentage=Number(r.test_percentage.toFixed(1));byWeek.set(r.week_start,x)});
  const attendance=db.prepare("SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN status='present' THEN 1 ELSE 0 END),0) present FROM attendance a JOIN classes c ON c.id=a.class_id WHERE a.student_id=? AND c.code=?").get(s.id,s.class_code);
  const syllabus=db.prepare("SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0) completed FROM syllabus_chapters sc JOIN classes c ON c.id=sc.class_id WHERE c.code=?").get(s.class_code);
  res.json({student:s,scores,study,averagePercentage:Number(avg.toFixed(1)),improvementPercentage:Number((last-first).toFixed(1)),latestPercentage:scores.at(-1)?.percentage??null,studyHours:minutesToHours(study.reduce((a,x)=>a+x.minutes,0)),weekStudyHours:minutesToHours(week),previousWeekStudyHours:minutesToHours(prevWeek),studyTrend:trend(week,prevWeek),performanceTrend:scores.length>1?trend(last,first):"stable",attendancePercentage:attendance.total?Number((attendance.present*100/attendance.total).toFixed(1)):0,syllabusPercentage:syllabus.total?Math.round(syllabus.completed*100/syllabus.total):0,weeklyComparison:[...byWeek.values()]});
});

app.get("/api/teacher/student/:id/homework",auth,role("teacher"),(req,res)=>{const s=studentForTeacher(req.params.id,req.user.id);if(!s)return res.status(404).json({error:"Student not found"});const rows=db.prepare(`SELECT h.*,hs.note,hs.submitted_at,hs.status,hs.feedback,hs.reviewed_at FROM homework h JOIN classes c ON c.id=h.class_id LEFT JOIN homework_submissions hs ON hs.homework_id=h.id AND hs.student_id=? WHERE c.teacher_id=? AND c.code=? ORDER BY h.created_at DESC`).all(s.id,req.user.id,s.class_code);res.json({student:s,homework:rows});});
app.get("/api/teacher/homework/:id/submissions",auth,role("teacher"),(req,res)=>{const h=db.prepare("SELECT h.*,c.teacher_id,c.code FROM homework h JOIN classes c ON c.id=h.class_id WHERE h.id=? AND c.teacher_id=?").get(req.params.id,req.user.id);if(!h)return res.status(404).json({error:"Homework not found"});const students=studentsForClass(h.code);const rows=db.prepare("SELECT * FROM homework_submissions WHERE homework_id=?").all(h.id);const map=new Map(rows.map(r=>[r.student_id,r]));res.json({homework:h,submissions:students.map(s=>({student:s,...(map.get(s.id)||{}),status:map.get(s.id)?.status||(h.due_date&&today()>h.due_date?"late":"pending")}))});});
app.post("/api/teacher/homework/:id/review",auth,role("teacher"),(req,res)=>{const h=db.prepare("SELECT h.* FROM homework h JOIN classes c ON c.id=h.class_id WHERE h.id=? AND c.teacher_id=?").get(req.params.id,req.user.id);if(!h)return res.status(404).json({error:"Homework not found"});const sub=db.prepare("SELECT hs.* FROM homework_submissions hs JOIN users u ON u.id=hs.student_id JOIN classes c ON c.code=u.class_code WHERE hs.homework_id=? AND hs.student_id=? AND c.teacher_id=? AND c.id=?").get(h.id,req.body.studentId,req.user.id,h.class_id);if(!sub)return res.status(404).json({error:"Submission not found"});const feedback=String(req.body.feedback||"").trim();if(feedback.length>5000)return res.status(400).json({error:"Feedback is too long"});db.prepare("UPDATE homework_submissions SET status='reviewed',feedback=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(feedback,sub.id);res.json({ok:true});});

app.post("/api/teacher/homework",auth,role("teacher"),(req,res)=>{const cls=classForReq(req);const title=String(req.body.title||"").trim(),description=String(req.body.description||""),dueDate=req.body.dueDate||null;if(!cls||!title||title.length>200||description.length>5000||!(dueDate==null||validDate(dueDate)))return res.status(400).json({error:"Valid title and due date are required"});const id=db.prepare("INSERT INTO homework(teacher_id,class_id,title,description,due_date) VALUES(?,?,?,?,?)").run(req.user.id,cls.id,title,description,dueDate).lastInsertRowid;res.status(201).json(db.prepare("SELECT * FROM homework WHERE id=?").get(id));});
app.post("/api/teacher/homework/:id/attach",auth,role("teacher"),uploadSingleFile,(req,res)=>attachFile(req,res,"homework"));
app.get("/api/files/homework/:id",auth,(req,res)=>downloadFile(req,res,"homework"));
app.get("/api/teacher/results",auth,role("teacher"),(req,res)=>{
  const cls=classForReq(req);
  if(!cls)return res.json({students:[],tests:[]});
  const subjectFilter=String(req.query.subject||"").trim(),dateFilter=parseFilterDates(req.query),fromFilter=dateFilter.from,toFilter=dateFilter.to;
  if(dateFilter.error)return res.status(400).json({error:dateFilter.error});
  if(subjectFilter.length>100)return res.status(400).json({error:"Subject filter is too long"});
  const students=studentsForClass(cls.code);
  const results=students.map(s=>{
    const conditions=["m.student_id=?","t.class_id=?"],params=[s.id,cls.id];if(subjectFilter){conditions.push("t.subject=?");params.push(subjectFilter)}if(fromFilter){conditions.push("COALESCE(t.test_date,date(t.created_at))>=?");params.push(fromFilter)}if(toFilter){conditions.push("COALESCE(t.test_date,date(t.created_at))<=?");params.push(toFilter)}const scores=db.prepare(`SELECT ROUND(m.marks*100.0/t.max_marks,1) percentage,t.id,t.title,t.subject,t.test_date,m.marks,t.max_marks FROM marks m JOIN tests t ON t.id=m.test_id WHERE ${conditions.join(" AND ")} ORDER BY COALESCE(t.test_date,t.created_at) DESC,t.id DESC`).all(...params);
    const avg=scores.length?scores.reduce((a,x)=>a+x.percentage,0)/scores.length:0;
    const latest=scores[0]?.percentage??null;const previous=scores[1]?.percentage??null;
    return {student:s,test_count:scores.length,average_percentage:Number(avg.toFixed(1)),latest_percentage:latest,highest_percentage:scores.length?Math.max(...scores.map(x=>x.percentage)):null,lowest_percentage:scores.length?Math.min(...scores.map(x=>x.percentage)):null,trend:latest!=null&&previous!=null?trend(latest,previous):"stable",scores};
  });
  const tests=testResultsForClass(cls.id).filter(t=>{const d=String(t.test_date||t.created_at||"").slice(0,10);return (!subjectFilter||t.subject===subjectFilter)&&(!fromFilter||d>=fromFilter)&&(!toFilter||d<=toFilter)});
  res.json({class:cls,students:results,tests,filters:{subject:subjectFilter,from:fromFilter,to:toFilter}});
});
app.post("/api/teacher/tests",auth,role("teacher"),(req,res)=>{const cls=classForReq(req);const title=String(req.body.title||"").trim(),subject=String(req.body.subject||"").trim(),maxMarks=Number(req.body.maxMarks),solution=String(req.body.solution||""),testDate=req.body.testDate||null;if(!cls||!title||title.length>200||!subject||subject.length>100||!Number.isInteger(maxMarks)||maxMarks<=0||maxMarks>100000||!(testDate==null||validDate(testDate)))return res.status(400).json({error:"Valid title, subject, max marks and test date are required"});const id=db.prepare("INSERT INTO tests(teacher_id,class_id,title,subject,max_marks,solution,test_date) VALUES(?,?,?,?,?,?,?)").run(req.user.id,cls.id,title,subject,maxMarks,solution,testDate).lastInsertRowid;res.status(201).json(db.prepare("SELECT * FROM tests WHERE id=?").get(id));});
app.post("/api/teacher/tests/:id/attach",auth,role("teacher"),uploadSingleFile,(req,res)=>attachFile(req,res,"tests"));
app.get("/api/files/tests/:id",auth,(req,res)=>downloadFile(req,res,"tests"));
app.post("/api/teacher/marks",auth,role("teacher"),(req,res)=>{const {testId,studentId,marks,remark}=req.body;const test=db.prepare("SELECT t.* FROM tests t JOIN classes c ON c.id=t.class_id WHERE t.id=? AND c.teacher_id=?").get(testId,req.user.id);const student=studentForTeacher(studentId,req.user.id);if(!test||!student)return res.status(404).json({error:"Test or student not found"});if(!Number.isFinite(Number(marks))||Number(marks)<0||Number(marks)>test.max_marks)return res.status(400).json({error:"Marks are outside the valid range"});db.prepare("INSERT INTO marks(test_id,student_id,marks,remark) VALUES(?,?,?,?) ON CONFLICT(test_id,student_id) DO UPDATE SET marks=excluded.marks,remark=excluded.remark").run(testId,student.id,Number(marks),remark||"");res.json({ok:true,percentage:pct(Number(marks),test.max_marks)});});

app.get("/api/teacher/attendance",auth,role("teacher"),(req,res)=>{const cls=classForReq(req);if(!cls)return res.json({class:null,records:[]});const date=req.query.date||today();const students=studentsForClass(cls.code);const records=db.prepare("SELECT * FROM attendance WHERE class_id=? AND attendance_date=?").all(cls.id,date);const map=new Map(records.map(r=>[r.student_id,r]));res.json({class:cls,date,students:students.map(s=>({student:s,status:map.get(s.id)?.status||null}))});});
app.post("/api/teacher/attendance",auth,role("teacher"),(req,res)=>{const cls=classForReq(req);const date=req.body.date||today();if(!validDate(date))return res.status(400).json({error:"Invalid attendance date"});if(!cls||!Array.isArray(req.body.records))return res.status(400).json({error:"Date and attendance records are required"});const stmt=db.prepare("INSERT INTO attendance(student_id,class_id,attendance_date,status) VALUES(?,?,?,?) ON CONFLICT(student_id,attendance_date) DO UPDATE SET class_id=excluded.class_id,status=excluded.status");const tx=db.transaction(rows=>rows.forEach(r=>{if(studentForTeacher(r.studentId,req.user.id)&&["present","absent"].includes(r.status))stmt.run(r.studentId,cls.id,date,r.status);}));tx(req.body.records);res.json({ok:true});});
app.get("/api/student/attendance",auth,role("student"),requireClass,(req,res)=>{
  const s=db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  const rows=db.prepare("SELECT attendance_date,status FROM attendance a JOIN classes c ON c.id=a.class_id WHERE a.student_id=? AND c.code=? ORDER BY attendance_date DESC").all(s.id,s.class_code);
  const present=rows.filter(x=>x.status==="present").length;
  const pctAttendance=rows.length?Number((present*100/rows.length).toFixed(1)):0;
  const consecutive=(list)=>{let count=0;for(let i=0;i<list.length;i++){if(list[i].status!=="present")break;if(i>0 && shiftDate(list[i-1].attendance_date,-1)!==list[i].attendance_date)break;count++;}return count;};
  let streak=consecutive(rows);
  let longest=0,run=0;
  const asc=[...rows].reverse();
  for(let i=0;i<asc.length;i++){if(asc[i].status==="present" && (i===0 || shiftDate(asc[i-1].attendance_date,1)===asc[i].attendance_date))run++;else if(asc[i].status==="present")run=1;else run=0;longest=Math.max(longest,run);}
  res.json({records:rows,percentage:pctAttendance,present,absent:rows.length-present,currentStreak:streak,longestStreak:longest,recordedDays:rows.length});
});

app.get("/api/teacher/syllabus",auth,role("teacher"),(req,res)=>{const cls=classForReq(req);res.json({class:cls,chapters:cls?db.prepare("SELECT * FROM syllabus_chapters WHERE class_id=? ORDER BY subject,id").all(cls.id):[]});});
app.post("/api/teacher/syllabus",auth,role("teacher"),(req,res)=>{const cls=classForReq(req);const subject=String(req.body.subject||"").trim(),chapter=String(req.body.chapter||"").trim(),status=req.body.status;if(!cls||!subject||!chapter||!["not-started","in-progress","completed"].includes(status))return res.status(400).json({error:"Subject, chapter and valid status are required"});const id=db.prepare("INSERT INTO syllabus_chapters(class_id,subject,chapter,status) VALUES(?,?,?,?) ON CONFLICT(class_id,subject,chapter) DO UPDATE SET status=excluded.status,updated_at=CURRENT_TIMESTAMP").run(cls.id,subject,chapter,status).lastInsertRowid;res.json({ok:true,id});});
app.get("/api/student/syllabus",auth,role("student"),requireClass,(req,res)=>{const s=db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);const rows=db.prepare("SELECT * FROM syllabus_chapters sc JOIN classes c ON c.id=sc.class_id WHERE c.code=? ORDER BY subject,id").all(s.class_code);const subjects=[...new Set(rows.map(r=>r.subject))].map(subject=>{const x=rows.filter(r=>r.subject===subject);return {subject,total:x.length,completed:x.filter(r=>r.status==='completed').length,inProgress:x.filter(r=>r.status==='in-progress').length,percentage:x.length?Math.round(x.filter(r=>r.status==='completed').length*100/x.length):0,chapters:x}});res.json({subjects});});

app.get("/api/student/dashboard",auth,role("student"),requireClass,(req,res)=>{const student=db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);const homework=db.prepare(`SELECT h.*,hs.note submission_note,hs.submitted_at,CASE WHEN hs.status IS NOT NULL THEN hs.status WHEN h.due_date IS NOT NULL AND h.due_date<? THEN 'late' ELSE 'pending' END status,hs.feedback,hs.reviewed_at FROM homework h LEFT JOIN homework_submissions hs ON hs.homework_id=h.id AND hs.student_id=? JOIN classes c ON c.id=h.class_id WHERE c.code=? ORDER BY h.created_at DESC`).all(student.id,today(),student.class_code);const tests=db.prepare(`SELECT t.*,m.marks,m.remark,ROUND(m.marks*100.0/t.max_marks,1) percentage FROM tests t LEFT JOIN marks m ON m.test_id=t.id AND m.student_id=? JOIN classes c ON c.id=t.class_id WHERE c.code=? ORDER BY t.test_date DESC,t.created_at DESC`).all(student.id,student.class_code);const logs=db.prepare("SELECT * FROM study_logs WHERE student_id=? ORDER BY study_date DESC,id DESC").all(student.id);const week=db.prepare("SELECT COALESCE(SUM(minutes),0)m FROM study_logs WHERE student_id=? AND study_date>=?").get(student.id,startOfWeek()).m;const prev=db.prepare("SELECT COALESCE(SUM(minutes),0)m FROM study_logs WHERE student_id=? AND study_date>=? AND study_date<?").get(student.id,previousWeekStart(),startOfWeek()).m;const avg=tests.filter(t=>t.marks!=null).reduce((a,t)=>a+t.percentage,0)/(tests.filter(t=>t.marks!=null).length||1);const attendance=db.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) present FROM attendance a JOIN classes c ON c.id=a.class_id WHERE a.student_id=? AND c.code=?").get(student.id,student.class_code);const syllabus=db.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed FROM syllabus_chapters sc JOIN classes c ON c.id=sc.class_id WHERE c.code=?").get(student.class_code);res.json({student,homework,tests,logs,stats:{tests_taken:tests.filter(t=>t.marks!=null).length,average_percentage:Number(avg.toFixed(1)),total_study_minutes:logs.reduce((a,x)=>a+x.minutes,0),week_minutes:week,previous_week_minutes:prev,study_trend:trend(week,prev),attendance_percentage:attendance.total?Number((attendance.present*100/attendance.total).toFixed(1)):0,syllabus_percentage:syllabus.total?Math.round(syllabus.completed*100/syllabus.total):0},daily:db.prepare("SELECT study_date,SUM(minutes) minutes FROM study_logs WHERE student_id=? AND study_date>=? GROUP BY study_date ORDER BY study_date").all(student.id,dateDaysAgo(13)),subjects:db.prepare("SELECT subject,SUM(minutes) minutes FROM study_logs WHERE student_id=? GROUP BY subject ORDER BY minutes DESC").all(student.id),categories:db.prepare("SELECT category,SUM(minutes) minutes FROM study_logs WHERE student_id=? GROUP BY category").all(student.id)});});
app.post("/api/student/homework/:id/submit",auth,role("student"),requireClass,(req,res)=>{const h=db.prepare("SELECT h.* FROM homework h JOIN classes c ON c.id=h.class_id JOIN users u ON u.class_code=c.code WHERE h.id=? AND u.id=?").get(req.params.id,req.user.id);if(!h)return res.status(404).json({error:"Homework not found"});const status=h.due_date&&today()>h.due_date?"late":"submitted";const note=String(req.body.note||"").trim();if(note.length>5000)return res.status(400).json({error:"Submission note is too long"});db.prepare("INSERT INTO homework_submissions(homework_id,student_id,note,status) VALUES(?,?,?,?) ON CONFLICT(homework_id,student_id) DO UPDATE SET note=excluded.note,submitted_at=CURRENT_TIMESTAMP,status=excluded.status").run(h.id,req.user.id,note,status);res.json({ok:true,status});});
app.post("/api/student/study-log",auth,role("student"),requireClass,(req,res)=>{const {category,subject,minutes,studyDate,note}=req.body;const cleanSubject=String(subject||"").trim(),cleanNote=String(note||"").trim();if(!["tuition","self-study","outside"].includes(category)||!cleanSubject||cleanSubject.length>100||cleanNote.length>2000||!Number.isFinite(Number(minutes))||Number(minutes)<1||Number(minutes)>1440||!validDate(studyDate))return res.status(400).json({error:"Category, subject, minutes (1-1440) and valid date are required"});const id=db.prepare("INSERT INTO study_logs(student_id,category,subject,minutes,study_date,note) VALUES(?,?,?,?,?,?)").run(req.user.id,category,cleanSubject,Math.round(Number(minutes)),studyDate,cleanNote).lastInsertRowid;res.status(201).json(db.prepare("SELECT * FROM study_logs WHERE id=?").get(id));});

function buildActivityForClass(code,limit=20){
  const rows=[];
  rows.push(...db.prepare(`SELECT 'study' type,u.id student_id,u.name student,s.subject title,s.minutes detail,s.created_at created_at FROM study_logs s JOIN users u ON u.id=s.student_id WHERE u.class_code=? ORDER BY s.created_at DESC LIMIT ?`).all(code,limit));
  rows.push(...db.prepare(`SELECT 'homework' type,u.id student_id,u.name student,h.title title,hs.status detail,COALESCE(hs.submitted_at,hs.reviewed_at) created_at FROM homework_submissions hs JOIN users u ON u.id=hs.student_id JOIN homework h ON h.id=hs.homework_id JOIN classes c ON c.id=h.class_id WHERE c.code=? ORDER BY COALESCE(hs.reviewed_at,hs.submitted_at) DESC LIMIT ?`).all(code,limit));
  rows.push(...db.prepare(`SELECT 'test' type,u.id student_id,u.name student,t.title title,ROUND(m.marks*100.0/t.max_marks,1) detail,m.created_at created_at FROM marks m JOIN users u ON u.id=m.student_id JOIN tests t ON t.id=m.test_id JOIN classes c ON c.id=t.class_id WHERE c.code=? ORDER BY COALESCE(t.test_date,t.created_at) DESC LIMIT ?`).all(code,limit));
  rows.push(...db.prepare(`SELECT 'attendance' type,u.id student_id,u.name student,'Attendance' title,a.status detail,a.created_at created_at FROM attendance a JOIN users u ON u.id=a.student_id JOIN classes c ON c.id=a.class_id WHERE c.code=? ORDER BY a.created_at DESC LIMIT ?`).all(code,limit));
  rows.push(...db.prepare(`SELECT 'syllabus' type,NULL student_id,'Class' student,subject title,status detail,updated_at created_at FROM syllabus_chapters sc JOIN classes c ON c.id=sc.class_id WHERE c.code=? ORDER BY updated_at DESC LIMIT ?`).all(code,limit));
  return rows.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,limit);
}

app.get("/api/teacher/activity",auth,role("teacher"),(req,res)=>{const cls=classForReq(req);res.json({activity:cls?buildActivityForClass(cls.code,50):[]});});
app.get("/api/student/activity",auth,role("student"),requireClass,(req,res)=>{const s=db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);res.json({activity:buildActivityForClass(s.class_code,50).filter(x=>x.student_id===s.id)});});

// ---------------------------------------------------------------------------
// Teacher: classes, student join requests and blocks
// ---------------------------------------------------------------------------
app.get("/api/teacher/context", auth, role("teacher"), (req, res) => {
  const classes = db.prepare(`SELECT c.id,c.name,c.code,c.suspended,c.created_at,
      (SELECT COUNT(*) FROM users s WHERE s.role='student' AND s.class_code=c.code) student_count,
      (SELECT COUNT(*) FROM join_requests r WHERE r.class_id=c.id AND r.status='pending') pending_requests
    FROM classes c WHERE c.teacher_id=? ORDER BY c.id`).all(req.user.id).map(c => ({ ...c, suspended: Boolean(c.suspended) }));
  res.json({
    classes,
    institute: instituteSummaryFor(req.user),
    pending_total: classes.reduce((sum, c) => sum + c.pending_requests, 0),
    read_only: req.user.readOnly,
  });
});

app.post("/api/teacher/classes", auth, role("teacher"), (req, res) => {
  const name = boundedText(req.body?.name, 100, true);
  let code = cleanCode(req.body?.code);
  if (!name) return res.status(400).json({ error: "Class name is required (100 characters or fewer)" });
  if (code && !CODE_PATTERN.test(code)) return res.status(400).json({ error: "Class code must be 4 to 12 letters or numbers" });
  if (code && codeInUse(code)) return res.status(409).json({ error: "That class code is already taken. Choose another or leave it blank to generate one." });
  if (!code) code = generateUniqueCode();
  let id;
  try {
    id = db.prepare("INSERT INTO classes(teacher_id,name,code) VALUES(?,?,?)").run(req.user.id, name, code).lastInsertRowid;
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ error: "That class code is already taken" });
    throw error;
  }
  res.status(201).json({ id: Number(id), name, code, suspended: false, student_count: 0, pending_requests: 0 });
});

function requestForTeacher(idParam, teacherId) {
  const id = parseId(idParam);
  const row = id && db.prepare(`SELECT r.*,c.teacher_id,c.code class_code,c.name class_name,c.suspended class_suspended
    FROM join_requests r JOIN classes c ON c.id=r.class_id WHERE r.id=? AND c.teacher_id=?`).get(id, teacherId);
  if (!row) throw new HttpError(404, "Join request not found");
  return row;
}

app.get("/api/teacher/join-requests", auth, role("teacher"), (req, res) => {
  const pending = db.prepare(`SELECT r.id,r.created_at,s.id student_id,s.name student_name,s.email student_email,c.id class_id,c.name class_name,c.code class_code
    FROM join_requests r JOIN users s ON s.id=r.student_id JOIN classes c ON c.id=r.class_id
    WHERE c.teacher_id=? AND r.status='pending' ORDER BY r.id`).all(req.user.id);
  const blocked = db.prepare("SELECT id,student_email,student_name,created_at FROM teacher_blocks WHERE teacher_id=? ORDER BY id DESC").all(req.user.id);
  res.json({ pending, blocked });
});

app.post("/api/teacher/join-requests/:id/approve", auth, role("teacher"), (req, res) => {
  const request = requestForTeacher(req.params.id, req.user.id);
  if (request.status !== "pending") return res.status(409).json({ error: "This request has already been handled" });
  if (request.class_suspended) return res.status(403).json({ error: "This class has been suspended by StudyTrack.", code: "CLASS_SUSPENDED" });
  const student = db.prepare("SELECT id,class_code FROM users WHERE id=? AND role='student'").get(request.student_id);
  if (!student) return res.status(404).json({ error: "This student account no longer exists" });
  if (student.class_code) {
    db.prepare("UPDATE join_requests SET status='cancelled',resolved_at=CURRENT_TIMESTAMP WHERE id=?").run(request.id);
    return res.status(409).json({ error: "This student already belongs to a class" });
  }
  if (req.user.institute_id) {
    const inst = db.prepare("SELECT * FROM institutes WHERE id=?").get(req.user.institute_id);
    if (instituteEnforced(inst) && inst.max_students != null && studentCountFor(inst.id) >= inst.max_students) {
      return res.status(409).json({ error: "Your institute has reached its student limit. Contact StudyTrack to increase it.", code: "LIMIT_STUDENTS" });
    }
  }
  db.transaction(() => {
    db.prepare("UPDATE users SET class_code=? WHERE id=? AND class_code IS NULL").run(request.class_code, student.id);
    db.prepare("UPDATE join_requests SET status='approved',resolved_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(request.id);
  })();
  res.json({ ok: true });
});

// mode "remove": the request is closed and the student is told it was declined.
// mode "block": same, plus the student's email is blocked from every class of
// this teacher. The caller must send confirm:true for a block.
app.post("/api/teacher/join-requests/:id/deny", auth, role("teacher"), (req, res) => {
  const mode = req.body?.mode;
  if (!["remove", "block"].includes(mode)) return res.status(400).json({ error: "Choose Deny & Remove or Deny & Block" });
  if (mode === "block" && req.body?.confirm !== true) return res.status(400).json({ error: "Blocking must be confirmed", code: "CONFIRM_REQUIRED" });
  const request = requestForTeacher(req.params.id, req.user.id);
  if (request.status !== "pending") return res.status(409).json({ error: "This request has already been handled" });
  const student = db.prepare("SELECT id,name,email FROM users WHERE id=?").get(request.student_id);
  db.transaction(() => {
    db.prepare("UPDATE join_requests SET status=?,resolved_at=CURRENT_TIMESTAMP WHERE id=?").run(mode === "block" ? "blocked" : "denied", request.id);
    if (mode === "block" && student) {
      db.prepare(`INSERT INTO teacher_blocks(teacher_id,student_id,student_email,student_name) VALUES(?,?,?,?)
        ON CONFLICT(teacher_id,student_email) DO UPDATE SET student_id=excluded.student_id,student_name=excluded.student_name`).run(req.user.id, student.id, student.email, student.name);
    }
  })();
  res.json({ ok: true, blocked: mode === "block" });
});

app.delete("/api/teacher/blocks/:id", auth, role("teacher"), (req, res) => {
  const id = parseId(req.params.id);
  const block = id && db.prepare("SELECT * FROM teacher_blocks WHERE id=? AND teacher_id=?").get(id, req.user.id);
  if (!block) return res.status(404).json({ error: "Blocked student not found" });
  db.transaction(() => {
    db.prepare("DELETE FROM teacher_blocks WHERE id=?").run(block.id);
    if (block.student_id) {
      // Their old "blocked" outcome becomes an ordinary decline so the student is no longer told they are blocked.
      db.prepare("UPDATE join_requests SET status='denied' WHERE status='blocked' AND student_id=? AND class_id IN (SELECT id FROM classes WHERE teacher_id=?)").run(block.student_id, req.user.id);
    }
  })();
  res.json({ ok: true });
});

// Removes a student from the teacher's class (for example after approving the
// wrong person). The student keeps their account and can request a class again.
app.delete("/api/teacher/students/:id", auth, role("teacher"), (req, res) => {
  const id = parseId(req.params.id);
  const student = id && studentForTeacher(id, req.user.id);
  if (!student) return res.status(404).json({ error: "Student not found" });
  db.prepare("UPDATE users SET class_code=NULL WHERE id=? AND role='student'").run(student.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Student: join a class with a class code and wait for approval
// ---------------------------------------------------------------------------
app.get("/api/student/class-status", auth, role("student"), (req, res) => {
  const me = db.prepare("SELECT id,class_code FROM users WHERE id=?").get(req.user.id);
  if (me.class_code) {
    const info = db.prepare("SELECT c.name class_name,t.name teacher_name FROM classes c JOIN users t ON t.id=c.teacher_id WHERE c.code=?").get(me.class_code);
    return res.json({ joined: true, class: info ? { name: info.class_name, teacherName: info.teacher_name } : null, pending: null, lastDecision: null });
  }
  const last = db.prepare(`SELECT r.id,r.status,r.created_at,r.resolved_at,c.name class_name,t.name teacher_name
    FROM join_requests r JOIN classes c ON c.id=r.class_id JOIN users t ON t.id=c.teacher_id
    WHERE r.student_id=? ORDER BY r.id DESC LIMIT 1`).get(me.id);
  const shape = r => ({ id: r.id, teacherName: r.teacher_name, className: r.class_name, createdAt: r.created_at, resolvedAt: r.resolved_at });
  res.json({
    joined: false,
    class: null,
    pending: last?.status === "pending" ? shape(last) : null,
    lastDecision: last && (last.status === "denied" || last.status === "blocked") ? { ...shape(last), status: last.status } : null,
  });
});

app.post("/api/student/join-request", auth, role("student"), joinCodeLimiter.guard, (req, res) => {
  const me = db.prepare("SELECT id,name,email,class_code FROM users WHERE id=?").get(req.user.id);
  if (me.class_code) return res.status(409).json({ error: "You are already part of a class" });
  if (db.prepare("SELECT 1 FROM join_requests WHERE student_id=? AND status='pending'").get(me.id)) {
    return res.status(409).json({ error: "You already have a pending request. Cancel it first to send a new one." });
  }
  const code = cleanCode(req.body?.classCode);
  const cls = code && db.prepare("SELECT c.*,t.name teacher_name,t.banned teacher_banned,t.institute_id FROM classes c JOIN users t ON t.id=c.teacher_id WHERE c.code=?").get(code);
  if (!cls) {
    joinCodeLimiter.fail(req);
    return res.status(404).json({ error: "No class found with that code. Check the code with your teacher." });
  }
  if (db.prepare("SELECT 1 FROM teacher_blocks WHERE teacher_id=? AND (student_email=? OR student_id=?)").get(cls.teacher_id, me.email, me.id)) {
    return res.status(403).json({ error: `${cls.teacher_name} didn't allow you to join their class.`, code: "BLOCKED" });
  }
  const inst = cls.institute_id ? db.prepare("SELECT * FROM institutes WHERE id=?").get(cls.institute_id) : null;
  if (cls.suspended || cls.teacher_banned || instituteBlock(inst, "student")) {
    return res.status(403).json({ error: "This class isn't accepting students right now.", code: "CLASS_UNAVAILABLE" });
  }
  let id;
  try {
    id = db.prepare("INSERT INTO join_requests(student_id,class_id) VALUES(?,?)").run(me.id, cls.id).lastInsertRowid;
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ error: "You already have a pending request. Cancel it first to send a new one." });
    throw error;
  }
  res.status(201).json({ request: { id: Number(id), teacherName: cls.teacher_name, className: cls.name } });
});

app.post("/api/student/join-request/cancel", auth, role("student"), (req, res) => {
  const result = db.prepare("UPDATE join_requests SET status='cancelled',resolved_at=CURRENT_TIMESTAMP WHERE student_id=? AND status='pending'").run(req.user.id);
  if (!result.changes) return res.status(404).json({ error: "You have no pending request" });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Coaching institutes (teacher side)
// ---------------------------------------------------------------------------
function membershipFor(req) {
  const me = db.prepare("SELECT institute_id,institute_role FROM users WHERE id=?").get(req.user.id);
  const inst = me?.institute_id ? db.prepare("SELECT * FROM institutes WHERE id=?").get(me.institute_id) : null;
  if (!inst) throw new HttpError(404, "You are not part of a coaching institute", "NO_INSTITUTE");
  return { inst, myRole: me.institute_role || "teacher" };
}
function activeMembershipFor(req) {
  const membership = membershipFor(req);
  if (membership.inst.status !== "active") throw new HttpError(409, "Your institute is not active yet. StudyTrack is still reviewing it.", "INSTITUTE_NOT_ACTIVE");
  return membership;
}
function memberById(instituteId, idParam) {
  const id = parseId(idParam);
  const member = id && db.prepare("SELECT id,name,email,institute_role,institute_note FROM users WHERE id=? AND institute_id=? AND role='teacher'").get(id, instituteId);
  if (!member) throw new HttpError(404, "Teacher not found in this institute");
  return member;
}
function instituteHomeData(inst, viewerId, viewerRole) {
  const members = db.prepare(`SELECT id,name,email,institute_role,institute_note FROM users WHERE institute_id=? AND role='teacher'
    ORDER BY CASE institute_role WHEN 'head' THEN 0 WHEN 'co_head' THEN 1 ELSE 2 END,name COLLATE NOCASE`).all(inst.id);
  const canSeeAllCodes = isHeadRole(viewerRole);
  return members.map(m => {
    const classes = db.prepare(`SELECT c.id,c.name,c.code,c.suspended,
        (SELECT COUNT(*) FROM users s WHERE s.role='student' AND s.class_code=c.code) student_count
      FROM classes c WHERE c.teacher_id=? ORDER BY c.id`).all(m.id);
    const perf = db.prepare("SELECT ROUND(AVG(mk.marks*100.0/t.max_marks),1) avg FROM marks mk JOIN tests t ON t.id=mk.test_id WHERE t.teacher_id=?").get(m.id);
    const att = db.prepare("SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN a.status='present' THEN 1 ELSE 0 END),0) present FROM attendance a JOIN classes c ON c.id=a.class_id WHERE c.teacher_id=?").get(m.id);
    const hw = db.prepare("SELECT COUNT(*) n FROM homework WHERE teacher_id=?").get(m.id);
    return {
      id: m.id,
      name: m.name,
      email: m.email,
      role: m.institute_role || "teacher",
      note: m.institute_note,
      is_me: m.id === viewerId,
      classes: classes.map(c => ({
        id: c.id,
        name: c.name,
        student_count: c.student_count,
        suspended: Boolean(c.suspended),
        code: canSeeAllCodes || m.id === viewerId ? c.code : undefined,
      })),
      class_count: classes.length,
      student_count: classes.reduce((sum, c) => sum + c.student_count, 0),
      average_percentage: perf.avg ?? null,
      attendance_percentage: att.total ? Number((att.present * 100 / att.total).toFixed(1)) : null,
      homework_count: hw.n,
    };
  });
}

app.get("/api/institute/home", auth, role("teacher"), (req, res) => {
  const { inst, myRole } = membershipFor(req);
  const summary = { id: inst.id, name: inst.name, status: inst.status, status_reason: inst.status_reason, code: isHeadRole(myRole) ? inst.code : undefined };
  if (inst.status !== "active") return res.json({ institute: summary, myRole, teachers: null });
  res.json({ institute: summary, myRole, teachers: instituteHomeData(inst, req.user.id, myRole) });
});

// An independent teacher who already has an account joins with a coaching code.
app.post("/api/institute/join", auth, role("teacher"), joinCodeLimiter.guard, (req, res) => {
  if (req.user.institute_id) return res.status(409).json({ error: "You already belong to a coaching institute" });
  const inst = findJoinableInstitute(cleanCode(req.body?.code));
  if (!inst) {
    joinCodeLimiter.fail(req);
    return res.status(404).json({ error: "No active coaching institute found with that code. Check it with your institute head." });
  }
  assertTeacherSeat(inst);
  db.prepare("UPDATE users SET institute_id=?,institute_role='teacher' WHERE id=? AND institute_id IS NULL").run(inst.id, req.user.id);
  res.json({ ok: true, institute: { id: inst.id, name: inst.name, status: inst.status, role: "teacher" } });
});

app.post("/api/institute/members/:id/role", auth, role("teacher"), (req, res) => {
  const { inst, myRole } = activeMembershipFor(req);
  if (!isHeadRole(myRole)) return res.status(403).json({ error: "Only institute heads can change roles" });
  const newRole = req.body?.role;
  if (!["co_head", "teacher"].includes(newRole)) return res.status(400).json({ error: "Role must be co_head or teacher" });
  const member = memberById(inst.id, req.params.id);
  if (member.institute_role === "head") return res.status(403).json({ error: "The institute head's role can't be changed" });
  const current = member.institute_role || "teacher";
  if (current === newRole) return res.json({ ok: true, role: newRole });
  const steppingDown = member.id === req.user.id && newRole === "teacher";
  if (myRole === "co_head" && !(newRole === "co_head" || steppingDown)) {
    return res.status(403).json({ error: "Only the institute head can remove another co-head's role" });
  }
  db.prepare("UPDATE users SET institute_role=? WHERE id=?").run(newRole, member.id);
  res.json({ ok: true, role: newRole });
});

app.post("/api/institute/members/:id/note", auth, role("teacher"), (req, res) => {
  const { inst, myRole } = activeMembershipFor(req);
  if (!isHeadRole(myRole)) return res.status(403).json({ error: "Only institute heads can write feedback notes" });
  const note = boundedText(req.body?.note, 300, false);
  if (note === null) return res.status(400).json({ error: "Notes must be 300 characters or fewer" });
  const member = memberById(inst.id, req.params.id);
  if (member.institute_role === "head") return res.status(403).json({ error: "Notes can't be added to the institute head" });
  db.prepare("UPDATE users SET institute_note=? WHERE id=?").run(note, member.id);
  res.json({ ok: true });
});

app.delete("/api/institute/members/:id", auth, role("teacher"), (req, res) => {
  const { inst, myRole } = activeMembershipFor(req);
  if (!isHeadRole(myRole)) return res.status(403).json({ error: "Only institute heads can remove teachers" });
  const member = memberById(inst.id, req.params.id);
  if (member.institute_role === "head") return res.status(403).json({ error: "The institute head can't be removed" });
  if (member.id === req.user.id) return res.status(400).json({ error: "Use Leave institute to remove yourself" });
  if (myRole === "co_head" && member.institute_role === "co_head") return res.status(403).json({ error: "Only the institute head can remove a co-head" });
  db.prepare("UPDATE users SET institute_id=NULL,institute_role=NULL,institute_note='' WHERE id=?").run(member.id);
  res.json({ ok: true });
});

app.post("/api/institute/leave", auth, role("teacher"), (req, res) => {
  const { myRole } = membershipFor(req);
  if (myRole === "head") return res.status(403).json({ error: "The institute head can't leave. Contact StudyTrack support to close or transfer the institute." });
  db.prepare("UPDATE users SET institute_id=NULL,institute_role=NULL,institute_note='' WHERE id=?").run(req.user.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Owner admin API. Protected by ADMIN_KEY; issues its own short-lived token
// that normal user tokens cannot be used as (and vice versa).
// ---------------------------------------------------------------------------
async function removeStorageObjects(paths) {
  const list = [...new Set(paths.filter(Boolean))];
  if (!list.length || !storageConfigured()) return;
  const bucket = supabase.storage.from(SUPABASE_BUCKET);
  for (let i = 0; i < list.length; i += 100) {
    try { await bucket.remove(list.slice(i, i + 100)); } catch (error) { console.error("Storage cleanup failed:", error?.message || error); }
  }
}
function placeholders(list) { return list.map(() => "?").join(","); }
function filePathsForTeachers(teacherIds) {
  if (!teacherIds.length) return [];
  const marks = placeholders(teacherIds);
  const homework = db.prepare(`SELECT h.file_url p FROM homework h JOIN classes c ON c.id=h.class_id WHERE c.teacher_id IN (${marks}) AND h.file_url IS NOT NULL`).all(...teacherIds);
  const tests = db.prepare(`SELECT x.file_url p FROM tests x JOIN classes c ON c.id=x.class_id WHERE c.teacher_id IN (${marks}) AND x.file_url IS NOT NULL`).all(...teacherIds);
  return [...homework, ...tests].map(r => r.p);
}
function filePathsForClass(classId) {
  const homework = db.prepare("SELECT file_url p FROM homework WHERE class_id=? AND file_url IS NOT NULL").all(classId);
  const tests = db.prepare("SELECT file_url p FROM tests WHERE class_id=? AND file_url IS NOT NULL").all(classId);
  return [...homework, ...tests].map(r => r.p);
}
function dbFileBytes() {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) { try { total += fs.statSync(dbPath + suffix).size; } catch { /* file may not exist */ } }
  return total;
}
function adminInstituteRow(inst) {
  const head = inst.head_id ? db.prepare("SELECT name,email FROM users WHERE id=?").get(inst.head_id) : null;
  return {
    ...inst,
    read_only: Boolean(inst.read_only),
    head_name: head?.name || "",
    head_email: head?.email || inst.owner_email,
    usage: instituteUsage(inst.id),
  };
}
function adminInstituteOr404(idParam) {
  const id = parseId(idParam);
  const inst = id && db.prepare("SELECT * FROM institutes WHERE id=?").get(id);
  if (!inst) throw new HttpError(404, "Institute not found");
  return inst;
}
function assertManaged(inst) {
  if (inst.control_mode === "independent") {
    throw new HttpError(409, "This institute is independent. Return it to managed control before changing its access, limits or data.", "INDEPENDENT");
  }
}

app.post("/api/admin/login", adminLimiter.guard, (req, res) => {
  const configured = String(process.env.ADMIN_KEY || "");
  if (!configured) return res.status(503).json({ error: "Admin access is not configured. Set ADMIN_KEY on the server." });
  if (IS_PRODUCTION && configured.length < 12) return res.status(503).json({ error: "ADMIN_KEY must be at least 12 characters in production." });
  if (!safeEqual(String(req.body?.key ?? ""), configured)) {
    adminLimiter.fail(req);
    return res.status(401).json({ error: "Incorrect admin key" });
  }
  adminLimiter.clear(req);
  res.json({ token: jwt.sign({ role: "admin" }, JWT_SECRET, { audience: ADMIN_AUDIENCE, expiresIn: "12h" }) });
});

app.get("/api/admin/overview", adminAuth, (req, res) => {
  const count = (sql, ...params) => db.prepare(sql).get(...params).n;
  const statusCounts = Object.fromEntries(db.prepare("SELECT status,COUNT(*) n FROM institutes GROUP BY status").all().map(r => [r.status, r.n]));
  const storage = count("SELECT COALESCE(SUM(file_size),0) n FROM homework") + count("SELECT COALESCE(SUM(file_size),0) n FROM tests");
  res.json({
    institutes: {
      total: count("SELECT COUNT(*) n FROM institutes"),
      pending: statusCounts.pending || 0,
      active: statusCounts.active || 0,
      suspended: statusCounts.suspended || 0,
      banned: statusCounts.banned || 0,
      rejected: statusCounts.rejected || 0,
      independent: count("SELECT COUNT(*) n FROM institutes WHERE control_mode='independent'"),
    },
    teachers: count("SELECT COUNT(*) n FROM users WHERE role='teacher'"),
    students: count("SELECT COUNT(*) n FROM users WHERE role='student'"),
    classes: count("SELECT COUNT(*) n FROM classes"),
    suspended_classes: count("SELECT COUNT(*) n FROM classes WHERE suspended=1"),
    storage_bytes: storage,
    database_bytes: dbFileBytes(),
  });
});

app.get("/api/admin/log", adminAuth, (req, res) => {
  res.json({ log: db.prepare("SELECT * FROM admin_log ORDER BY id DESC LIMIT 60").all() });
});

app.get("/api/admin/institutes", adminAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM institutes ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,id DESC").all();
  res.json({ institutes: rows.map(adminInstituteRow) });
});

app.get("/api/admin/institutes/:id", adminAuth, (req, res) => {
  const inst = adminInstituteOr404(req.params.id);
  const teachers = db.prepare("SELECT id,name,email,institute_role,banned,created_at FROM users WHERE institute_id=? AND role='teacher' ORDER BY id").all(inst.id).map(t => ({
    ...t,
    banned: Boolean(t.banned),
    classes: db.prepare(`SELECT c.id,c.name,c.code,c.suspended,(SELECT COUNT(*) FROM users s WHERE s.role='student' AND s.class_code=c.code) student_count
      FROM classes c WHERE c.teacher_id=? ORDER BY c.id`).all(t.id).map(c => ({ ...c, suspended: Boolean(c.suspended) })),
  }));
  res.json({ institute: adminInstituteRow(inst), teachers });
});

// action: approve | reject | suspend | reactivate | ban | unban
app.post("/api/admin/institutes/:id/status", adminAuth, (req, res) => {
  const inst = adminInstituteOr404(req.params.id);
  const action = String(req.body?.action || "");
  const reason = boundedText(req.body?.reason, 300, false);
  if (reason === null) return res.status(400).json({ error: "Reason must be 300 characters or fewer" });
  const transitions = {
    approve: { from: ["pending"], to: "active" },
    reject: { from: ["pending"], to: "rejected" },
    suspend: { from: ["active"], to: "suspended" },
    reactivate: { from: ["suspended"], to: "active" },
    ban: { from: ["active", "suspended"], to: "banned" },
    unban: { from: ["banned"], to: "active" },
  };
  const rule = transitions[action];
  if (!rule) return res.status(400).json({ error: "Unknown action" });
  assertManaged(inst);
  if (!rule.from.includes(inst.status)) return res.status(409).json({ error: `You can't ${action} an institute that is ${inst.status}` });
  const keepReason = ["reject", "suspend", "ban"].includes(action) ? reason : "";
  db.prepare("UPDATE institutes SET status=?,status_reason=?,approved_at=CASE WHEN ?='approve' THEN CURRENT_TIMESTAMP ELSE approved_at END WHERE id=?").run(rule.to, keepReason, action, inst.id);
  logAdmin(action, "institute", inst.id, `${inst.name} (${inst.code})`, reason || "");
  res.json({ institute: adminInstituteRow(db.prepare("SELECT * FROM institutes WHERE id=?").get(inst.id)) });
});

app.patch("/api/admin/institutes/:id/limits", adminAuth, (req, res) => {
  const inst = adminInstituteOr404(req.params.id);
  assertManaged(inst);
  const maxTeachers = optionalInt(req.body?.max_teachers, 1, 100000, "Teacher limit");
  const maxStudents = optionalInt(req.body?.max_students, 1, 1000000, "Student limit");
  const storageLimit = optionalInt(req.body?.storage_limit_mb, 1, 10000000, "Storage limit");
  const readOnly = req.body?.read_only === true ? 1 : 0;
  db.prepare("UPDATE institutes SET max_teachers=?,max_students=?,storage_limit_mb=?,read_only=? WHERE id=?").run(maxTeachers, maxStudents, storageLimit, readOnly, inst.id);
  logAdmin("limits", "institute", inst.id, `${inst.name} (${inst.code})`, `teachers=${maxTeachers ?? "unlimited"} students=${maxStudents ?? "unlimited"} storageMB=${storageLimit ?? "unlimited"} readOnly=${Boolean(readOnly)}`);
  res.json({ institute: adminInstituteRow(db.prepare("SELECT * FROM institutes WHERE id=?").get(inst.id)) });
});

// "independent": the owner releases control after payment. Suspension, bans,
// limits and read-only mode no longer apply and the admin panel can no longer
// change them until the institute is explicitly returned to "managed".
app.patch("/api/admin/institutes/:id/control", adminAuth, (req, res) => {
  const inst = adminInstituteOr404(req.params.id);
  const mode = req.body?.mode;
  if (!["independent", "managed"].includes(mode)) return res.status(400).json({ error: "Mode must be independent or managed" });
  if (mode === inst.control_mode) return res.json({ institute: adminInstituteRow(inst) });
  if (mode === "independent") {
    if (inst.status !== "active") return res.status(409).json({ error: "Only an active institute can be made independent. Approve or reactivate it first." });
    db.transaction(() => {
      db.prepare("UPDATE institutes SET control_mode='independent',read_only=0,max_teachers=NULL,max_students=NULL,storage_limit_mb=NULL WHERE id=?").run(inst.id);
      db.prepare("UPDATE classes SET suspended=0,suspend_reason='' WHERE teacher_id IN (SELECT id FROM users WHERE institute_id=?)").run(inst.id);
      db.prepare("UPDATE users SET banned=0,ban_reason='' WHERE institute_id=?").run(inst.id);
    })();
  } else {
    db.prepare("UPDATE institutes SET control_mode='managed' WHERE id=?").run(inst.id);
  }
  logAdmin(mode === "independent" ? "make-independent" : "return-to-managed", "institute", inst.id, `${inst.name} (${inst.code})`);
  res.json({ institute: adminInstituteRow(db.prepare("SELECT * FROM institutes WHERE id=?").get(inst.id)) });
});

app.patch("/api/admin/institutes/:id/note", adminAuth, (req, res) => {
  const inst = adminInstituteOr404(req.params.id);
  const note = boundedText(req.body?.note, 1000, false);
  if (note === null) return res.status(400).json({ error: "Note must be 1000 characters or fewer" });
  db.prepare("UPDATE institutes SET admin_note=? WHERE id=?").run(note, inst.id);
  res.json({ ok: true });
});

// withData=false: the institute record is removed and its teachers become ordinary independent teachers.
// withData=true : the institute, its teacher accounts, their classes and all class data are removed; students stay registered but are left without a class.
app.delete("/api/admin/institutes/:id", adminAuth, async (req, res) => {
  const inst = adminInstituteOr404(req.params.id);
  assertManaged(inst);
  const withData = String(req.query.withData || "") === "true";
  const teacherIds = db.prepare("SELECT id FROM users WHERE institute_id=? AND role='teacher'").all(inst.id).map(r => r.id);
  let paths = [];
  db.transaction(() => {
    if (withData && teacherIds.length) {
      paths = filePathsForTeachers(teacherIds);
      const marks = placeholders(teacherIds);
      db.prepare(`UPDATE users SET class_code=NULL WHERE role='student' AND class_code IN (SELECT code FROM classes WHERE teacher_id IN (${marks}))`).run(...teacherIds);
      db.prepare(`DELETE FROM users WHERE id IN (${marks})`).run(...teacherIds);
    } else {
      db.prepare("UPDATE users SET institute_id=NULL,institute_role=NULL,institute_note='' WHERE institute_id=?").run(inst.id);
    }
    db.prepare("DELETE FROM institutes WHERE id=?").run(inst.id);
  })();
  await removeStorageObjects(paths);
  logAdmin(withData ? "delete-with-data" : "delete", "institute", inst.id, `${inst.name} (${inst.code})`, `${teacherIds.length} teacher(s)`);
  res.json({ ok: true, teachers: teacherIds.length, withData });
});

app.get("/api/admin/classes", adminAuth, (req, res) => {
  const rows = db.prepare(`SELECT c.id,c.name,c.code,c.suspended,c.suspend_reason,c.created_at,
      t.id teacher_id,t.name teacher_name,t.email teacher_email,t.banned teacher_banned,
      i.id institute_id,i.name institute_name,i.code institute_code,i.control_mode,
      (SELECT COUNT(*) FROM users s WHERE s.role='student' AND s.class_code=c.code) student_count,
      (SELECT COALESCE(SUM(h.file_size),0) FROM homework h WHERE h.class_id=c.id) + (SELECT COALESCE(SUM(x.file_size),0) FROM tests x WHERE x.class_id=c.id) storage_bytes
    FROM classes c JOIN users t ON t.id=c.teacher_id LEFT JOIN institutes i ON i.id=t.institute_id ORDER BY c.id DESC`).all();
  res.json({ classes: rows.map(r => ({ ...r, suspended: Boolean(r.suspended), teacher_banned: Boolean(r.teacher_banned) })) });
});

function adminClassOr404(idParam) {
  const id = parseId(idParam);
  const row = id && db.prepare("SELECT c.*,t.institute_id,i.control_mode FROM classes c JOIN users t ON t.id=c.teacher_id LEFT JOIN institutes i ON i.id=t.institute_id WHERE c.id=?").get(id);
  if (!row) throw new HttpError(404, "Class not found");
  if (row.control_mode === "independent") throw new HttpError(409, "This class belongs to an independent institute and can't be changed from the admin panel.", "INDEPENDENT");
  return row;
}
app.post("/api/admin/classes/:id/status", adminAuth, (req, res) => {
  const cls = adminClassOr404(req.params.id);
  const action = String(req.body?.action || "");
  const reason = boundedText(req.body?.reason, 300, false);
  if (reason === null) return res.status(400).json({ error: "Reason must be 300 characters or fewer" });
  if (!["suspend", "reactivate"].includes(action)) return res.status(400).json({ error: "Unknown action" });
  db.prepare("UPDATE classes SET suspended=?,suspend_reason=? WHERE id=?").run(action === "suspend" ? 1 : 0, action === "suspend" ? reason : "", cls.id);
  logAdmin(action, "class", cls.id, `${cls.name} (${cls.code})`, reason || "");
  res.json({ ok: true });
});
app.delete("/api/admin/classes/:id", adminAuth, async (req, res) => {
  const cls = adminClassOr404(req.params.id);
  const paths = filePathsForClass(cls.id);
  db.transaction(() => {
    db.prepare("UPDATE users SET class_code=NULL WHERE role='student' AND class_code=?").run(cls.code);
    db.prepare("DELETE FROM classes WHERE id=?").run(cls.id);
  })();
  await removeStorageObjects(paths);
  logAdmin("delete", "class", cls.id, `${cls.name} (${cls.code})`);
  res.json({ ok: true });
});

app.get("/api/admin/teachers", adminAuth, (req, res) => {
  const rows = db.prepare(`SELECT u.id,u.name,u.email,u.banned,u.ban_reason,u.created_at,u.institute_id,u.institute_role,i.name institute_name,i.control_mode,
      (SELECT COUNT(*) FROM classes c WHERE c.teacher_id=u.id) class_count,
      (SELECT COUNT(*) FROM users s JOIN classes c ON c.code=s.class_code WHERE s.role='student' AND c.teacher_id=u.id) student_count
    FROM users u LEFT JOIN institutes i ON i.id=u.institute_id WHERE u.role='teacher' ORDER BY u.id DESC`).all();
  res.json({ teachers: rows.map(r => ({ ...r, banned: Boolean(r.banned) })) });
});
app.post("/api/admin/teachers/:id/status", adminAuth, (req, res) => {
  const id = parseId(req.params.id);
  const teacher = id && db.prepare("SELECT u.id,u.name,u.email,i.control_mode FROM users u LEFT JOIN institutes i ON i.id=u.institute_id WHERE u.id=? AND u.role='teacher'").get(id);
  if (!teacher) return res.status(404).json({ error: "Teacher not found" });
  if (teacher.control_mode === "independent") return res.status(409).json({ error: "This teacher belongs to an independent institute and can't be changed from the admin panel.", code: "INDEPENDENT" });
  const action = String(req.body?.action || "");
  const reason = boundedText(req.body?.reason, 300, false);
  if (reason === null) return res.status(400).json({ error: "Reason must be 300 characters or fewer" });
  if (!["ban", "unban"].includes(action)) return res.status(400).json({ error: "Unknown action" });
  db.prepare("UPDATE users SET banned=?,ban_reason=? WHERE id=?").run(action === "ban" ? 1 : 0, action === "ban" ? reason : "", teacher.id);
  logAdmin(action, "teacher", teacher.id, `${teacher.name} <${teacher.email}>`, reason || "");
  res.json({ ok: true });
});

// Unknown API routes return JSON instead of the web app.
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

const clientDist = path.resolve(__dirname, "../client/dist");
app.use(express.static(clientDist));
app.get(/^(?!\/api\/).*/, (req,res,next) => { res.sendFile(path.join(clientDist, "index.html"), err => { if (err) next(); }); });

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON in request body" });
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "Request body is too large" });
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});
const shutdown=()=>{try{db.close();}finally{process.exit(0);}};
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
if (!process.env.ADMIN_KEY) console.warn("ADMIN_KEY is not set: the owner admin panel at /admin is disabled until you set it.");
app.listen(PORT,()=>console.log(`StudyTrack API running on port ${PORT}`));
