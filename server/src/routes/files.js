// Short-lived signed download links. Access is decided here, per request, from class membership; the bucket stays private.
import { HttpError, v } from "../validate.js";
import { isActiveMember, getClass } from "../repo.js";
import { requireStorage } from "../uploads.js";

export function fileRoutes(ctx, r) {
  const { db, config, auth, limiters } = ctx;
  r.get("/api/files/:kind/:id", auth, limiters.heavy.guard, async (req, res) => {
    const table = v.oneOf(req.params.kind, "File type", ["homework", "tests"]);
    const rec = await db.one(`SELECT x.id,x.class_id,x.file_path,x.file_name,c.teacher_id FROM ${table} x JOIN classes c ON c.id=x.class_id WHERE x.id=$1`, [v.id(req.params.id)]);
    let allowed = false;
    if (rec) {
      if (req.user.role === "teacher") allowed = rec.teacher_id === req.user.id;
      else if (req.user.role === "student") allowed = await isActiveMember(db, req.user.id, rec.class_id) && (await getClass(db, rec.class_id))?.available === true;
    }
    // Unknown file and "not yours" look identical, so ids cannot be probed.
    if (!rec || !rec.file_path || !allowed) throw new HttpError(404, "File not found");
    const storage = requireStorage(ctx);
    let url;
    try { url = await storage.signedUrl(config.supabase.bucket, rec.file_path, 300, rec.file_name || "file"); }
    catch (error) { console.error("Signed URL failed:", error.message); throw new HttpError(502, "File download is unavailable"); }
    res.json({ url, fileName: rec.file_name, expiresIn: 300 });
  });
}
