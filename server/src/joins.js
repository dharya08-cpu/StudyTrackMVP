// Shared by the student "join" route and the sign-up details page, so both follow identical rules.
import crypto from "node:crypto";
import { HttpError, v } from "./validate.js";
import { getClassByCode, isActiveMember, notify, isUniqueViolation, codeInUse, generateUniqueCode } from "./repo.js";

const DAY = 86400000;
export async function requestToJoin(ctx, user, rawCode) {
  const { db, clock } = ctx;
  const code = v.code(rawCode, "Class code");
  const cls = await getClassByCode(db, code);
  // Demo classes and real classes never mix, so real students' names can never appear in a demo teacher's screens.
  if (!cls || Boolean(cls.teacher_is_demo) !== Boolean(user.is_demo)) throw new HttpError(404, "No class found with that code. Check the code with your teacher.");
  const me = await db.one("SELECT id,name,email FROM users WHERE id=$1", [user.id]);
  if (await db.one("SELECT 1 AS x FROM teacher_blocks WHERE teacher_id=$1 AND (student_email=$2 OR student_id=$3)", [cls.teacher_id, me.email, me.id])) {
    throw new HttpError(403, `${cls.teacher_name} didn't allow you to join their class.`, "BLOCKED");
  }
  if (!cls.available) throw new HttpError(403, "This class isn't accepting students right now.", "CLASS_UNAVAILABLE");
  if (await isActiveMember(db, me.id, cls.id)) throw new HttpError(409, "You are already in this class.");
  if (await db.one("SELECT 1 AS x FROM join_requests WHERE student_id=$1 AND class_id=$2 AND status='pending'", [me.id, cls.id])) throw new HttpError(409, "You already have a pending request for this class.");
  // Spam protection: a cool-down after a decline, a cap on open requests and a daily cap.
  const dayAgo = new Date(clock.now().getTime() - DAY).toISOString();
  if (await db.one("SELECT 1 AS x FROM join_requests WHERE student_id=$1 AND class_id=$2 AND status='denied' AND resolved_at>=$3", [me.id, cls.id, dayAgo])) throw new HttpError(429, "Your last request to this class was declined. Please wait 24 hours before asking again.", "COOLDOWN");
  if ((await db.one("SELECT COUNT(*) AS n FROM join_requests WHERE student_id=$1 AND status='pending'", [me.id])).n >= 10) throw new HttpError(429, "You have too many pending requests. Cancel some first.", "TOO_MANY_PENDING");
  if ((await db.one("SELECT COUNT(*) AS n FROM join_requests WHERE student_id=$1 AND created_at>=$2", [me.id, dayAgo])).n >= 20) throw new HttpError(429, "You have sent too many requests today. Please try again tomorrow.", "DAILY_LIMIT");
  let id;
  try { id = (await db.one("INSERT INTO join_requests(student_id,class_id,created_at) VALUES($1,$2,$3) RETURNING id", [me.id, cls.id, clock.nowIso()])).id; }
  catch (error) { if (isUniqueViolation(error)) throw new HttpError(409, "You already have a pending request for this class."); throw error; }
  await notify(db, clock, [cls.teacher_id], { type: "join_request", title: `${me.name} wants to join ${cls.name}`, body: "Open Requests to allow or deny.", classId: cls.id, refType: "join_request", refId: id });
  return { id, teacherName: cls.teacher_name, className: cls.name };
}

const MAX_CLASSES_PER_TEACHER = 30;
export async function createClassFor(ctx, user, { name: rawName, code: rawCode }) {
  const { db, clock } = ctx;
  const name = v.str(rawName, "Class name", { min: 1, max: 100 });
  let code = v.code(rawCode, "Class code", { optional: true });
  if ((await db.one("SELECT COUNT(*) AS n FROM classes WHERE teacher_id=$1", [user.id])).n >= MAX_CLASSES_PER_TEACHER) throw new HttpError(403, `You can create up to ${MAX_CLASSES_PER_TEACHER} classes.`, "CLASS_LIMIT");
  if (code && await codeInUse(db, code)) throw new HttpError(409, "That class code is already taken. Choose another or leave it blank to generate one.");
  if (!code) code = await generateUniqueCode(db, crypto.randomInt);
  try {
    const row = await db.one("INSERT INTO classes(teacher_id,name,code,created_at) VALUES($1,$2,$3,$4) RETURNING id", [user.id, name, code, clock.nowIso()]);
    return { id: row.id, name, code, suspended: false, student_count: 0, pending_requests: 0 };
  } catch (error) { if (isUniqueViolation(error)) throw new HttpError(409, "That class code is already taken"); throw error; }
}
