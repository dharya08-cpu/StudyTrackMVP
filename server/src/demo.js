// Demo data for showing StudyTrack to real teachers. Re-running it resets everything to the same starting point.
// Demo accounts are isolated: demo and real users can never join each other's classes or institute.
import { HttpError } from "./validate.js";
import { hashPassword } from "./passwords.js";
import { inspectUpload } from "./files.js";
import { putFile, removeFiles } from "./uploads.js";
import { addAttachment, addSubmissionFile } from "./attachments.js";
import { sendRemindersFor } from "./reminders.js";
import { sha256 } from "./security.js";
import { crc32 } from "./xlsx.js";
import crypto from "node:crypto";
import zlib from "node:zlib";

export const DEMO_INSTITUTE_CODE = "DEMOACAD";
export const DEMO_ACCOUNTS = [
  { email: "demoteacher1@coaching.com", password: "demoteacher1", role: "teacher", first: "Anita", last: "Sharma", subjects: "Physics, Chemistry", phone: "+91 98100 00001", note: "Head of the demo institute (Physics + Chemistry). Try: Menu > Homework (files), Results, Attendance, then Download class report (Excel)" },
  { email: "demoteacher2@coaching.com", password: "demoteacher2", role: "teacher", first: "Rahul", last: "Verma", subjects: "Mathematics, Biology", phone: "+91 98100 00002", note: "Teacher in the demo institute (Maths + Biology). Try: Menu > Tests (question paper + solutions), Students, Download class report" },
  { email: "demoteacher3@coaching.com", password: "demoteacher3", role: "teacher", first: "Meera", last: "Iyer", subjects: "English, Computer Science", phone: "+91 98100 00003", note: "Independent teacher, no institute. Try: student uploads in Homework, announcements, calendar" },
  { email: "demostudent1@coaching.com", password: "demostudent1", role: "student", first: "Aarav", last: "Mehta", parent: "Rajesh Mehta", note: "Strong and improving, meets his study goal. Try: Menu > Calendar > Edit my calendar, Homework files, Parent view, Notifications (reminders, sign-in alert)" },
  { email: "demostudent2@coaching.com", password: "demostudent2", role: "student", first: "Diya", last: "Nair", parent: "Suresh Nair", note: "Irregular study, marks falling: shows the 'needs attention' signals. Try: overdue reminders, overdue goals in Edit my calendar, Parent view" },
];
const CLASSES = [
  { code: "DEMO01", name: "Physics Class 11", subject: "Physics", teacher: 0, chapters: ["Units and Measurement", "Kinematics", "Laws of Motion", "Work, Energy and Power", "Rotational Motion"] },
  { code: "DEMO02", name: "Chemistry Class 11", subject: "Chemistry", teacher: 0, chapters: ["Basic Concepts", "Atomic Structure", "Chemical Bonding", "Thermodynamics", "Equilibrium"] },
  { code: "DEMO03", name: "Mathematics Class 11", subject: "Mathematics", teacher: 1, chapters: ["Sets and Functions", "Trigonometry", "Complex Numbers", "Permutations", "Sequences and Series"] },
  { code: "DEMO04", name: "Biology Class 11", subject: "Biology", teacher: 1, chapters: ["The Living World", "Cell Structure", "Plant Physiology", "Human Physiology", "Biomolecules"] },
  { code: "DEMO05", name: "English Communication", subject: "English", teacher: 2, chapters: ["Grammar Basics", "Reading Skills", "Letter Writing", "Speaking Practice", "Essay Writing"] },
  { code: "DEMO06", name: "Computer Science Basics", subject: "Computer Science", teacher: 2, chapters: ["Computer Fundamentals", "Python Basics", "Loops and Conditions", "Functions", "Data Structures"] },
];
// The parent-view links of the two demo students. They are fixed (and public, like the demo passwords) so you can open
// them straight from the admin Demo page. Open /parent#<token> in a browser; no sign-in is needed.
const demoToken = n => crypto.createHash("sha256").update(`studytrack-demo-parent-link-${n}`).digest("base64url");
export const DEMO_PARENT_LINKS = [{ student: "Aarav Mehta", token: demoToken(1) }, { student: "Diya Nair", token: demoToken(2) }];
const HW_TITLES = ["Chapter practice sheet", "Concept revision questions", "Numerical problems set", "Previous year questions", "Short notes and diagrams"];

// Small deterministic random generator so the demo always looks the same.
const rng = seed => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// A small valid PNG (a coloured diagram-like picture) for demo photos and diagrams.
function simplePng(width, height, [r, g, b]) {
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = []; for (let y = 0; y < height; y++) { const row = Buffer.alloc(1 + width * 3); for (let x = 0; x < width; x++) { const edge = x < 3 || y < 3 || x >= width - 3 || y >= height - 3 || (x + y) % 40 === 0; row[1 + x * 3] = edge ? 30 : r; row[2 + x * 3] = edge ? 30 : g; row[3 + x * 3] = edge ? 60 : b; } rows.push(row); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

function simplePdf(title, lines) {
  const esc = s => String(s).replace(/[\\()]/g, "\\$&").replace(/[^\x20-\x7E]/g, "?");
  const content = ["BT", "/F1 20 Tf", "72 740 Td", `(${esc(title)}) Tj`, "/F1 12 Tf", ...lines.flatMap(l => ["0 -26 Td", `(${esc(l)}) Tj`]), "ET"].join("\n");
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let out = "%PDF-1.4\n"; const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function bulk(t, table, cols, rows) {
  for (let i = 0; i < rows.length; i += 200) {
    const params = [];
    const values = rows.slice(i, i + 200).map(r => `(${cols.map(c => { params.push(r[c] ?? null); return `$${params.length}`; }).join(",")})`);
    await t.exec(`INSERT INTO ${table}(${cols.join(",")}) VALUES ${values.join(",")}`, params);
  }
}

export async function demoStatus(db) {
  const users = await db.many("SELECT email FROM users WHERE is_demo=TRUE ORDER BY id");
  return { exists: users.length, accounts: DEMO_ACCOUNTS.map(a => ({ email: a.email, password: a.password, role: a.role, name: `${a.first} ${a.last}`, note: a.note })), classes: CLASSES.map(c => ({ code: c.code, name: c.name })), institute: DEMO_INSTITUTE_CODE, parent_links: users.length ? DEMO_PARENT_LINKS.map(l => ({ student: l.student, path: `/parent#${l.token}` })) : [] };
}

async function wipeDemo(db) {
  const ids = (await db.many("SELECT id FROM users WHERE is_demo=TRUE")).map(x => x.id);
  const paths = [];
  if (ids.length) {
    paths.push(...(await db.many("SELECT a.file_path AS p FROM attachments a JOIN classes c ON c.id=a.class_id JOIN users t ON t.id=c.teacher_id WHERE t.is_demo=TRUE")).map(x => x.p));
    paths.push(...(await db.many("SELECT f.file_path AS p FROM submission_files f JOIN classes c ON c.id=f.class_id JOIN users t ON t.id=c.teacher_id WHERE t.is_demo=TRUE")).map(x => x.p));
  }
  await db.tx(async t => { await t.exec("DELETE FROM users WHERE is_demo=TRUE"); await t.exec("DELETE FROM institutes WHERE code=$1", [DEMO_INSTITUTE_CODE]); });
  return paths;
}

export async function seedDemo(ctx) {
  const { db, clock, config, storage } = ctx;
  if (!config.allowDemo) throw new HttpError(409, "Demo accounts are switched off. Set ALLOW_DEMO=true on the server to use them.", "DEMO_OFF");
  const oldPaths = await wipeDemo(db);
  const today = clock.today();
  const at = (daysAgo, hour = 10, minute = 0) => `${clock.shift(today, -daysAgo)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
  const day = offset => clock.shift(today, offset);
  const counts = {};
  const homeworkFiles = [], testFiles = [], submissionFiles = [];

  await db.tx(async t => {
    // ---- people ----
    const ids = [];
    for (const a of DEMO_ACCOUNTS) {
      const row = await t.one(`INSERT INTO users(name,email,role,password_hash,password_changed_at,email_verified,is_demo,first_name,last_name,phone,parent_name,parent_phone,grade,school,city,subjects,profile_completed_at,last_login_at,created_at)
        VALUES($1,$2,$3,$4,$5,TRUE,TRUE,$6,$7,$8,$9,$10,$11,$12,$13,$14,$5,$5,$15) RETURNING id`,
        [`${a.first} ${a.last}`, a.email, a.role, await hashPassword(a.password), at(60), a.first, a.last, a.phone || "", a.parent || "", a.parent ? "+91 98200 00000" : "", a.role === "student" ? "Class 11" : "", a.role === "student" ? "Sunrise Public School" : "Bright Future Academy", "Pune", a.subjects || "", at(60)]);
      ids.push(row.id);
    }
    const [t1, t2, t3, s1, s2] = ids;
    const teacherIds = [t1, t2, t3], students = [s1, s2];
    const inst = await t.one(`INSERT INTO institutes(name,code,head_id,owner_email,contact_phone,city,description,status,control_mode,created_at,approved_at) VALUES($1,$2,$3,$4,$5,$6,$7,'active','managed',$8,$8) RETURNING id`,
      ["Bright Future Academy (Demo)", DEMO_INSTITUTE_CODE, t1, DEMO_ACCOUNTS[0].email, "+91 98100 00001", "Pune", "A demo coaching institute with two teachers.", at(58)]);
    await t.exec("UPDATE users SET institute_id=$1,institute_role='head' WHERE id=$2", [inst.id, t1]);
    await t.exec("UPDATE users SET institute_id=$1,institute_role='teacher' WHERE id=$2", [inst.id, t2]);

    // ---- classes, members, timetable, syllabus ----
    const classes = [];
    for (const [i, c] of CLASSES.entries()) {
      const row = await t.one("INSERT INTO classes(teacher_id,name,code,created_at) VALUES($1,$2,$3,$4) RETURNING id", [teacherIds[c.teacher], c.name, c.code, at(57)]);
      classes.push({ ...c, id: row.id, teacherId: teacherIds[c.teacher], index: i, weekdays: [(i % 5) + 1, ((i + 2) % 5) + 1] });
    }
    const notes = []; const note = (userId, daysAgo, type, title, body = "", extra = {}) => notes.push({ user_id: userId, type, title, body, priority: extra.priority || "normal", class_id: extra.classId ?? null, ref_type: extra.refType || "", ref_id: extra.refId ?? null, created_at: at(daysAgo, 9 + (notes.length % 8), (notes.length * 7) % 60), read_at: daysAgo > 3 ? at(daysAgo - 1, 20) : null });
    await bulk(t, "student_class_memberships", ["student_id", "class_id", "status", "joined_at"], classes.flatMap(c => students.map(s => ({ student_id: s, class_id: c.id, status: "active", joined_at: at(55) }))));
    await bulk(t, "join_requests", ["student_id", "class_id", "status", "created_at", "resolved_at"], classes.flatMap(c => students.map(s => ({ student_id: s, class_id: c.id, status: "approved", created_at: at(56), resolved_at: at(55) }))));
    await bulk(t, "class_schedule", ["class_id", "weekday", "start_time", "end_time", "subject", "room", "created_at"], classes.flatMap(c => c.weekdays.map((w, k) => ({ class_id: c.id, weekday: w, start_time: k ? "17:00" : "16:00", end_time: k ? "18:00" : "17:00", subject: c.subject, room: `Room ${c.index + 1}`, created_at: at(57) }))));
    const statuses = ["completed", "completed", "completed", "in-progress", "not-started"];
    await bulk(t, "syllabus_chapters", ["class_id", "subject", "chapter", "status", "updated_at"], classes.flatMap(c => c.chapters.map((chapter, k) => ({ class_id: c.id, subject: c.subject, chapter, status: statuses[k], updated_at: at(3 + k * 5) }))));

    // ---- homework, submissions ----
    for (const c of classes) {
      // one homework per class is due tomorrow in Physics and Maths, so due-date reminders have something to show
      const plan = [{ due: -12, posted: 20 }, { due: -3, posted: 12 }, { due: 2, posted: 4 }, { due: 9, posted: 1 }, ...(c.index < 4 && c.index % 2 === 0 ? [{ due: 1, posted: 0 }] : [])];
      for (const [k, p] of plan.entries()) {
        const title = `${c.subject}: ${HW_TITLES[(k + c.index) % HW_TITLES.length]}`;
        const h = await t.one("INSERT INTO homework(teacher_id,class_id,title,description,due_date,created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id", [c.teacherId, c.id, title, `Solve every question neatly and submit by the due date. Topic: ${c.chapters[Math.min(k, 4)]}.`, day(p.due), at(p.posted)]);
        if (k === 0) homeworkFiles.push({ homeworkId: h.id, classInfo: c, title, extras: c.index === 0 ? ["answers", "diagram"] : ["answers"] });
        for (const s of students) note(s, p.posted, "homework", `New homework: ${title}`, `Due ${day(p.due)}`, { classId: c.id, refType: "homework", refId: h.id });
        const subs = [];
        if (k === 0) { subs.push([s1, "Done, please check.", "reviewed", "Good work, neat steps.", p.posted - 2]); subs.push([s2, "Submitted late, sorry.", "reviewed", "Late, but the answers are mostly right.", p.posted - 14]); }
        if (k === 1) subs.push([s1, "All questions attempted.", "reviewed", "Very good. Check question 7 again.", p.posted - 3]);
        if (k === 2) subs.push([s1, "Finished early.", "submitted", "", p.posted - 1]);
        for (const [sid, nt, status, fb, ago] of subs) {
          const sub = await t.one("INSERT INTO homework_submissions(homework_id,student_id,note,status,feedback,submitted_at,reviewed_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id", [h.id, sid, nt, status, fb, at(Math.max(ago, 0), 18), status === "reviewed" ? at(Math.max(ago - 1, 0), 12) : null]);
          // files the student attached to their own work (kept when file storage is connected)
          if (sid === s1 && (k === 0 || k === 2)) submissionFiles.push({ submissionId: sub.id, studentId: sid, classInfo: c, name: `Aarav-${c.subject.replace(/\s+/g, "-")}-solutions.pdf`, kind: "pdf", title });
          if (sid === s1 && k === 0 && c.index === 0) submissionFiles.push({ submissionId: sub.id, studentId: sid, classInfo: c, name: "Aarav-working-photo.png", kind: "png", title });
          if (sid === s2 && k === 0) submissionFiles.push({ submissionId: sub.id, studentId: sid, classInfo: c, name: `Diya-${c.subject.replace(/\s+/g, "-")}-answers.pdf`, kind: "pdf", title });
          note(c.teacherId, Math.max(ago, 0), "homework_submitted", `${sid === s1 ? "Aarav Mehta" : "Diya Nair"} submitted homework`, "", { classId: c.id, refType: "homework", refId: h.id });
          if (status === "reviewed") note(sid, Math.max(ago - 1, 0), "homework_reviewed", `Your homework "${title}" was reviewed`, fb, { classId: c.id, refType: "homework", refId: h.id });
        }
      }

      // ---- tests and marks: Aarav improves, Diya slips ----
      const maxes = [50, 50, 100];
      for (const [j, ago] of [30, 14, 4].entries()) {
        const test = await t.one("INSERT INTO tests(teacher_id,class_id,title,subject,max_marks,solution,test_date,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id", [c.teacherId, c.id, `${c.subject} Unit Test ${j + 1}`, c.subject, maxes[j], `Most students lost marks on ${c.chapters[j]}. Revise the worked examples in your notes.`, day(-ago), at(ago + 3)]);
        if (j === 2) testFiles.push({ testId: test.id, classInfo: c, title: `${c.subject} Unit Test 3` });
        const pct1 = [76, 83, 90][j] + (c.index % 3) - 1, pct2 = [74, 64, 54][j] + ((c.index + 1) % 3) - 1;
        const rows = [[s1, pct1, "Excellent progress."], [s2, pct2, j ? "Needs more practice. Let's talk." : "Good start."]].map(([sid, pct, remark]) => ({ test_id: test.id, student_id: sid, marks: Math.round(pct / 100 * maxes[j] * 2) / 2, remark, created_at: at(ago - 1) }));
        await bulk(t, "marks", ["test_id", "student_id", "marks", "remark", "created_at"], rows);
        for (const s of students) { note(s, ago + 3, "test", `New test: ${c.subject} Unit Test ${j + 1}`, c.subject, { classId: c.id, refType: "test", refId: test.id }); note(s, ago - 1, "marks", `Marks posted: ${c.subject} Unit Test ${j + 1}`, `${rows.find(r => r.student_id === s).marks}/${maxes[j]}`, { classId: c.id, refType: "test", refId: test.id }); }
      }
      const upcoming = await t.one("INSERT INTO tests(teacher_id,class_id,title,subject,max_marks,solution,test_date,created_at) VALUES($1,$2,$3,$4,100,'',$5,$6) RETURNING id", [c.teacherId, c.id, `${c.subject} Chapter Test`, c.subject, day(5 + (c.index % 3)), at(2)]);
      for (const s of students) note(s, 2, "test", `New test: ${c.subject} Chapter Test`, `${c.subject} · ${day(5 + (c.index % 3))}`, { classId: c.id, refType: "test", refId: upcoming.id });

      // ---- attendance on the class's weekdays for the last 8 weeks ----
      const rand = rng(100 + c.index); const att = [];
      for (let ago = 56; ago >= 1; ago--) {
        const date = day(-ago);
        if (!c.weekdays.includes(clock.weekday(date))) continue;
        att.push({ student_id: s1, class_id: c.id, attendance_date: date, status: rand() < 0.05 ? "absent" : "present", created_at: at(ago, 19) });
        att.push({ student_id: s2, class_id: c.id, attendance_date: date, status: rand() < 0.32 ? "absent" : "present", created_at: at(ago, 19) });
      }
      await bulk(t, "attendance", ["student_id", "class_id", "attendance_date", "status", "created_at"], att);
    }

    // ---- announcements (one class, several classes, whole institute) ----
    const [c1, c2, c3, , c5] = classes;
    const announce = async (author, instituteId, scope, targetClasses, title, body, priority, ago) => {
      const a = await t.one("INSERT INTO announcements(author_id,institute_id,scope,title,body,priority,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id", [author, instituteId, scope, title, body, priority, at(ago, 8)]);
      for (const c of targetClasses) await t.exec("INSERT INTO announcement_targets(announcement_id,class_id) VALUES($1,$2)", [a.id, c.id]);
      const recipients = scope === "institute" ? [...students, t2] : students;
      for (const u of recipients) note(u, ago, "announcement", title, body.slice(0, 300), { priority, classId: targetClasses.length === 1 ? targetClasses[0].id : null, refType: "announcement", refId: a.id });
    };
    await announce(t1, null, "class", [c1], "Timing change", "Tomorrow's Physics class will begin at 5 PM instead of 4 PM.", "important", 1);
    await announce(t1, null, "classes", [c1, c2], "Lab safety rules", "Bring your lab coat and journal to the practical session on Saturday.", "normal", 6);
    await announce(t1, inst.id, "institute", [], "Annual day on Friday", "Annual day is this Friday at 4 PM in the auditorium. All students and teachers are invited.", "normal", 3);
    await announce(t2, null, "class", [c3], "Extra doubt session", "A free doubt-clearing session for Mathematics is on Saturday at 11 AM.", "normal", 2);
    await announce(t3, null, "class", [c5], "Welcome to English Communication", "Please read the first reading passage before our next class.", "normal", 9);

    // ---- calendar events and holidays ----
    const event = async (author, instituteId, kind, title, description, startOffset, endOffset, targetClasses, startTime = null) => {
      const e = await t.one("INSERT INTO calendar_events(created_by,institute_id,kind,title,description,start_date,end_date,start_time,end_time,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9) RETURNING id", [author, instituteId, kind, title, description, day(startOffset), day(endOffset), startTime, at(5)]);
      for (const c of targetClasses) await t.exec("INSERT INTO calendar_event_targets(event_id,class_id) VALUES($1,$2)", [e.id, c.id]);
    };
    await event(t1, inst.id, "holiday", "Diwali break", "Institute closed. Classes resume after the break.", 10, 11, []);
    await event(t1, null, "event", "Science exhibition", "Bring your project models.", 14, 14, [c1, c2], "10:00");
    await event(t3, null, "event", "Mock speaking test", "Prepare a two-minute talk.", 5, 5, [c5], "15:00");
    await event(t3, null, "holiday", "Teacher training day", "No classes for English and Computer Science.", 20, 20, [c5, classes[5]]);
    for (const s of students) note(s, 5, "holiday", "Holiday: Diwali break", `${day(10)} to ${day(11)}`, { refType: "calendar_event" });

    // ---- study logs: Aarav is steady and improving, Diya is irregular ----
    const logs = []; const subjects = classes.map(c => c.subject); const cats = ["tuition", "self-study", "self-study", "outside"];
    const r1 = rng(7), r2 = rng(99);
    for (let ago = 49; ago >= 0; ago--) {
      const date = day(-ago);
      if (ago === 0) { logs.push({ student_id: s1, category: "self-study", subject: "Physics", minutes: 105, study_date: date, note: "Kinematics numericals", created_at: at(0, 9) }, { student_id: s1, category: "tuition", subject: "Mathematics", minutes: 60, study_date: date, note: "Sets practice", created_at: at(0, 12) }, { student_id: s2, category: "self-study", subject: "Biology", minutes: 40, study_date: date, note: "Cell structure notes", created_at: at(0, 11) }); continue; }
      const weekend = clock.weekday(date) >= 6;
      if (ago <= 12 || r1() > 0.06) {
        const total = (ago <= 12 ? 250 : 200) + Math.round(r1() * 90) + (weekend ? 40 : 0) + (ago <= 6 ? 60 : 0); const parts = 3; // recent days are the heaviest: an improving trend
        for (let k = 0; k < parts; k++) logs.push({ student_id: s1, category: cats[Math.floor(r1() * 4)], subject: subjects[(ago + k * 2) % 6], minutes: Math.round(total / parts / 5) * 5, study_date: date, note: "", created_at: at(ago, 10 + k * 3) });
      }
      if (r2() < 0.52) { const parts = r2() < 0.4 ? 2 : 1; for (let k = 0; k < parts; k++) logs.push({ student_id: s2, category: cats[Math.floor(r2() * 4)], subject: subjects[Math.floor(r2() * 6)], minutes: 20 + Math.round(r2() * 18) * 5, study_date: date, note: "", created_at: at(ago, 15 + k * 2) }); }
    }
    await bulk(t, "study_logs", ["student_id", "category", "subject", "minutes", "study_date", "note", "created_at"], logs);
    await bulk(t, "student_goals", ["student_id", "daily_minutes", "weekly_minutes", "updated_at"], [{ student_id: s1, daily_minutes: 240, weekly_minutes: 1680, updated_at: at(40) }, { student_id: s2, daily_minutes: 180, weekly_minutes: 1260, updated_at: at(30) }]);
    await bulk(t, "student_exams", ["student_id", "subject", "title", "exam_date", "notes", "created_at"], [
      { student_id: s1, subject: "Physics", title: "Physics Unit Test", exam_date: day(5), notes: "Chapters 1 to 3", created_at: at(10) }, { student_id: s1, subject: "Mathematics", title: "Half-yearly Mathematics", exam_date: day(21), notes: "Full syllabus", created_at: at(10) },
      { student_id: s1, subject: "English", title: "English Oral Test", exam_date: day(1), notes: "Two-minute talk", created_at: at(6) },
      { student_id: s2, subject: "Chemistry", title: "Chemistry Mid-term", exam_date: day(3), notes: "", created_at: at(10) }, { student_id: s2, subject: "Biology", title: "Biology Practical", exam_date: day(12), notes: "", created_at: at(10) }]);
    const plan = (sid, weekday, from, to, subject, nt) => ({ student_id: sid, weekday, start_time: from, end_time: to, subject, note: nt, created_at: at(30) });
    await bulk(t, "study_plan_slots", ["student_id", "weekday", "start_time", "end_time", "subject", "note", "created_at"], [
      plan(s1, 1, "19:00", "20:30", "Physics", "Numericals"), plan(s1, 2, "19:00", "20:30", "Mathematics", "Practice sets"), plan(s1, 3, "19:00", "20:30", "Chemistry", "Revision"), plan(s1, 4, "19:00", "20:30", "Biology", "Diagrams"), plan(s1, 5, "19:00", "20:00", "English", "Reading"), plan(s1, 6, "10:00", "12:00", "Computer Science", "Python practice"),
      plan(s2, 1, "18:00", "19:00", "Chemistry", ""), plan(s2, 3, "18:00", "19:00", "Biology", ""), plan(s2, 6, "11:00", "12:30", "Mathematics", "Catch-up")]);
    // ---- the students' own calendars (V6): goals, revision plans and tasks, in every state ----
    const mine = (sid, kind, title, subject, notes_, from, to, doneAgo = null, times = [null, null]) => ({ student_id: sid, kind, title, subject, notes: notes_, start_date: day(from), end_date: day(to), start_time: times[0], end_time: times[1], done_at: doneAgo === null ? null : at(doneAgo, 20), created_at: at(Math.max(-from, 0) + 1), updated_at: at(Math.max(doneAgo ?? 0, 0)) });
    await bulk(t, "student_plan_items", ["student_id", "kind", "title", "subject", "notes", "start_date", "end_date", "start_time", "end_time", "done_at", "created_at", "updated_at"], [
      mine(s1, "revision", "Revise Kinematics and Laws of Motion", "Physics", "Chapters 2 and 3, then the numericals at the end.", -3, 4, null, ["19:00", "20:30"]),
      mine(s1, "goal", "Solve 30 numericals", "Physics", "Ten a day.", -1, 1),
      mine(s1, "task", "Prepare the lab journal", "", "Bring it on Saturday.", 0, 2),
      mine(s1, "revision", "Biology diagrams revision", "Biology", "Cell structure and plant physiology.", 2, 9),
      mine(s1, "revision", "Chemistry bonding notes", "Chemistry", "", -6, -1, 1),
      mine(s1, "goal", "Finish Maths exercise 3.2", "Mathematics", "", -10, -8, 8),
      mine(s2, "revision", "Catch up Chemistry chapter 2", "Chemistry", "I fell behind in class.", -8, -4),
      mine(s2, "goal", "Study two hours every day this week", "", "", -1, 5),
      mine(s2, "task", "Submit the Maths worksheet", "Mathematics", "", 0, 0),
      mine(s2, "revision", "Biology practical preparation", "Biology", "", 3, 11)]);

    // ---- parent view links (V6): open /parent#<token> with no sign-in ----
    await bulk(t, "parent_links", ["student_id", "token_hash", "created_at", "expires_at", "last_viewed_at", "view_count"], [
      { student_id: s1, token_hash: sha256(DEMO_PARENT_LINKS[0].token), created_at: at(9), expires_at: `${day(80)}T00:00:00.000Z`, last_viewed_at: at(1, 20), view_count: 4 },
      { student_id: s2, token_hash: sha256(DEMO_PARENT_LINKS[1].token), created_at: at(5), expires_at: `${day(80)}T00:00:00.000Z`, last_viewed_at: null, view_count: 0 }]);

    // ---- devices and sign-in alerts (V6). Demo logins never raise real alerts; these show what one looks like. ----
    const device = (uid, label, ago) => ({ user_id: uid, fingerprint: sha256(`demo|${uid}|${label}`), label, first_seen_at: at(ago), last_seen_at: at(Math.max(ago - 3, 0)) });
    await bulk(t, "known_devices", ["user_id", "fingerprint", "label", "first_seen_at", "last_seen_at"], [device(s1, "Chrome on Android", 40), device(s1, "Chrome on Windows", 30), device(s2, "Chrome on Android", 30), device(t1, "Chrome on Windows", 50), device(t1, "Safari on iOS", 20)]);
    note(s1, 2, "security", "New sign-in on Safari on iOS", "A sign-in from a new device. If this was not you, open Security & privacy, log out of all other devices and change your password.", { priority: "important", refType: "security" });
    note(t1, 6, "security", "New sign-in on Safari on iOS", "A sign-in from a new device. If this was not you, open Security & privacy, log out of all other devices and change your password.", { priority: "important", refType: "security" });
    await bulk(t, "notifications", ["user_id", "type", "title", "body", "priority", "class_id", "ref_type", "ref_id", "created_at", "read_at"], notes);
    Object.assign(counts, { users: ids.length, classes: classes.length, study_logs: logs.length, notifications: notes.length });
  });

  // Generated files (when file storage is connected): several per homework and test, and work the students attached.
  let files = 0;
  if (storage) {
    const store = async (owner, classInfo, kind, name, mime, buffer) => {
      const info = inspectUpload({ buffer, originalName: name, declaredMime: mime, maxBytes: config.maxUploadBytes });
      return { info, path: await putFile(ctx, owner, { classId: classInfo.id, kind, info, buffer }) };
    };
    const owners = new Map();
    const ownerOf = async c => { if (!owners.has(c.teacherId)) owners.set(c.teacherId, await db.one("SELECT id,institute_id FROM users WHERE id=$1", [c.teacherId])); return owners.get(c.teacherId); };
    const slug = s => s.replace(/\s+/g, "-");
    const attempt = async (what, fn) => { try { await fn(); files++; } catch (error) { console.error(`Demo ${what} upload failed:`, error.message); } };
    for (const f of homeworkFiles) {
      const owner = await ownerOf(f.classInfo), subject = f.classInfo.subject;
      const specs = [["worksheet.pdf", "application/pdf", simplePdf(`${subject} worksheet`, [f.title, "Demo worksheet generated by StudyTrack.", "1. Write the definition of the key term from this chapter.", "2. Solve the example problems shown in class.", "3. Draw and label the main diagram."])]];
      if (f.extras.includes("answers")) specs.push(["answer-key.pdf", "application/pdf", simplePdf(`${subject} answer key`, [f.title, "Answers for the teacher's reference and for checking.", "1. See the chapter summary, page 4.", "2. Worked solutions are in your notebook.", "3. The labelled diagram is in the picture file."])]);
      if (f.extras.includes("diagram")) specs.push(["diagram.png", "image/png", simplePng(360, 220, [226, 232, 255])]);
      for (const [name, mime, buffer] of specs) await attempt("homework file", async () => { const { info, path } = await store(owner, f.classInfo, "homework", `${slug(subject)}-${name}`, mime, buffer); await addAttachment(db, { kind: "homework", parentId: f.homeworkId, classId: f.classInfo.id, userId: owner.id, path, info, now: clock.nowIso() }); });
    }
    for (const f of testFiles) {
      const owner = await ownerOf(f.classInfo);
      for (const [name, lines] of [["question-paper.pdf", ["Time: 60 minutes. Attempt all questions.", "Section A: five short questions.", "Section B: three numerical problems.", "Section C: one long answer."]], ["solutions.pdf", ["Marking scheme and worked solutions.", "Section A: one mark each.", "Section B: three marks each, with steps.", "Section C: five marks."]]]) {
        await attempt("test file", async () => { const buffer = simplePdf(`${f.title}: ${name.replace(".pdf", "").replace("-", " ")}`, lines); const { info, path } = await store(owner, f.classInfo, "tests", `${slug(f.classInfo.subject)}-${name}`, "application/pdf", buffer); await addAttachment(db, { kind: "tests", parentId: f.testId, classId: f.classInfo.id, userId: owner.id, path, info, now: clock.nowIso() }); });
      }
    }
    for (const f of submissionFiles) {
      const owner = await ownerOf(f.classInfo);
      await attempt("submission file", async () => {
        const buffer = f.kind === "png" ? simplePng(320, 240, [255, 246, 214]) : simplePdf(`${f.title}`, ["Student's answers (demo).", "Q1. v = u + at = 12 m/s.", "Q2. s = ut + (1/2)at^2 = 30 m.", "Q3. See the working photo."]);
        const { info, path } = await store(owner, f.classInfo, "submissions", f.name, f.kind === "png" ? "image/png" : "application/pdf", buffer);
        await addSubmissionFile(db, { submissionId: f.submissionId, classId: f.classInfo.id, studentId: f.studentId, path, info, now: clock.nowIso() });
      });
    }
  }
  // Due-date reminders for both students right away (they normally appear as a student opens the app).
  for (const u of await db.many("SELECT * FROM users WHERE is_demo=TRUE AND role='student'")) await sendRemindersFor(ctx, u, { force: true });
  await removeFiles(ctx, oldPaths);
  return { ...counts, files, worksheets: files, ...(await demoStatus(db)) };
}
