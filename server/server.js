import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? "" : "studytrack-dev-secret");
if (process.env.NODE_ENV === "production" && !JWT_SECRET) { throw new Error("JWT_SECRET must be configured in production"); }
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
db.exec(`
CREATE INDEX IF NOT EXISTS idx_study_logs_student_date ON study_logs(student_id, study_date);
CREATE INDEX IF NOT EXISTS idx_study_logs_student_subject ON study_logs(student_id, subject);
CREATE INDEX IF NOT EXISTS idx_marks_student ON marks(student_id);
CREATE INDEX IF NOT EXISTS idx_homework_submissions_student ON homework_submissions(student_id);
CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON attendance(student_id, attendance_date);
CREATE INDEX IF NOT EXISTS idx_syllabus_class_subject ON syllabus_chapters(class_id, subject);
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
function classForTeacher(teacherId) { return db.prepare("SELECT * FROM classes WHERE teacher_id=? ORDER BY id LIMIT 1").get(teacherId); }
function studentForTeacher(studentId, teacherId) {
  return db.prepare(`SELECT u.id,u.name,u.email,u.class_code FROM users u JOIN classes c ON c.code=u.class_code WHERE u.id=? AND u.role='student' AND c.teacher_id=?`).get(studentId, teacherId);
}
function studentsForClass(code) { return db.prepare("SELECT id,name,email,class_code FROM users WHERE role='student' AND class_code=? ORDER BY name").all(code); }
function seed() {
  const existingTeacher = db.prepare("SELECT id FROM users WHERE role='teacher' ORDER BY id LIMIT 1").get();
  if (existingTeacher) return;
  const production = process.env.NODE_ENV === "production";
  const teacherPassword = production ? String(process.env.INITIAL_TEACHER_PASSWORD || "") : String(process.env.INITIAL_TEACHER_PASSWORD || "teacher123");
  if (teacherPassword.length < 12) {
    throw new Error("No teacher account exists. Set INITIAL_TEACHER_PASSWORD (minimum 12 characters) before starting a fresh production database.");
  }
  const teacherEmail = String(process.env.INITIAL_TEACHER_EMAIL || "teacher@coaching.com").trim().toLowerCase();
  const teacherName = String(process.env.INITIAL_TEACHER_NAME || "StudyTrack Teacher").trim();
  const classCode = String(process.env.INITIAL_CLASS_CODE || "DEMO01").trim().toUpperCase();
  const className = String(process.env.INITIAL_CLASS_NAME || "Demo Class").trim();
  const teacherId = db.prepare("INSERT INTO users(name,email,password_hash,role,class_code) VALUES(?,?,?,?,?)").run(teacherName,teacherEmail,bcrypt.hashSync(teacherPassword,10),"teacher",classCode).lastInsertRowid;
  const classId = db.prepare("INSERT INTO classes(teacher_id,name,code) VALUES(?,?,?)").run(teacherId,className,classCode).lastInsertRowid;
  const studentPassword = production ? String(process.env.INITIAL_STUDENT_PASSWORD || "") : String(process.env.INITIAL_STUDENT_PASSWORD || "student123");
  if (studentPassword.length >= 12) {
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

function auth(req,res,next){ const h=req.headers.authorization||""; const token=h.startsWith("Bearer ")?h.slice(7).trim():null; if(!token)return res.status(401).json({error:"Authentication required"}); try{req.user=jwt.verify(token,JWT_SECRET);next();}catch{res.status(401).json({error:"Invalid or expired token"});} }
function role(...roles){return (req,res,next)=>{if(!roles.includes(req.user.role))return res.status(403).json({error:"Forbidden"});next();}}

const authAttempts=new Map();
function loginRateLimit(req,res,next){const key=(req.ip||"unknown").replace(/^::ffff:/,"");const now=Date.now();const current=authAttempts.get(key)||{count:0,reset:now+10*60*1000};if(now>current.reset){current.count=0;current.reset=now+10*60*1000;}if(current.count>=20)return res.status(429).json({error:"Too many login attempts. Please try again later."});req._loginKey=key;req._loginAttempt=current;next();}
function recordFailedLogin(req){if(req._loginAttempt){req._loginAttempt.count++;authAttempts.set(req._loginKey,req._loginAttempt);}}
function clearLoginAttempts(req){if(req._loginKey)authAttempts.delete(req._loginKey);}
function signUser(u){return jwt.sign({id:u.id,name:u.name,email:u.email,role:u.role,class_code:u.class_code},JWT_SECRET,{expiresIn:"7d"});}

app.get("/api/health",(_,res)=>res.json({ok:true}));
app.post("/api/auth/login",loginRateLimit,(req,res)=>{const email=String(req.body?.email||"").trim().toLowerCase();const password=String(req.body?.password||"");const requestedRole=req.body?.role;const u=db.prepare("SELECT * FROM users WHERE email=?").get(email);if(!u||(requestedRole&&u.role!==requestedRole)||!bcrypt.compareSync(password,u.password_hash)){recordFailedLogin(req);return res.status(401).json({error:"Invalid credentials or role"});}clearLoginAttempts(req);res.json({token:signUser(u),user:{id:u.id,name:u.name,email:u.email,role:u.role,class_code:u.class_code}});});
app.post("/api/auth/register",loginRateLimit,(req,res)=>{const name=boundedText(req.body?.name,100,true),email=String(req.body?.email||"").trim().toLowerCase(),password=String(req.body?.password||""),code=String(req.body?.classCode||"").trim().toUpperCase();const cls=db.prepare("SELECT * FROM classes WHERE code=?").get(code);if(!cls)return res.status(400).json({error:"Invalid class code"});if(!name||!validEmail(email)||password.length<6||password.length>128)return res.status(400).json({error:"Name, valid email and a 6-128 character password are required"});try{const id=db.prepare("INSERT INTO users(name,email,password_hash,role,class_code) VALUES(?,?,?,?,?)").run(name,email,bcrypt.hashSync(password,10),"student",code).lastInsertRowid;clearLoginAttempts(req);const u=db.prepare("SELECT * FROM users WHERE id=?").get(id);res.status(201).json({token:signUser(u),user:{id:u.id,name:u.name,email:u.email,role:u.role,class_code:u.class_code}});}catch{recordFailedLogin(req);res.status(400).json({error:"Email may already be registered"});}});
app.get("/api/me",auth,(req,res)=>res.json({user:db.prepare("SELECT id,name,email,role,class_code FROM users WHERE id=?").get(req.user.id)}));

function homeworkForClass(classId){return db.prepare(`SELECT h.*,COUNT(DISTINCT hs.student_id) submitted_count,SUM(CASE WHEN hs.status='reviewed' THEN 1 ELSE 0 END) reviewed_count,SUM(CASE WHEN hs.submitted_at IS NOT NULL AND h.due_date IS NOT NULL AND date(hs.submitted_at)>date(h.due_date) THEN 1 ELSE 0 END) late_count FROM homework h LEFT JOIN homework_submissions hs ON hs.homework_id=h.id WHERE h.class_id=? GROUP BY h.id ORDER BY h.created_at DESC`).all(classId);}
function testResultsForClass(classId){return db.prepare(`SELECT t.id,t.title,t.subject,t.max_marks,t.test_date,t.created_at,COUNT(m.id) result_count,ROUND(AVG(CASE WHEN m.id IS NULL THEN NULL ELSE m.marks*100.0/t.max_marks END),1) average_percentage FROM tests t LEFT JOIN marks m ON m.test_id=t.id WHERE t.class_id=? GROUP BY t.id ORDER BY t.test_date DESC,t.created_at DESC`).all(classId);}

app.get("/api/teacher/overview",auth,role("teacher"),(req,res)=>{
  const cls=classForTeacher(req.user.id); if(!cls)return res.json({class:null,students:[],homework:[],tests:[],metrics:{}});
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

app.get("/api/teacher/student/:id/homework",auth,role("teacher"),(req,res)=>{const s=studentForTeacher(req.params.id,req.user.id);if(!s)return res.status(404).json({error:"Student not found"});const rows=db.prepare(`SELECT h.*,hs.note,hs.submitted_at,hs.status,hs.feedback,hs.reviewed_at FROM homework h JOIN classes c ON c.id=h.class_id LEFT JOIN homework_submissions hs ON hs.homework_id=h.id AND hs.student_id=? WHERE c.teacher_id=? ORDER BY h.created_at DESC`).all(s.id,req.user.id);res.json({student:s,homework:rows});});
app.get("/api/teacher/homework/:id/submissions",auth,role("teacher"),(req,res)=>{const h=db.prepare("SELECT h.*,c.teacher_id,c.code FROM homework h JOIN classes c ON c.id=h.class_id WHERE h.id=? AND c.teacher_id=?").get(req.params.id,req.user.id);if(!h)return res.status(404).json({error:"Homework not found"});const students=studentsForClass(h.code);const rows=db.prepare("SELECT * FROM homework_submissions WHERE homework_id=?").all(h.id);const map=new Map(rows.map(r=>[r.student_id,r]));res.json({homework:h,submissions:students.map(s=>({student:s,...(map.get(s.id)||{}),status:map.get(s.id)?.status||(h.due_date&&today()>h.due_date?"late":"pending")}))});});
app.post("/api/teacher/homework/:id/review",auth,role("teacher"),(req,res)=>{const h=db.prepare("SELECT h.* FROM homework h JOIN classes c ON c.id=h.class_id WHERE h.id=? AND c.teacher_id=?").get(req.params.id,req.user.id);if(!h)return res.status(404).json({error:"Homework not found"});const sub=db.prepare("SELECT hs.* FROM homework_submissions hs JOIN users u ON u.id=hs.student_id JOIN classes c ON c.code=u.class_code WHERE hs.homework_id=? AND hs.student_id=? AND c.teacher_id=? AND c.id=?").get(h.id,req.body.studentId,req.user.id,h.class_id);if(!sub)return res.status(404).json({error:"Submission not found"});const feedback=String(req.body.feedback||"").trim();if(feedback.length>5000)return res.status(400).json({error:"Feedback is too long"});db.prepare("UPDATE homework_submissions SET status='reviewed',feedback=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(feedback,sub.id);res.json({ok:true});});

app.post("/api/teacher/homework",auth,role("teacher"),(req,res)=>{const cls=classForTeacher(req.user.id);const title=String(req.body.title||"").trim(),description=String(req.body.description||""),dueDate=req.body.dueDate||null;if(!cls||!title||title.length>200||description.length>5000||!(dueDate==null||validDate(dueDate)))return res.status(400).json({error:"Valid title and due date are required"});const id=db.prepare("INSERT INTO homework(teacher_id,class_id,title,description,due_date) VALUES(?,?,?,?,?)").run(req.user.id,cls.id,title,description,dueDate).lastInsertRowid;res.status(201).json(db.prepare("SELECT * FROM homework WHERE id=?").get(id));});
app.get("/api/teacher/results",auth,role("teacher"),(req,res)=>{
  const cls=classForTeacher(req.user.id);
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
app.post("/api/teacher/tests",auth,role("teacher"),(req,res)=>{const cls=classForTeacher(req.user.id);const title=String(req.body.title||"").trim(),subject=String(req.body.subject||"").trim(),maxMarks=Number(req.body.maxMarks),solution=String(req.body.solution||""),testDate=req.body.testDate||null;if(!cls||!title||title.length>200||!subject||subject.length>100||!Number.isInteger(maxMarks)||maxMarks<=0||maxMarks>100000||!(testDate==null||validDate(testDate)))return res.status(400).json({error:"Valid title, subject, max marks and test date are required"});const id=db.prepare("INSERT INTO tests(teacher_id,class_id,title,subject,max_marks,solution,test_date) VALUES(?,?,?,?,?,?,?)").run(req.user.id,cls.id,title,subject,maxMarks,solution,testDate).lastInsertRowid;res.status(201).json(db.prepare("SELECT * FROM tests WHERE id=?").get(id));});
app.post("/api/teacher/marks",auth,role("teacher"),(req,res)=>{const {testId,studentId,marks,remark}=req.body;const test=db.prepare("SELECT t.* FROM tests t JOIN classes c ON c.id=t.class_id WHERE t.id=? AND c.teacher_id=?").get(testId,req.user.id);const student=studentForTeacher(studentId,req.user.id);if(!test||!student)return res.status(404).json({error:"Test or student not found"});if(!Number.isFinite(Number(marks))||Number(marks)<0||Number(marks)>test.max_marks)return res.status(400).json({error:"Marks are outside the valid range"});db.prepare("INSERT INTO marks(test_id,student_id,marks,remark) VALUES(?,?,?,?) ON CONFLICT(test_id,student_id) DO UPDATE SET marks=excluded.marks,remark=excluded.remark").run(testId,student.id,Number(marks),remark||"");res.json({ok:true,percentage:pct(Number(marks),test.max_marks)});});

app.get("/api/teacher/attendance",auth,role("teacher"),(req,res)=>{const cls=classForTeacher(req.user.id);if(!cls)return res.json({class:null,records:[]});const date=req.query.date||today();const students=studentsForClass(cls.code);const records=db.prepare("SELECT * FROM attendance WHERE class_id=? AND attendance_date=?").all(cls.id,date);const map=new Map(records.map(r=>[r.student_id,r]));res.json({class:cls,date,students:students.map(s=>({student:s,status:map.get(s.id)?.status||null}))});});
app.post("/api/teacher/attendance",auth,role("teacher"),(req,res)=>{const cls=classForTeacher(req.user.id);const date=req.body.date||today();if(!validDate(date))return res.status(400).json({error:"Invalid attendance date"});if(!cls||!Array.isArray(req.body.records))return res.status(400).json({error:"Date and attendance records are required"});const stmt=db.prepare("INSERT INTO attendance(student_id,class_id,attendance_date,status) VALUES(?,?,?,?) ON CONFLICT(student_id,attendance_date) DO UPDATE SET class_id=excluded.class_id,status=excluded.status");const tx=db.transaction(rows=>rows.forEach(r=>{if(studentForTeacher(r.studentId,req.user.id)&&["present","absent"].includes(r.status))stmt.run(r.studentId,cls.id,date,r.status);}));tx(req.body.records);res.json({ok:true});});
app.get("/api/student/attendance",auth,role("student"),(req,res)=>{
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

app.get("/api/teacher/syllabus",auth,role("teacher"),(req,res)=>{const cls=classForTeacher(req.user.id);res.json({class:cls,chapters:cls?db.prepare("SELECT * FROM syllabus_chapters WHERE class_id=? ORDER BY subject,id").all(cls.id):[]});});
app.post("/api/teacher/syllabus",auth,role("teacher"),(req,res)=>{const cls=classForTeacher(req.user.id);const subject=String(req.body.subject||"").trim(),chapter=String(req.body.chapter||"").trim(),status=req.body.status;if(!cls||!subject||!chapter||!["not-started","in-progress","completed"].includes(status))return res.status(400).json({error:"Subject, chapter and valid status are required"});const id=db.prepare("INSERT INTO syllabus_chapters(class_id,subject,chapter,status) VALUES(?,?,?,?) ON CONFLICT(class_id,subject,chapter) DO UPDATE SET status=excluded.status,updated_at=CURRENT_TIMESTAMP").run(cls.id,subject,chapter,status).lastInsertRowid;res.json({ok:true,id});});
app.get("/api/student/syllabus",auth,role("student"),(req,res)=>{const s=db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);const rows=db.prepare("SELECT * FROM syllabus_chapters sc JOIN classes c ON c.id=sc.class_id WHERE c.code=? ORDER BY subject,id").all(s.class_code);const subjects=[...new Set(rows.map(r=>r.subject))].map(subject=>{const x=rows.filter(r=>r.subject===subject);return {subject,total:x.length,completed:x.filter(r=>r.status==='completed').length,inProgress:x.filter(r=>r.status==='in-progress').length,percentage:x.length?Math.round(x.filter(r=>r.status==='completed').length*100/x.length):0,chapters:x}});res.json({subjects});});

app.get("/api/student/dashboard",auth,role("student"),(req,res)=>{const student=db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);const homework=db.prepare(`SELECT h.*,hs.note submission_note,hs.submitted_at,CASE WHEN hs.status IS NOT NULL THEN hs.status WHEN h.due_date IS NOT NULL AND h.due_date<? THEN 'late' ELSE 'pending' END status,hs.feedback,hs.reviewed_at FROM homework h LEFT JOIN homework_submissions hs ON hs.homework_id=h.id AND hs.student_id=? JOIN classes c ON c.id=h.class_id WHERE c.code=? ORDER BY h.created_at DESC`).all(student.id,today(),student.class_code);const tests=db.prepare(`SELECT t.*,m.marks,m.remark,ROUND(m.marks*100.0/t.max_marks,1) percentage FROM tests t LEFT JOIN marks m ON m.test_id=t.id AND m.student_id=? JOIN classes c ON c.id=t.class_id WHERE c.code=? ORDER BY t.test_date DESC,t.created_at DESC`).all(student.id,student.class_code);const logs=db.prepare("SELECT * FROM study_logs WHERE student_id=? ORDER BY study_date DESC,id DESC").all(student.id);const week=db.prepare("SELECT COALESCE(SUM(minutes),0)m FROM study_logs WHERE student_id=? AND study_date>=?").get(student.id,startOfWeek()).m;const prev=db.prepare("SELECT COALESCE(SUM(minutes),0)m FROM study_logs WHERE student_id=? AND study_date>=? AND study_date<?").get(student.id,previousWeekStart(),startOfWeek()).m;const avg=tests.filter(t=>t.marks!=null).reduce((a,t)=>a+t.percentage,0)/(tests.filter(t=>t.marks!=null).length||1);const attendance=db.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) present FROM attendance a JOIN classes c ON c.id=a.class_id WHERE a.student_id=? AND c.code=?").get(student.id,student.class_code);const syllabus=db.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed FROM syllabus_chapters sc JOIN classes c ON c.id=sc.class_id WHERE c.code=?").get(student.class_code);res.json({student,homework,tests,logs,stats:{tests_taken:tests.filter(t=>t.marks!=null).length,average_percentage:Number(avg.toFixed(1)),total_study_minutes:logs.reduce((a,x)=>a+x.minutes,0),week_minutes:week,previous_week_minutes:prev,study_trend:trend(week,prev),attendance_percentage:attendance.total?Number((attendance.present*100/attendance.total).toFixed(1)):0,syllabus_percentage:syllabus.total?Math.round(syllabus.completed*100/syllabus.total):0},daily:db.prepare("SELECT study_date,SUM(minutes) minutes FROM study_logs WHERE student_id=? AND study_date>=? GROUP BY study_date ORDER BY study_date").all(student.id,dateDaysAgo(13)),subjects:db.prepare("SELECT subject,SUM(minutes) minutes FROM study_logs WHERE student_id=? GROUP BY subject ORDER BY minutes DESC").all(student.id),categories:db.prepare("SELECT category,SUM(minutes) minutes FROM study_logs WHERE student_id=? GROUP BY category").all(student.id)});});
app.post("/api/student/homework/:id/submit",auth,role("student"),(req,res)=>{const h=db.prepare("SELECT h.* FROM homework h JOIN classes c ON c.id=h.class_id JOIN users u ON u.class_code=c.code WHERE h.id=? AND u.id=?").get(req.params.id,req.user.id);if(!h)return res.status(404).json({error:"Homework not found"});const status=h.due_date&&today()>h.due_date?"late":"submitted";const note=String(req.body.note||"").trim();if(note.length>5000)return res.status(400).json({error:"Submission note is too long"});db.prepare("INSERT INTO homework_submissions(homework_id,student_id,note,status) VALUES(?,?,?,?) ON CONFLICT(homework_id,student_id) DO UPDATE SET note=excluded.note,submitted_at=CURRENT_TIMESTAMP,status=excluded.status").run(h.id,req.user.id,note,status);res.json({ok:true,status});});
app.post("/api/student/study-log",auth,role("student"),(req,res)=>{const {category,subject,minutes,studyDate,note}=req.body;const cleanSubject=String(subject||"").trim(),cleanNote=String(note||"").trim();if(!["tuition","self-study","outside"].includes(category)||!cleanSubject||cleanSubject.length>100||cleanNote.length>2000||!Number.isFinite(Number(minutes))||Number(minutes)<1||Number(minutes)>1440||!validDate(studyDate))return res.status(400).json({error:"Category, subject, minutes (1-1440) and valid date are required"});const id=db.prepare("INSERT INTO study_logs(student_id,category,subject,minutes,study_date,note) VALUES(?,?,?,?,?,?)").run(req.user.id,category,cleanSubject,Math.round(Number(minutes)),studyDate,cleanNote).lastInsertRowid;res.status(201).json(db.prepare("SELECT * FROM study_logs WHERE id=?").get(id));});

function buildActivityForClass(code,limit=20){
  const rows=[];
  rows.push(...db.prepare(`SELECT 'study' type,u.id student_id,u.name student,s.subject title,s.minutes detail,s.created_at created_at FROM study_logs s JOIN users u ON u.id=s.student_id WHERE u.class_code=? ORDER BY s.created_at DESC LIMIT ?`).all(code,limit));
  rows.push(...db.prepare(`SELECT 'homework' type,u.id student_id,u.name student,h.title title,hs.status detail,COALESCE(hs.submitted_at,hs.reviewed_at) created_at FROM homework_submissions hs JOIN users u ON u.id=hs.student_id JOIN homework h ON h.id=hs.homework_id JOIN classes c ON c.id=h.class_id WHERE c.code=? ORDER BY COALESCE(hs.reviewed_at,hs.submitted_at) DESC LIMIT ?`).all(code,limit));
  rows.push(...db.prepare(`SELECT 'test' type,u.id student_id,u.name student,t.title title,ROUND(m.marks*100.0/t.max_marks,1) detail,m.created_at created_at FROM marks m JOIN users u ON u.id=m.student_id JOIN tests t ON t.id=m.test_id JOIN classes c ON c.id=t.class_id WHERE c.code=? ORDER BY COALESCE(t.test_date,t.created_at) DESC LIMIT ?`).all(code,limit));
  rows.push(...db.prepare(`SELECT 'attendance' type,u.id student_id,u.name student,'Attendance' title,a.status detail,a.created_at created_at FROM attendance a JOIN users u ON u.id=a.student_id JOIN classes c ON c.id=a.class_id WHERE c.code=? ORDER BY a.created_at DESC LIMIT ?`).all(code,limit));
  rows.push(...db.prepare(`SELECT 'syllabus' type,NULL student_id,'Class' student,subject title,status detail,updated_at created_at FROM syllabus_chapters sc JOIN classes c ON c.id=sc.class_id WHERE c.code=? ORDER BY updated_at DESC LIMIT ?`).all(code,limit));
  return rows.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,limit);
}

app.get("/api/teacher/activity",auth,role("teacher"),(req,res)=>{const cls=classForTeacher(req.user.id);res.json({activity:cls?buildActivityForClass(cls.code,50):[]});});
app.get("/api/student/activity",auth,role("student"),(req,res)=>{const s=db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);res.json({activity:buildActivityForClass(s.class_code,50).filter(x=>x.student_id===s.id)});});

const clientDist = path.resolve(__dirname, "../client/dist");
app.use(express.static(clientDist));
app.get(/^(?!\/api\/).*/, (req,res,next) => { res.sendFile(path.join(clientDist, "index.html"), err => { if (err) next(); }); });

app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);res.status(500).json({error:"Internal server error"});});
const shutdown=()=>{try{db.close();}finally{process.exit(0);}};
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
app.listen(PORT,()=>console.log(`StudyTrack API running on port ${PORT}`));
