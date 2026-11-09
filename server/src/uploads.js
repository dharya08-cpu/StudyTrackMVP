// Glue between the upload inspector, storage limits and Supabase Storage.
import { HttpError } from "./validate.js";
import { inspectUpload, storageKey } from "./files.js";
import { getInstitute, instituteEnforced, storageBytesFor } from "./repo.js";
import { MAX_FILES_PER_REQUEST } from "./attachments.js";

export function requireStorage(ctx) {
  if (!ctx.storage) throw new HttpError(503, "File storage is not configured", "STORAGE_OFF");
  return ctx.storage;
}

// The files of a request: one file (single upload) or several (multi upload). Always an array.
export const requestFiles = req => (Array.isArray(req.files) && req.files.length ? req.files : req.file ? [req.file] : []);

// Validates one uploaded file's bytes (never the client's claims). Throws a clear error for anything not allowed.
export async function inspectRequestFile(ctx, req, file = req.file) {
  if (!file) throw new HttpError(400, "A file is required");
  try {
    return inspectUpload({ buffer: file.buffer, originalName: file.originalname, declaredMime: file.mimetype, maxBytes: ctx.config.maxUploadBytes });
  } catch (error) {
    await ctx.audit(req, "upload_rejected", `${error.message} (${String(file.originalname || "").slice(0, 60)})`);
    throw error;
  }
}

// Inspects every file of a request before anything is stored, so one bad file rejects the whole request cleanly.
export async function inspectRequestFiles(ctx, req) {
  const files = requestFiles(req);
  if (files.length > MAX_FILES_PER_REQUEST) throw new HttpError(400, `You can upload up to ${MAX_FILES_PER_REQUEST} files at a time.`);
  const out = [];
  for (const file of files) out.push({ file, info: await inspectRequestFile(ctx, req, file) });
  const total = out.reduce((sum, x) => sum + x.info.size, 0);
  if (total > ctx.config.maxUploadTotalBytes) throw new HttpError(413, `Together the files must be ${Math.round(ctx.config.maxUploadTotalBytes / 1024 / 1024)} MB or smaller.`, "UPLOAD_REJECTED");
  return out;
}

export async function assertStorageQuota(ctx, user, extraBytes, replacingBytes = 0) {
  if (!user.institute_id) return;
  const inst = await getInstitute(ctx.db, user.institute_id);
  if (instituteEnforced(inst) && inst.storage_limit_mb != null) {
    const used = await storageBytesFor(ctx.db, inst.id);
    if (used - replacingBytes + extraBytes > inst.storage_limit_mb * 1024 * 1024) {
      throw new HttpError(413, "Your institute's storage limit has been reached. Contact StudyTrack to increase it.", "STORAGE_LIMIT");
    }
  }
}

// Uploads one inspected file; the returned path is a random, namespaced key.
export async function putFile(ctx, user, { classId, kind, info, buffer }) {
  const storage = requireStorage(ctx);
  const path = storageKey({ instituteId: user.institute_id, teacherId: user.id, classId, kind, ext: info.ext });
  try { await storage.upload(ctx.config.supabase.bucket, path, buffer, { contentType: info.mime }); }
  catch (error) { console.error("Upload failed:", error.message); throw new HttpError(502, "File upload failed. Please try again."); }
  return path;
}
export async function removeFiles(ctx, paths) {
  const list = paths.filter(Boolean);
  if (!list.length || !ctx.storage) return;
  try { await ctx.storage.remove(ctx.config.supabase.bucket, list); } catch (error) { console.error("Storage cleanup failed:", error.message); }
}
