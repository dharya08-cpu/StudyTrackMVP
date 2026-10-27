// Shared queries used by many routes. Ownership and membership checks live here so every route asks the same question.
import { HttpError } from "./validate.js";

// Appends values to params and returns "$n,$n+1,..." for IN (...) lists. Only placeholders are built dynamically.
export function inList(params, values) {
  return values.map(value => { params.push(value); return `$${params.length}`; }).join(",");
}

const CLASS_SELECT = `SELECT c.id,c.name,c.code,c.teacher_id,c.suspended,c.suspend_reason,c.created_at,
  t.name AS teacher_name,t.banned AS teacher_banned,t.is_demo AS teacher_is_demo,t.institute_id,
  i.status AS inst_status,i.control_mode AS inst_mode,i.read_only AS inst_read_only,i.name AS institute_name
  FROM classes c JOIN users t ON t.id=c.teacher_id LEFT JOIN institutes i ON i.id=t.institute_id`;

// A class can be unavailable (paused by the owner, teacher banned, institute suspended) without affecting
// the student's other classes.
export function decorateClass(r) {
  if (!r) return null;
  const managed = r.institute_id && r.inst_mode === "managed";
  const instituteBlocked = Boolean(managed && ["suspended", "banned"].includes(r.inst_status));
  let reason = "";
  if (r.suspended) reason = "This class is paused right now. Please contact your teacher.";
  else if (r.teacher_banned) reason = "This class is unavailable right now. Please contact your teacher.";
  else if (instituteBlocked) reason = "Your coaching institute's access is paused. Please contact your teacher.";
  return {
    id: r.id, name: r.name, code: r.code, teacher_id: r.teacher_id, teacher_name: r.teacher_name,
    institute_id: r.institute_id ?? null, institute_name: r.institute_name ?? null, teacher_is_demo: Boolean(r.teacher_is_demo),
    suspended: Boolean(r.suspended), suspend_reason: r.suspend_reason, created_at: r.created_at,
    available: !reason, unavailable_reason: reason,
    read_only: Boolean(managed && r.inst_status === "active" && r.inst_read_only),
    joined_at: r.joined_at,
  };
}
export async function getClass(db, id) { return decorateClass(await db.one(`${CLASS_SELECT} WHERE c.id=$1`, [id])); }
export async function getClassByCode(db, code) { return decorateClass(await db.one(`${CLASS_SELECT} WHERE c.code=$1`, [code])); }
export async function studentClasses(db, studentId) {
  const rows = await db.many(`SELECT x.*,m.joined_at FROM (${CLASS_SELECT}) x JOIN student_class_memberships m ON m.class_id=x.id WHERE m.student_id=$1 AND m.status='active' ORDER BY m.id`, [studentId]);
  return rows.map(decorateClass);
}
export async function isActiveMember(db, studentId, classId) {
  return Boolean(await db.one("SELECT 1 AS ok FROM student_class_memberships WHERE student_id=$1 AND class_id=$2 AND status='active'", [studentId, classId]));
}
export async function teacherClassOr404(db, teacherId, classId) {
  const cls = await db.one("SELECT * FROM classes WHERE id=$1 AND teacher_id=$2", [classId, teacherId]);
  if (!cls) throw new HttpError(404, "Class not found");
  return cls;
}
export async function studentsForClass(db, classId) {
  return db.many(`SELECT u.id,u.name,u.email FROM users u JOIN student_class_memberships m ON m.student_id=u.id
    WHERE m.class_id=$1 AND m.status='active' AND u.role='student' ORDER BY lower(u.name),u.id`, [classId]);
}
// The student must be an active member of a class owned by this teacher (optionally one specific class).
export async function studentForTeacher(db, studentId, teacherId, classId = null) {
  const params = [studentId, teacherId];
  let extra = "";
  if (classId) { params.push(classId); extra = " AND c.id=$3"; }
  return db.one(`SELECT u.id,u.name,u.email FROM users u JOIN student_class_memberships m ON m.student_id=u.id AND m.status='active'
    JOIN classes c ON c.id=m.class_id WHERE u.id=$1 AND u.role='student' AND c.teacher_id=$2${extra} ORDER BY c.id LIMIT 1`, params);
}

// ---- Institutes -----------------------------------------------------------------------------------------------
export const isHeadRole = r => r === "head" || r === "co_head";
export const instituteEnforced = inst => Boolean(inst) && inst.control_mode === "managed";
export const getInstitute = (db, id) => db.one("SELECT * FROM institutes WHERE id=$1", [id]);
export const teacherCountFor = async (db, id) => (await db.one("SELECT COUNT(*) AS n FROM users WHERE institute_id=$1 AND role='teacher'", [id])).n;
export const classCountFor = async (db, id) => (await db.one("SELECT COUNT(*) AS n FROM classes c JOIN users t ON t.id=c.teacher_id WHERE t.institute_id=$1", [id])).n;
export const studentCountFor = async (db, id) => (await db.one(`SELECT COUNT(DISTINCT m.student_id) AS n FROM student_class_memberships m
  JOIN classes c ON c.id=m.class_id JOIN users t ON t.id=c.teacher_id WHERE m.status='active' AND t.institute_id=$1`, [id])).n;
export async function storageBytesFor(db, id) {
  const hw = await db.one("SELECT COALESCE(SUM(h.file_size),0) AS n FROM homework h JOIN classes c ON c.id=h.class_id JOIN users t ON t.id=c.teacher_id WHERE t.institute_id=$1", [id]);
  const ts = await db.one("SELECT COALESCE(SUM(x.file_size),0) AS n FROM tests x JOIN classes c ON c.id=x.class_id JOIN users t ON t.id=c.teacher_id WHERE t.institute_id=$1", [id]);
  return hw.n + ts.n;
}
export async function recordCountFor(db, id) {
  const q = [
    `SELECT COUNT(*) AS n FROM attendance a JOIN classes c ON c.id=a.class_id JOIN users t ON t.id=c.teacher_id WHERE t.institute_id=$1`,
    `SELECT COUNT(*) AS n FROM marks mk JOIN tests x ON x.id=mk.test_id JOIN classes c ON c.id=x.class_id JOIN users t ON t.id=c.teacher_id WHERE t.institute_id=$1`,
    `SELECT COUNT(*) AS n FROM homework_submissions hs JOIN homework h ON h.id=hs.homework_id JOIN classes c ON c.id=h.class_id JOIN users t ON t.id=c.teacher_id WHERE t.institute_id=$1`,
    `SELECT COUNT(*) AS n FROM study_logs s WHERE s.student_id IN (SELECT m.student_id FROM student_class_memberships m JOIN classes c ON c.id=m.class_id JOIN users t ON t.id=c.teacher_id WHERE t.institute_id=$1 AND m.status='active')`,
  ];
  let sum = 0;
  for (const sql of q) sum += (await db.one(sql, [id])).n;
  return sum;
}
export async function instituteUsage(db, id) {
  return { teachers: await teacherCountFor(db, id), classes: await classCountFor(db, id), students: await studentCountFor(db, id), records: await recordCountFor(db, id), storage_bytes: await storageBytesFor(db, id) };
}
export function instituteBlock(inst, audience) {
  if (!inst || inst.control_mode === "independent") return null;
  if (inst.status !== "suspended" && inst.status !== "banned") return null;
  const word = inst.status === "banned" ? "disabled" : "paused";
  const code = inst.status === "banned" ? "INSTITUTE_BANNED" : "INSTITUTE_SUSPENDED";
  if (audience === "student") return { code, message: `Your coaching institute's access is ${word}. Please contact your teacher.` };
  const reason = inst.status_reason ? ` Reason: ${inst.status_reason}.` : "";
  return { code, message: `Access for "${inst.name}" is ${word}.${reason} Please contact StudyTrack support.` };
}

// ---- Notifications ------------------------------------------------------------------------------------------
export async function notify(db, clock, userIds, { type, title, body = "", priority = "normal", classId = null, refType = "", refId = null }) {
  const ids = [...new Set(userIds)].filter(Number.isInteger);
  const now = clock.nowIso();
  for (let i = 0; i < ids.length; i += 200) {
    const params = [];
    const rows = ids.slice(i, i + 200).map(uid => {
      const start = params.length;
      params.push(uid, type, title, body, priority, classId, refType, refId, now);
      return `($${start + 1},$${start + 2},$${start + 3},$${start + 4},$${start + 5},$${start + 6},$${start + 7},$${start + 8},$${start + 9})`;
    });
    await db.exec(`INSERT INTO notifications(user_id,type,title,body,priority,class_id,ref_type,ref_id,created_at) VALUES ${rows.join(",")}`, params);
  }
  return ids.length;
}
export async function activeStudentIds(db, classIds) {
  if (!classIds.length) return [];
  const params = [];
  const marks = inList(params, classIds);
  return (await db.many(`SELECT DISTINCT m.student_id FROM student_class_memberships m WHERE m.status='active' AND m.class_id IN (${marks})`, params)).map(r => r.student_id);
}
export const isUniqueViolation = error => error?.code === "23505" || /UNIQUE constraint/i.test(String(error?.message || ""));

export function instituteSummaryFor(inst, user) {
  if (!inst) return null;
  return {
    id: inst.id, name: inst.name, status: inst.status, status_reason: inst.status_reason,
    role: user.institute_role || "teacher",
    code: isHeadRole(user.institute_role) ? inst.code : undefined,
    read_only: instituteEnforced(inst) && inst.status === "active" && Boolean(inst.read_only),
  };
}
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export async function codeInUse(db, code) {
  return Boolean((await db.one("SELECT 1 AS x FROM classes WHERE code=$1", [code])) || (await db.one("SELECT 1 AS x FROM institutes WHERE code=$1", [code])));
}
export async function generateUniqueCode(db, randomInt, length = 6) {
  for (let attempt = 0; attempt < 40; attempt++) {
    let code = "";
    for (let i = 0; i < length; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!(await codeInUse(db, code))) return code;
  }
  throw new HttpError(503, "Could not generate a unique code. Please try again.");
}
