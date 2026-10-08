// One-off migration of a V3 SQLite database into the V4 PostgreSQL schema.
// - Works with any V3 shape: only columns that exist are copied, the rest get safe defaults.
// - users.class_code becomes real rows in student_class_memberships.
// - Passwords are NOT copied (V4 has Google sign-in only). Accounts link to Google on their first sign-in by e-mail.
import { createRequire } from "node:module";
import { BACKUP_TABLES, resetSequences } from "./backup.js";

const require = createRequire(import.meta.url);
export async function openSqliteFile(file) {
  try { const { DatabaseSync } = await import("node:sqlite"); const raw = new DatabaseSync(file, { readOnly: true }); return { all: (sql, ...a) => raw.prepare(sql).all(...a), close: () => raw.close() }; }
  catch (first) {
    try { const Database = require("better-sqlite3"); const raw = new Database(file, { readonly: true }); return { all: (sql, ...a) => raw.prepare(sql).all(...a), close: () => raw.close() }; }
    catch { throw new Error(`Cannot open the SQLite file. Use Node 22+ or run: npm install --no-save better-sqlite3 (${first.message})`); }
  }
}

const iso = value => {
  if (value == null || value === "") return null;
  const s = String(value);
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/.test(s)) return `${s.replace(" ", "T")}Z`;
  return /^\d{4}-\d\d-\d\d(T|$)/.test(s) ? s : null;
};
const day = value => (value && /^\d{4}-\d\d-\d\d/.test(String(value)) ? String(value).slice(0, 10) : null);
const bool = value => value === 1 || value === true || value === "1" || value === "true";
const oneOf = (value, list, fallback) => (list.includes(value) ? value : fallback);

export async function importSqlite({ sqlitePath, target, wipe = false, log = () => {} }) {
  const src = await openSqliteFile(sqlitePath);
  const report = { copied: {}, skipped: [], notes: [] };
  try {
    const tables = new Set(src.all("SELECT name FROM sqlite_master WHERE type='table'").map(t => t.name));
    const columns = table => new Set(tables.has(table) ? src.all(`PRAGMA table_info(${table})`).map(c => c.name) : []);
    const rowsOf = table => (tables.has(table) ? src.all(`SELECT * FROM ${table} ORDER BY id`) : []);
    const has = (cols, ...names) => names.every(n => cols.has(n));

    await target.tx(async t => {
      if (wipe) for (const table of [...BACKUP_TABLES].reverse()) await t.exec(`DELETE FROM ${table}`);
      else if ((await t.one("SELECT COUNT(*) AS n FROM users")).n > 0) throw new Error("Target database already has users. Use an empty database or pass --wipe.");
      const insert = async (table, cols, rows) => {
        if (!rows.length) return;
        const chunk = Math.max(1, Math.floor(20000 / cols.length));
        for (let i = 0; i < rows.length; i += chunk) {
          const params = [];
          const values = rows.slice(i, i + chunk).map(r => `(${cols.map(c => { params.push(r[c] ?? null); return `$${params.length}`; }).join(",")})`);
          await t.exec(`INSERT INTO ${table}(${cols.join(",")}) VALUES ${values.join(",")}`, params);
        }
        report.copied[table] = (report.copied[table] || 0) + rows.length;
      };
      const now = new Date().toISOString();

      // institutes
      const ic = columns("institutes");
      const institutes = rowsOf("institutes").map(r => ({
        id: r.id, name: r.name, code: r.code, head_id: null, owner_email: String(r.owner_email || r.email || "").toLowerCase(), contact_phone: r.contact_phone || "", city: r.city || "", description: r.description || "",
        expected_teachers: r.expected_teachers ?? null, expected_students: r.expected_students ?? null, status: oneOf(r.status, ["pending", "active", "rejected", "suspended", "banned"], "pending"), status_reason: r.status_reason || "",
        control_mode: oneOf(r.control_mode, ["managed", "independent"], "managed"), read_only: bool(r.read_only), max_teachers: r.max_teachers ?? null, max_students: r.max_students ?? null, storage_limit_mb: r.storage_limit_mb ?? null,
        admin_note: r.admin_note || "", created_at: iso(r.created_at) || now, approved_at: iso(r.approved_at),
      }));
      const headOf = new Map(rowsOf("institutes").map(r => [r.id, r.head_id ?? null]));
      await insert("institutes", Object.keys(institutes[0] || { id: 1 }), institutes);

      // users (no passwords)
      const uc = columns("users");
      const seen = new Set(), users = [], studentClass = new Map();
      for (const r of rowsOf("users")) {
        const email = String(r.email || "").trim().toLowerCase();
        if (!email || seen.has(email)) { report.skipped.push(`user #${r.id} (${email || "no email"}): empty or duplicate e-mail`); continue; }
        seen.add(email);
        if (!/@(gmail|googlemail)\.com$/.test(email)) report.notes.push(`user #${r.id} <${email}> is not a Gmail address and will not be able to sign in`);
        if (r.role === "student" && uc.has("class_code") && r.class_code) studentClass.set(r.id, String(r.class_code).toUpperCase());
        users.push({ id: r.id, google_sub: null, name: r.name || email.split("@")[0], email, role: oneOf(r.role, ["teacher", "student"], "student"),
          institute_id: institutes.some(i => i.id === r.institute_id) ? r.institute_id : null, institute_role: oneOf(r.institute_role, ["head", "co_head", "teacher"], null), institute_note: r.institute_note || "",
          banned: bool(r.banned), ban_reason: r.ban_reason || "", last_login_at: null, created_at: iso(r.created_at) || now });
      }
      await insert("users", ["id", "google_sub", "name", "email", "role", "institute_id", "institute_role", "institute_note", "banned", "ban_reason", "last_login_at", "created_at"], users);
      const userIds = new Set(users.map(u => u.id));
      for (const [id, head] of headOf) if (head && userIds.has(head)) await t.exec("UPDATE institutes SET head_id=$1 WHERE id=$2", [head, id]);

      // classes
      const classes = rowsOf("classes").filter(c => userIds.has(c.teacher_id)).map(c => ({ id: c.id, teacher_id: c.teacher_id, name: c.name, code: String(c.code).toUpperCase(), suspended: bool(c.suspended), suspend_reason: c.suspend_reason || "", created_at: iso(c.created_at) || now }));
      await insert("classes", ["id", "teacher_id", "name", "code", "suspended", "suspend_reason", "created_at"], classes);
      const classByCode = new Map(classes.map(c => [c.code, c.id])), classIds = new Set(classes.map(c => c.id));

      // class_code  ->  student_class_memberships
      const memberships = [];
      for (const [studentId, code] of studentClass) {
        const classId = classByCode.get(code);
        if (classId) memberships.push({ student_id: studentId, class_id: classId, status: "active", joined_at: now });
        else report.skipped.push(`student #${studentId}: class code ${code} no longer exists`);
      }
      await insert("student_class_memberships", ["student_id", "class_id", "status", "joined_at"], memberships);
      const classOfStudent = new Map(memberships.map(m => [m.student_id, m.class_id]));

      // join requests and blocks
      const jc = columns("join_requests");
      await insert("join_requests", ["id", "student_id", "class_id", "status", "created_at", "resolved_at"], rowsOf("join_requests").map(r => ({
        id: r.id, student_id: r.student_id, class_id: r.class_id ?? classByCode.get(String(r.class_code || "").toUpperCase()) ?? null, status: oneOf(r.status, ["pending", "approved", "denied", "blocked", "cancelled"], "denied"), created_at: iso(r.created_at) || now, resolved_at: iso(r.resolved_at) }))
        .filter(r => userIds.has(r.student_id) && classIds.has(r.class_id)));
      await insert("teacher_blocks", ["id", "teacher_id", "student_id", "student_email", "student_name", "created_at"], rowsOf("teacher_blocks").filter(b => userIds.has(b.teacher_id)).map(b => ({ id: b.id, teacher_id: b.teacher_id, student_id: userIds.has(b.student_id) ? b.student_id : null, student_email: String(b.student_email || "").toLowerCase(), student_name: b.student_name || "", created_at: iso(b.created_at) || now })));
      void jc;

      // homework, submissions, tests, marks
      const homework = rowsOf("homework").filter(h => classIds.has(h.class_id) && userIds.has(h.teacher_id));
      await insert("homework", ["id", "teacher_id", "class_id", "title", "description", "due_date", "file_path", "file_name", "file_size", "file_type", "created_at"], homework.map(h => ({ id: h.id, teacher_id: h.teacher_id, class_id: h.class_id, title: h.title, description: h.description || "", due_date: day(h.due_date), file_path: h.file_path ?? h.file_url ?? null, file_name: h.file_name ?? null, file_size: h.file_size ?? 0, file_type: h.file_type ?? null, created_at: iso(h.created_at) || now })));
      const hwIds = new Set(homework.map(h => h.id));
      await insert("homework_submissions", ["id", "homework_id", "student_id", "note", "status", "feedback", "submitted_at", "reviewed_at"], rowsOf("homework_submissions").filter(s => hwIds.has(s.homework_id) && userIds.has(s.student_id)).map(s => ({ id: s.id, homework_id: s.homework_id, student_id: s.student_id, note: s.note || "", status: oneOf(s.status, ["submitted", "late", "reviewed"], "submitted"), feedback: s.feedback || "", submitted_at: iso(s.submitted_at) || now, reviewed_at: iso(s.reviewed_at) })));
      const tests = rowsOf("tests").filter(x => classIds.has(x.class_id) && userIds.has(x.teacher_id) && x.max_marks > 0);
      await insert("tests", ["id", "teacher_id", "class_id", "title", "subject", "max_marks", "solution", "test_date", "file_path", "file_name", "file_size", "file_type", "created_at"], tests.map(x => ({ id: x.id, teacher_id: x.teacher_id, class_id: x.class_id, title: x.title, subject: x.subject, max_marks: x.max_marks, solution: x.solution || "", test_date: day(x.test_date), file_path: x.file_path ?? x.file_url ?? null, file_name: x.file_name ?? null, file_size: x.file_size ?? 0, file_type: x.file_type ?? null, created_at: iso(x.created_at) || now })));
      const testIds = new Set(tests.map(x => x.id));
      await insert("marks", ["id", "test_id", "student_id", "marks", "remark", "created_at"], rowsOf("marks").filter(m => testIds.has(m.test_id) && userIds.has(m.student_id) && m.marks >= 0).map(m => ({ id: m.id, test_id: m.test_id, student_id: m.student_id, marks: m.marks, remark: m.remark || "", created_at: iso(m.created_at) || now })));

      // study logs, attendance (v3 had no class on attendance rows: use the student's class), syllabus, admin log
      await insert("study_logs", ["id", "student_id", "category", "subject", "minutes", "study_date", "note", "created_at"], rowsOf("study_logs").filter(l => userIds.has(l.student_id) && l.minutes > 0 && day(l.study_date)).map(l => ({ id: l.id, student_id: l.student_id, category: oneOf(l.category, ["tuition", "self-study", "outside"], "self-study"), subject: l.subject, minutes: l.minutes, study_date: day(l.study_date), note: l.note || "", created_at: iso(l.created_at) || now })));
      const att = [];
      for (const a of rowsOf("attendance")) {
        const classId = classIds.has(a.class_id) ? a.class_id : classOfStudent.get(a.student_id);
        if (userIds.has(a.student_id) && classId && day(a.attendance_date)) att.push({ id: a.id, student_id: a.student_id, class_id: classId, attendance_date: day(a.attendance_date), status: oneOf(a.status, ["present", "absent"], "absent"), created_at: iso(a.created_at) || now });
        else report.skipped.push(`attendance #${a.id}: no class to attach it to`);
      }
      await insert("attendance", ["id", "student_id", "class_id", "attendance_date", "status", "created_at"], att);
      await insert("syllabus_chapters", ["id", "class_id", "subject", "chapter", "status", "updated_at"], rowsOf("syllabus_chapters").filter(c => classIds.has(c.class_id)).map(c => ({ id: c.id, class_id: c.class_id, subject: c.subject, chapter: c.chapter, status: oneOf(c.status, ["not-started", "in-progress", "completed"], "not-started"), updated_at: iso(c.updated_at) || now })));
      await insert("admin_log", ["id", "action", "target_type", "target_id", "target_label", "detail", "created_at"], rowsOf("admin_log").map(l => ({ id: l.id, action: l.action, target_type: l.target_type, target_id: l.target_id ?? null, target_label: l.target_label || "", detail: l.detail || "", created_at: iso(l.created_at) || now })));
      void ic;
      await resetSequences(t);
    });
  } finally { src.close(); }
  return report;
}
