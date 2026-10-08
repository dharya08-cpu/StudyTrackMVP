import { HttpError, parseId } from "./validate.js";

// The teacher's "current class" comes from the X-Class-Id header. A class that is not theirs is a 404 (never a hint it exists);
// no header means their first class.
export async function classForReq(db, req, { required = true } = {}) {
  const header = req.get("x-class-id");
  let cls = null;
  if (header !== undefined && header !== "") {
    const id = parseId(header);
    cls = id && await db.one("SELECT id,name,code,teacher_id,suspended FROM classes WHERE id=$1 AND teacher_id=$2", [id, req.user.id]);
    if (!cls) throw new HttpError(404, "Class not found");
  } else {
    cls = await db.one("SELECT id,name,code,teacher_id,suspended FROM classes WHERE teacher_id=$1 ORDER BY id LIMIT 1", [req.user.id]);
  }
  if (!cls && required) throw new HttpError(400, "Create a class first", "NO_CLASS");
  return cls ? { ...cls, suspended: Boolean(cls.suspended) } : null;
}
export function assertClassActive(cls) {
  if (cls.suspended) throw new HttpError(403, "This class has been suspended by StudyTrack.", "CLASS_SUSPENDED");
}
