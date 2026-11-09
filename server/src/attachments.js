// Files attached to homework and tests. One row per file, so an item can carry many files and every one of them
// stays viewable (V5 and earlier kept a single file in the item's own columns, so a new file replaced the old one).
import { HttpError } from "./validate.js";
import { inList } from "./repo.js";

export const MAX_ATTACHMENTS_PER_ITEM = 10;
export const MAX_FILES_PER_REQUEST = 5;

// kind (as used in URLs and storage keys) -> the column that points at the parent row
const PARENT_COLUMN = { homework: "homework_id", tests: "test_id" };
export const isAttachmentKind = kind => Object.hasOwn(PARENT_COLUMN, kind);
export function parentColumn(kind) {
  if (!isAttachmentKind(kind)) throw new HttpError(400, "Unknown file type");
  return PARENT_COLUMN[kind];
}

// Browsers can show these inline; Word files can only be downloaded.
const VIEWABLE = new Set(["application/pdf", "image/png", "image/jpeg"]);

// What the browser is allowed to see. The storage path never leaves the server.
export const publicAttachment = a => ({
  id: a.id, name: a.file_name, size: a.file_size, type: a.file_type, viewable: VIEWABLE.has(a.file_type), created_at: a.created_at,
});

// Map of parent id -> attachments (oldest first), for any number of parents in one query.
export async function attachmentsFor(db, kind, parentIds) {
  const out = new Map(parentIds.map(id => [id, []]));
  if (!parentIds.length) return out;
  const col = parentColumn(kind);
  const params = [];
  const rows = await db.many(`SELECT id,${col} AS parent_id,file_name,file_size,file_type,created_at FROM attachments WHERE ${col} IN (${inList(params, parentIds)}) ORDER BY id`, params);
  for (const row of rows) out.get(row.parent_id)?.push(publicAttachment(row));
  return out;
}

// Adds `attachments` (and the old `has_file` / `file_name` fields, so older screens keep working) to each row.
export async function withAttachments(db, kind, rows) {
  const map = await attachmentsFor(db, kind, rows.map(r => r.id));
  return rows.map(r => {
    const attachments = map.get(r.id) || [];
    return { ...r, attachments, has_file: attachments.length > 0, file_name: attachments[0]?.name ?? null };
  });
}

export async function countAttachments(db, kind, parentId) {
  return (await db.one(`SELECT COUNT(*) AS n FROM attachments WHERE ${parentColumn(kind)}=$1`, [parentId])).n;
}

export async function addAttachment(db, { kind, parentId, classId, userId, path, info, now }) {
  const col = parentColumn(kind);
  return db.one(`INSERT INTO attachments(${col},class_id,uploaded_by,file_path,file_name,file_size,file_type,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,file_name,file_size,file_type,created_at`,
    [parentId, classId, userId, path, info.displayName, info.size, info.mime, now]).then(publicAttachment);
}

// Storage keys of every file under the given parents (used to clean up storage after a delete).
export async function pathsFor(db, kind, parentIds) {
  if (!parentIds.length) return [];
  const col = parentColumn(kind);
  const params = [];
  return (await db.many(`SELECT file_path FROM attachments WHERE ${col} IN (${inList(params, parentIds)})`, params)).map(r => r.file_path);
}

// One attachment with the class that owns it and the teacher of that class (used for access checks).
export async function attachmentWithOwner(db, id) {
  return db.one(`SELECT a.id,a.homework_id,a.test_id,a.class_id,a.file_path,a.file_name,a.file_type,c.teacher_id,c.suspended
    FROM attachments a JOIN classes c ON c.id=a.class_id WHERE a.id=$1`, [id]);
}

// Exact "at most N files" even when uploads arrive at the same moment: after a file is saved, its own position among its
// siblings is counted; anything beyond the Nth is removed by its own request. (A check made BEFORE saving could be passed
// by several simultaneous uploads.) table and column names come from constants, never from user input.
export async function isBeyondLimit(db, table, column, parentId, rowId, max) {
  return (await db.one(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=$1 AND id<=$2`, [parentId, rowId])).n > max;
}

// Backups made before V6 hold the file in the homework/tests columns. After restoring one, turn those into attachments.
export async function backfillLegacyFiles(t) {
  await t.exec(`INSERT INTO attachments(homework_id,class_id,uploaded_by,file_path,file_name,file_size,file_type,created_at)
    SELECT id,class_id,teacher_id,file_path,COALESCE(file_name,'file'),COALESCE(file_size,0),COALESCE(file_type,''),created_at FROM homework WHERE file_path IS NOT NULL`);
  await t.exec(`INSERT INTO attachments(test_id,class_id,uploaded_by,file_path,file_name,file_size,file_type,created_at)
    SELECT id,class_id,teacher_id,file_path,COALESCE(file_name,'file'),COALESCE(file_size,0),COALESCE(file_type,''),created_at FROM tests WHERE file_path IS NOT NULL`);
}

// ---- Files a STUDENT attaches to a homework submission (separate table: they belong to the student, not the teacher) ----
export const MAX_SUBMISSION_FILES = 5;

export async function submissionFilesFor(db, submissionIds) {
  const out = new Map(submissionIds.map(id => [id, []]));
  if (!submissionIds.length) return out;
  const params = [];
  const rows = await db.many(`SELECT id,submission_id,file_name,file_size,file_type,created_at FROM submission_files WHERE submission_id IN (${inList(params, submissionIds)}) ORDER BY id`, params);
  for (const row of rows) out.get(row.submission_id)?.push(publicAttachment(row));
  return out;
}
export async function addSubmissionFile(db, { submissionId, classId, studentId, path, info, now }) {
  return db.one("INSERT INTO submission_files(submission_id,class_id,student_id,file_path,file_name,file_size,file_type,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,file_name,file_size,file_type,created_at",
    [submissionId, classId, studentId, path, info.displayName, info.size, info.mime, now]).then(publicAttachment);
}
// A submission file with the student who owns it, the class and its teacher, and whether the work is already reviewed.
export async function submissionFileWithOwner(db, id) {
  return db.one(`SELECT f.id,f.submission_id,f.student_id,f.class_id,f.file_path,f.file_name,f.file_type,c.teacher_id,c.suspended,s.status
    FROM submission_files f JOIN homework_submissions s ON s.id=f.submission_id JOIN classes c ON c.id=f.class_id WHERE f.id=$1`, [id]);
}
export async function submissionPathsForHomework(db, homeworkIds) {
  if (!homeworkIds.length) return [];
  const params = [];
  return (await db.many(`SELECT f.file_path FROM submission_files f JOIN homework_submissions s ON s.id=f.submission_id WHERE s.homework_id IN (${inList(params, homeworkIds)})`, params)).map(r => r.file_path);
}
