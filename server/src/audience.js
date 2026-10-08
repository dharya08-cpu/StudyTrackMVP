// Who an announcement or calendar event is for: one class, several classes, or the whole institute.
import { HttpError, v } from "./validate.js";
import { classForReq } from "./classctx.js";
import { getInstitute, isHeadRole, inList, activeStudentIds } from "./repo.js";

export async function resolveAudience(db, req, body) {
  const scope = v.oneOf(body?.scope, "Audience", ["class", "classes", "institute"]);
  if (scope === "institute") {
    if (!req.user.institute_id || !isHeadRole(req.user.institute_role)) throw new HttpError(403, "Only an institute head can post to the whole institute.", "NOT_INSTITUTE_HEAD");
    const inst = await getInstitute(db, req.user.institute_id);
    if (!inst || inst.status !== "active") throw new HttpError(403, "Your institute is not active.", "INSTITUTE_NOT_ACTIVE");
    return { scope, instituteId: inst.id, classIds: [] };
  }
  let ids;
  if (scope === "class") {
    ids = body?.classIds === undefined && body?.classId === undefined ? [(await classForReq(db, req)).id] : v.idList(body.classIds ?? [body.classId], "Class", { min: 1, max: 1 });
  } else ids = v.idList(body?.classIds, "Classes", { min: 2, max: 20 });
  const p = [req.user.id];
  const rows = await db.many(`SELECT id,suspended FROM classes WHERE teacher_id=$1 AND id IN (${inList(p, ids)})`, p);
  if (rows.length !== ids.length) throw new HttpError(404, "Class not found");
  if (rows.some(c => c.suspended)) throw new HttpError(403, "One of these classes has been suspended by StudyTrack.", "CLASS_SUSPENDED");
  return { scope, instituteId: null, classIds: ids };
}

export async function recipientIds(db, audience, authorId) {
  if (audience.scope !== "institute") return (await activeStudentIds(db, audience.classIds)).filter(id => id !== authorId);
  const students = await db.many(`SELECT DISTINCT m.student_id AS id FROM student_class_memberships m JOIN classes c ON c.id=m.class_id JOIN users t ON t.id=c.teacher_id
    WHERE m.status='active' AND t.institute_id=$1`, [audience.instituteId]);
  const teachers = await db.many("SELECT id FROM users WHERE institute_id=$1 AND role='teacher' AND id<>$2", [audience.instituteId, authorId]);
  return [...students, ...teachers].map(r => r.id);
}
