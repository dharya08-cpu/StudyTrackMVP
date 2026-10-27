// Glue between the upload inspector, storage limits and Supabase Storage.
import { HttpError } from "./validate.js";
import { inspectUpload, storageKey } from "./files.js";
import { getInstitute, instituteEnforced, storageBytesFor } from "./repo.js";

export function requireStorage(ctx) {
  if (!ctx.storage) throw new HttpError(503, "File storage is not configured", "STORAGE_OFF");
  return ctx.storage;
}

// Validates the uploaded bytes (never the client's claims). Throws a clear error for anything not allowed.
export async function inspectRequestFile(ctx, req) {
  if (!req.file) throw new HttpError(400, "A file is required");
  try {
    return inspectUpload({ buffer: req.file.buffer, originalName: req.file.originalname, declaredMime: req.file.mimetype, maxBytes: ctx.config.maxUploadBytes });
  } catch (error) {
    await ctx.audit(req, "upload_rejected", `${error.message} (${String(req.file.originalname || "").slice(0, 60)})`);
    throw error;
  }
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
