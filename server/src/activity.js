// Recent-activity feed for a class (teacher) or for one student across classes.
import { inList } from "./repo.js";
import { pct } from "./dates.js";

export async function buildActivity(db, { classIds, studentId = null, limit = 20 }) {
  if (!classIds.length) return [];
  const rows = [];
  const lim = Math.min(Math.max(limit, 1), 100);
  const studentSql = (params, column) => {
    if (studentId) { params.push(studentId); return `${column}=$${params.length}`; }
    return `${column} IN (SELECT m.student_id FROM student_class_memberships m WHERE m.status='active' AND m.class_id IN (${inList(params, classIds)}))`;
  };
  let p = [];
  let where = studentSql(p, "s.student_id");
  p.push(lim);
  rows.push(...await db.many(`SELECT 'study' AS type,u.id AS student_id,u.name AS student,s.subject AS title,CAST(s.minutes AS TEXT) AS detail,s.created_at AS created_at
    FROM study_logs s JOIN users u ON u.id=s.student_id WHERE ${where} ORDER BY s.created_at DESC LIMIT $${p.length}`, p));
  p = [];
  const hwClasses = inList(p, classIds);
  let extra = "";
  if (studentId) { p.push(studentId); extra = ` AND hs.student_id=$${p.length}`; }
  p.push(lim);
  rows.push(...await db.many(`SELECT 'homework' AS type,u.id AS student_id,u.name AS student,h.title AS title,hs.status AS detail,COALESCE(hs.reviewed_at,hs.submitted_at) AS created_at
    FROM homework_submissions hs JOIN users u ON u.id=hs.student_id JOIN homework h ON h.id=hs.homework_id
    WHERE h.class_id IN (${hwClasses})${extra} ORDER BY COALESCE(hs.reviewed_at,hs.submitted_at) DESC LIMIT $${p.length}`, p));
  p = [];
  const tClasses = inList(p, classIds);
  extra = "";
  if (studentId) { p.push(studentId); extra = ` AND m.student_id=$${p.length}`; }
  p.push(lim);
  const tests = await db.many(`SELECT 'test' AS type,u.id AS student_id,u.name AS student,t.title AS title,m.marks AS marks,t.max_marks AS max_marks,m.created_at AS created_at
    FROM marks m JOIN users u ON u.id=m.student_id JOIN tests t ON t.id=m.test_id WHERE t.class_id IN (${tClasses})${extra} ORDER BY m.created_at DESC LIMIT $${p.length}`, p);
  rows.push(...tests.map(({ marks, max_marks, ...rest }) => ({ ...rest, detail: String(pct(marks, max_marks)) })));
  p = [];
  const aClasses = inList(p, classIds);
  extra = "";
  if (studentId) { p.push(studentId); extra = ` AND a.student_id=$${p.length}`; }
  p.push(lim);
  rows.push(...await db.many(`SELECT 'attendance' AS type,u.id AS student_id,u.name AS student,'Attendance' AS title,a.status AS detail,a.created_at AS created_at
    FROM attendance a JOIN users u ON u.id=a.student_id WHERE a.class_id IN (${aClasses})${extra} ORDER BY a.created_at DESC LIMIT $${p.length}`, p));
  if (!studentId) {
    p = [];
    const sClasses = inList(p, classIds);
    p.push(lim);
    rows.push(...await db.many(`SELECT 'syllabus' AS type,NULL AS student_id,'Class' AS student,subject AS title,status AS detail,updated_at AS created_at
      FROM syllabus_chapters WHERE class_id IN (${sClasses}) ORDER BY updated_at DESC LIMIT $${p.length}`, p));
  }
  return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, lim);
}
