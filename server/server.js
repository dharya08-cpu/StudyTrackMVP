import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "studytrack-dev-secret";

app.use(cors({ origin: process.env.CLIENT_ORIGIN || true }));
app.use(express.json());

const db = new Database("studytrack.db");
db.pragma("foreign_keys = ON");

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
`);

function seed() {
  const teacher = db.prepare("SELECT id FROM users WHERE email=?").get("teacher@coaching.com");
  if (teacher) return;

  const teacherHash = bcrypt.hashSync("teacher123", 10);
  const studentHash = bcrypt.hashSync("student123", 10);

  const teacherId = db.prepare(`
    INSERT INTO users(name,email,password_hash,role,class_code)
    VALUES(?,?,?,?,?)
  `).run("Demo Teacher", "teacher@coaching.com", teacherHash, "teacher", "DEMO01").lastInsertRowid;

  db.prepare(`
    INSERT INTO classes(teacher_id,name,code) VALUES(?,?,?)
  `).run(teacherId, "Demo Class", "DEMO01");

  db.prepare(`
    INSERT INTO users(name,email,password_hash,role,class_code)
    VALUES(?,?,?,?,?)
  `).run("Demo Student", "student@coaching.com", studentHash, "student", "DEMO01");

  const classId = db.prepare("SELECT id FROM classes WHERE code=?").get("DEMO01").id;

  const homeworkId = db.prepare(`
    INSERT INTO homework(teacher_id,class_id,title,description,due_date)
    VALUES(?,?,?,?,?)
  `).run(
    teacherId, classId,
    "Physics: Motion Practice",
    "Complete questions 1–20 from the worksheet.",
    "2026-08-25"
  ).lastInsertRowid;

  const testId = db.prepare(`
    INSERT INTO tests(teacher_id,class_id,title,subject,max_marks,solution,test_date)
    VALUES(?,?,?,?,?,?,?)
  `).run(
    teacherId, classId,
    "Weekly Physics Test", "Physics", 50,
    "Review equations of motion and graph interpretation.",
    "2026-08-20"
  ).lastInsertRowid;

  const studentId = db.prepare("SELECT id FROM users WHERE email=?").get("student@coaching.com").id;

  db.prepare(`
    INSERT INTO marks(test_id,student_id,marks,remark) VALUES(?,?,?,?)
  `).run(testId, studentId, 38, "Good attempt. Improve numerical accuracy.");

  db.prepare(`
    INSERT INTO study_logs(student_id,category,subject,minutes,study_date,note)
    VALUES(?,?,?,?,?,?)
  `).run(studentId, "self-study", "Physics", 90, "2026-08-18", "Kinematics revision");

  db.prepare(`
    INSERT INTO homework_submissions(homework_id,student_id,note)
    VALUES(?,?,?)
  `).run(homeworkId, studentId, "Completed questions 1–20.");
}
seed();

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentication required" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

function role(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

function signUser(user) {
  return jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role, class_code: user.class_code },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

app.get("/api/health", (_, res) => res.json({ ok: true }));

app.post("/api/auth/login", (req, res) => {
  const { email, password, role: requestedRole } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email?.trim().toLowerCase());
  if (!user || (requestedRole && user.role !== requestedRole)) {
    return res.status(401).json({ error: "Invalid credentials or role" });
  }
  if (!bcrypt.compareSync(password || "", user.password_hash)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  res.json({
    token: signUser(user),
    user: { id: user.id, name: user.name, email: user.email, role: user.role, class_code: user.class_code }
  });
});

app.post("/api/auth/register", (req, res) => {
  const { name, email, password, classCode } = req.body;
  const code = (classCode || "").trim().toUpperCase();
  const cls = db.prepare("SELECT * FROM classes WHERE code=?").get(code);
  if (!cls) return res.status(400).json({ error: "Invalid class code" });
  if (!name || !email || !password || password.length < 6) {
    return res.status(400).json({ error: "Name, email and a 6+ character password are required" });
  }

  try {
    const hash = bcrypt.hashSync(password, 10);
    const id = db.prepare(`
      INSERT INTO users(name,email,password_hash,role,class_code)
      VALUES(?,?,?,?,?)
    `).run(name.trim(), email.trim().toLowerCase(), hash, "student", code).lastInsertRowid;

    const user = db.prepare("SELECT * FROM users WHERE id=?").get(id);
    res.status(201).json({
      token: signUser(user),
      user: { id:user.id, name:user.name, email:user.email, role:user.role, class_code:user.class_code }
    });
  } catch (e) {
    res.status(400).json({ error: "Email may already be registered" });
  }
});

app.get("/api/me", auth, (req, res) => {
  const user = db.prepare("SELECT id,name,email,role,class_code FROM users WHERE id=?").get(req.user.id);
  res.json({ user });
});

app.get("/api/teacher/overview", auth, role("teacher"), (req, res) => {
  const cls = db.prepare("SELECT * FROM classes WHERE teacher_id=?").get(req.user.id);
  if (!cls) return res.json({ class: null, students: [], homework: [], tests: [] });

  const students = db.prepare(`
    SELECT id,name,email FROM users WHERE role='student' AND class_code=?
    ORDER BY name
  `).all(cls.code);

  const homework = db.prepare(`
    SELECT * FROM homework WHERE class_id=? ORDER BY created_at DESC
  `).all(cls.id);

  const tests = db.prepare(`
    SELECT * FROM tests WHERE class_id=? ORDER BY test_date DESC, created_at DESC
  `).all(cls.id);

  res.json({ class: cls, students, homework, tests });
});

app.post("/api/teacher/homework", auth, role("teacher"), (req, res) => {
  const { title, description, dueDate } = req.body;
  const cls = db.prepare("SELECT * FROM classes WHERE teacher_id=?").get(req.user.id);
  if (!cls || !title) return res.status(400).json({ error: "Title and class are required" });

  const id = db.prepare(`
    INSERT INTO homework(teacher_id,class_id,title,description,due_date)
    VALUES(?,?,?,?,?)
  `).run(req.user.id, cls.id, title.trim(), description || "", dueDate || null).lastInsertRowid;

  res.status(201).json(db.prepare("SELECT * FROM homework WHERE id=?").get(id));
});

app.post("/api/teacher/tests", auth, role("teacher"), (req, res) => {
  const { title, subject, maxMarks, solution, testDate } = req.body;
  const cls = db.prepare("SELECT * FROM classes WHERE teacher_id=?").get(req.user.id);
  if (!cls || !title || !subject || !Number(maxMarks)) {
    return res.status(400).json({ error: "Title, subject and max marks are required" });
  }

  const id = db.prepare(`
    INSERT INTO tests(teacher_id,class_id,title,subject,max_marks,solution,test_date)
    VALUES(?,?,?,?,?,?,?)
  `).run(req.user.id, cls.id, title.trim(), subject.trim(), Number(maxMarks), solution || "", testDate || null).lastInsertRowid;

  res.status(201).json(db.prepare("SELECT * FROM tests WHERE id=?").get(id));
});

app.post("/api/teacher/marks", auth, role("teacher"), (req, res) => {
  const { testId, studentId, marks, remark } = req.body;
  const test = db.prepare(`
    SELECT t.* FROM tests t
    JOIN classes c ON c.id=t.class_id
    WHERE t.id=? AND c.teacher_id=?
  `).get(testId, req.user.id);

  const student = db.prepare(`
    SELECT * FROM users WHERE id=? AND role='student'
  `).get(studentId);

  if (!test || !student) return res.status(404).json({ error: "Test or student not found" });
  if (Number(marks) < 0 || Number(marks) > test.max_marks) {
    return res.status(400).json({ error: "Marks are outside the valid range" });
  }

  db.prepare(`
    INSERT INTO marks(test_id,student_id,marks,remark)
    VALUES(?,?,?,?)
    ON CONFLICT(test_id,student_id)
    DO UPDATE SET marks=excluded.marks, remark=excluded.remark
  `).run(testId, studentId, Number(marks), remark || "");

  res.json({ ok: true });
});

app.get("/api/student/dashboard", auth, role("student"), (req, res) => {
  const student = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  const homework = db.prepare(`
    SELECT h.*, hs.note AS submission_note, hs.submitted_at
    FROM homework h
    LEFT JOIN homework_submissions hs
      ON hs.homework_id=h.id AND hs.student_id=?
    JOIN classes c ON c.id=h.class_id
    WHERE c.code=?
    ORDER BY h.created_at DESC
  `).all(req.user.id, student.class_code);

  const tests = db.prepare(`
    SELECT t.*, m.marks, m.remark
    FROM tests t
    LEFT JOIN marks m ON m.test_id=t.id AND m.student_id=?
    JOIN classes c ON c.id=t.class_id
    WHERE c.code=?
    ORDER BY t.test_date DESC, t.created_at DESC
  `).all(req.user.id, student.class_code);

  const logs = db.prepare(`
    SELECT * FROM study_logs WHERE student_id=? ORDER BY study_date DESC, id DESC
  `).all(req.user.id);

  const stats = db.prepare(`
    SELECT
      COUNT(m.id) AS tests_taken,
      COALESCE(AVG(m.marks * 100.0 / t.max_marks),0) AS average_percentage,
      COALESCE(SUM(s.minutes),0) AS total_study_minutes
    FROM users u
    LEFT JOIN marks m ON m.student_id=u.id
    LEFT JOIN tests t ON t.id=m.test_id
    LEFT JOIN study_logs s ON s.student_id=u.id
    WHERE u.id=?
  `).get(req.user.id);

  res.json({ homework, tests, logs, stats });
});

app.post("/api/student/homework/:id/submit", auth, role("student"), (req, res) => {
  const homework = db.prepare(`
    SELECT h.* FROM homework h
    JOIN classes c ON c.id=h.class_id
    JOIN users u ON u.class_code=c.code
    WHERE h.id=? AND u.id=?
  `).get(req.params.id, req.user.id);

  if (!homework) return res.status(404).json({ error: "Homework not found" });

  db.prepare(`
    INSERT INTO homework_submissions(homework_id,student_id,note)
    VALUES(?,?,?)
    ON CONFLICT(homework_id,student_id)
    DO UPDATE SET note=excluded.note, submitted_at=CURRENT_TIMESTAMP
  `).run(homework.id, req.user.id, req.body.note || "");

  res.json({ ok: true });
});

app.post("/api/student/study-log", auth, role("student"), (req, res) => {
  const { category, subject, minutes, studyDate, note } = req.body;
  if (!["tuition","self-study","outside"].includes(category) || !subject || !Number(minutes) || !studyDate) {
    return res.status(400).json({ error: "Category, subject, minutes and date are required" });
  }

  const id = db.prepare(`
    INSERT INTO study_logs(student_id,category,subject,minutes,study_date,note)
    VALUES(?,?,?,?,?,?)
  `).run(req.user.id, category, subject.trim(), Number(minutes), studyDate, note || "").lastInsertRowid;

  res.status(201).json(db.prepare("SELECT * FROM study_logs WHERE id=?").get(id));
});

app.get("/api/teacher/student/:id/analytics", auth, role("teacher"), (req, res) => {
  const student = db.prepare(`
    SELECT u.id,u.name,u.email FROM users u
    JOIN classes c ON c.code=u.class_code
    WHERE u.id=? AND u.role='student' AND c.teacher_id=?
  `).get(req.params.id, req.user.id);

  if (!student) return res.status(404).json({ error: "Student not found" });

  const scores = db.prepare(`
    SELECT t.title,t.subject,t.max_marks,m.marks,m.remark,t.test_date
    FROM marks m JOIN tests t ON t.id=m.test_id
    WHERE m.student_id=? ORDER BY t.test_date ASC
  `).all(student.id);

  const study = db.prepare(`
    SELECT category, SUM(minutes) AS minutes
    FROM study_logs WHERE student_id=? GROUP BY category
  `).all(student.id);

  const avg = scores.length
    ? scores.reduce((a,x)=>a + (x.marks*100/x.max_marks),0)/scores.length
    : 0;

  const first = scores[0] ? scores[0].marks*100/scores[0].max_marks : 0;
  const last = scores.length ? scores[scores.length-1].marks*100/scores[scores.length-1].max_marks : 0;

  res.json({
    student,
    scores,
    study,
    averagePercentage: Number(avg.toFixed(1)),
    improvementPercentage: Number((last-first).toFixed(1))
  });
});

app.listen(PORT, () => {
  console.log(`StudyTrack API running on http://localhost:${PORT}`);
});
