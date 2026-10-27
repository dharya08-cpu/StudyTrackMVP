import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { applyMigrations } from "../src/migrate.js";
import { importSqlite } from "../src/import-sqlite.js";
import { createTestApp, createTestDb, Browser } from "./helpers.mjs";

const require = createRequire(import.meta.url);
async function makeSqlite(sql) {
  const file = path.join(os.tmpdir(), `v3-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  let raw; try { const { DatabaseSync } = await import("node:sqlite"); raw = new DatabaseSync(file); } catch { raw = new (require("better-sqlite3"))(file); }
  raw.exec(sql); raw.close(); return file;
}
const V3 = `
CREATE TABLE institutes(id INTEGER PRIMARY KEY,name TEXT,code TEXT,head_id INTEGER,owner_email TEXT,status TEXT,control_mode TEXT,read_only INTEGER,max_students INTEGER,created_at TEXT);
CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,email TEXT,password_hash TEXT,role TEXT,class_code TEXT,institute_id INTEGER,institute_role TEXT,banned INTEGER,created_at TEXT);
CREATE TABLE classes(id INTEGER PRIMARY KEY,teacher_id INTEGER,name TEXT,code TEXT,suspended INTEGER,created_at TEXT);
CREATE TABLE homework(id INTEGER PRIMARY KEY,teacher_id INTEGER,class_id INTEGER,title TEXT,description TEXT,due_date TEXT,file_url TEXT,file_name TEXT,file_size INTEGER,created_at TEXT);
CREATE TABLE homework_submissions(id INTEGER PRIMARY KEY,homework_id INTEGER,student_id INTEGER,note TEXT,submitted_at TEXT);
CREATE TABLE tests(id INTEGER PRIMARY KEY,teacher_id INTEGER,class_id INTEGER,title TEXT,subject TEXT,max_marks INTEGER,solution TEXT,test_date TEXT,created_at TEXT);
CREATE TABLE marks(id INTEGER PRIMARY KEY,test_id INTEGER,student_id INTEGER,marks REAL,remark TEXT,created_at TEXT);
CREATE TABLE study_logs(id INTEGER PRIMARY KEY,student_id INTEGER,category TEXT,subject TEXT,minutes INTEGER,study_date TEXT,note TEXT,created_at TEXT);
CREATE TABLE attendance(id INTEGER PRIMARY KEY,student_id INTEGER,attendance_date TEXT,status TEXT,created_at TEXT);
CREATE TABLE syllabus_chapters(id INTEGER PRIMARY KEY,class_id INTEGER,subject TEXT,chapter TEXT,status TEXT,updated_at TEXT);
CREATE TABLE join_requests(id INTEGER PRIMARY KEY,student_id INTEGER,class_id INTEGER,status TEXT,created_at TEXT);
INSERT INTO institutes VALUES(1,'Bright Academy','BRIGHT1',2,'Head@Gmail.com','active','managed',0,50,'2026-09-01 10:00:00');
INSERT INTO users VALUES(2,'Head Teacher','Head@Gmail.com','$2a$hash','teacher',NULL,1,'head',0,'2026-09-01 10:00:00');
INSERT INTO users VALUES(3,'Ana','ana@gmail.com','$2a$hash','student','PHY11',NULL,NULL,0,'2026-09-02 09:00:00');
INSERT INTO users VALUES(4,'Bo','bo@gmail.com','$2a$hash','student','GONE99',NULL,NULL,1,'2026-09-02 09:00:00');
INSERT INTO users VALUES(5,'Dup','ANA@gmail.com','$2a$hash','student',NULL,NULL,NULL,0,'2026-09-02 09:00:00');
INSERT INTO users VALUES(6,'Old','old@school.edu','$2a$hash','student','PHY11',NULL,NULL,0,'2026-09-02 09:00:00');
INSERT INTO classes VALUES(1,2,'Physics 11','phy11',0,'2026-09-01 11:00:00');
INSERT INTO homework VALUES(1,2,1,'HW1','Read','2026-10-12','2/old-file.pdf','old.pdf',1234,'2026-09-05 10:00:00');
INSERT INTO homework_submissions VALUES(1,1,3,'done','2026-09-06 10:00:00');
INSERT INTO tests VALUES(1,2,1,'T1','Physics',50,'sol','2026-09-20','2026-09-10 10:00:00');
INSERT INTO marks VALUES(1,1,3,41.5,'good','2026-09-21 10:00:00');
INSERT INTO study_logs VALUES(1,3,'weird','Physics',60,'2026-09-30','n','2026-09-30 20:00:00');
INSERT INTO attendance VALUES(1,3,'2026-09-30','present','2026-09-30 10:00:00');
INSERT INTO attendance VALUES(2,4,'2026-09-30','present','2026-09-30 10:00:00');
INSERT INTO syllabus_chapters VALUES(1,1,'Physics','Kinematics','completed','2026-09-25 10:00:00');
INSERT INTO join_requests VALUES(1,4,1,'pending','2026-09-30 10:00:00');`;

test("V3 SQLite data is imported: class_code becomes memberships, passwords are dropped, bad rows reported", async () => {
  const file = await makeSqlite(V3); const db = await createTestDb(); await applyMigrations(db);
  const report = await importSqlite({ sqlitePath: file, target: db });
  assert.equal((await db.one("SELECT COUNT(*) AS n FROM users")).n, 4, "duplicate e-mail skipped");
  assert.ok(report.skipped.some(x => /duplicate/.test(x)));
  assert.ok(report.skipped.some(x => /GONE99/.test(x)), "dangling class code reported");
  assert.ok(report.notes.some(x => /old@school.edu/.test(x) && /not a Gmail/.test(x)));
  const memberships = await db.many("SELECT student_id,class_id,status FROM student_class_memberships ORDER BY student_id");
  assert.deepEqual(memberships, [{ student_id: 3, class_id: 1, status: "active" }, { student_id: 6, class_id: 1, status: "active" }]);
  assert.equal((await db.one("SELECT email FROM users WHERE id=2")).email, "head@gmail.com", "e-mails are lower-cased");
  assert.equal((await db.one("SELECT google_sub FROM users WHERE id=2")).google_sub, null);
  assert.equal(JSON.stringify(await db.many("SELECT * FROM users")).includes("$2a$hash"), false, "old password hashes are not copied");
  assert.equal((await db.one("SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL")).n, 0);
  assert.equal((await db.one("SELECT head_id FROM institutes WHERE id=1")).head_id, 2); assert.equal((await db.one("SELECT code FROM classes")).code, "PHY11");
  assert.equal((await db.one("SELECT file_path FROM homework")).file_path, "2/old-file.pdf"); assert.equal((await db.one("SELECT created_at FROM users WHERE id=3")).created_at, "2026-09-02T09:00:00Z");
  assert.equal((await db.one("SELECT category FROM study_logs")).category, "self-study", "invalid enum falls back safely");
  assert.equal((await db.one("SELECT class_id FROM attendance WHERE student_id=3")).class_id, 1, "attendance gets the student's class");
  assert.equal((await db.one("SELECT COUNT(*) AS n FROM attendance")).n, 1);
  assert.equal(Boolean((await db.one("SELECT banned FROM users WHERE id=4")).banned), true);
  assert.equal((await db.one("SELECT COUNT(*) AS n FROM join_requests")).n, 1);
  await assert.rejects(importSqlite({ sqlitePath: file, target: db }), /already has users/);
  await importSqlite({ sqlitePath: file, target: db, wipe: true }); assert.equal((await db.one("SELECT COUNT(*) AS n FROM users")).n, 4);
});

test("the imported account links to Google on first sign-in and keeps its classes", async () => {
  const file = await makeSqlite(V3); const app = await createTestApp();
  await importSqlite({ sqlitePath: file, target: app.db });
  const ana = new Browser(app); const r = await ana.signIn({ sub: "google-ana", email: "ana@gmail.com", name: "Ana G", role: "student" });
  assert.equal(r.status, 200); assert.equal(r.body.isNew, false); assert.equal(r.body.user.id, 3);
  assert.equal((await ana.get("/api/student/classes")).body.classes[0].name, "Physics 11");
  assert.equal((await ana.get("/api/student/dashboard")).body.tests[0].marks, 41.5);
  assert.equal((await app.db.one("SELECT google_sub FROM users WHERE id=3")).google_sub, "google-ana");
  const wrongRole = await new Browser(app).signIn({ sub: "g-head", email: "head@gmail.com", role: "student" }); assert.equal(wrongRole.body.code, "ROLE_MISMATCH");
  const head = new Browser(app); assert.equal((await head.signIn({ sub: "g-head", email: "head@gmail.com", role: "teacher" })).status, 200);
  assert.equal((await head.get("/api/me")).body.institute.my_role, "head");
  const newStudent = new Browser(app); const nr = await newStudent.signIn({ sub: "g-new", email: "fresh@gmail.com", role: "student" }); assert.ok(nr.body.user.id > 6, "id counter continues after imported rows");
});

test("the repository's committed (older) studytrack.db also imports", async () => {
  const file = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../v3/StudyTrackMVP-main/server/studytrack.db");
  if (!fs.existsSync(file)) return;
  const db = await createTestDb(); await applyMigrations(db);
  const report = await importSqlite({ sqlitePath: file, target: db });
  assert.ok(Object.keys(report.copied).includes("users")); assert.equal((await db.one("SELECT COUNT(*) AS n FROM users WHERE google_sub IS NOT NULL")).n, 0);
});
