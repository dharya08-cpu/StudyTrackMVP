// Short-lived signed download/view links. Access is decided here, per request, from class ownership or membership;
// the storage bucket itself stays private. An unknown file and "not yours" give the same answer, so ids cannot be probed.
import { HttpError, v } from "../validate.js";
import { isActiveMember, getClass } from "../repo.js";
import { requireStorage } from "../uploads.js";
import { attachmentWithOwner, submissionFileWithOwner, isAttachmentKind, parentColumn } from "../attachments.js";

export function fileRoutes(ctx, r) {
  const { db, config, auth, limiters } = ctx;

  async function mayOpen(user, a) {
    if (!a) return false;
    if (a.student_id !== undefined) return a.student_id === user.id || (user.role === "teacher" && a.teacher_id === user.id); // a student's submission file: the student and the class teacher only
    if (user.role === "teacher") return a.teacher_id === user.id;
    if (user.role === "student") return await isActiveMember(db, user.id, a.class_id) && (await getClass(db, a.class_id))?.available === true;
    return false;
  }
  async function link(req, res, a, { downloadByDefault }) {
    if (!await mayOpen(req.user, a)) throw new HttpError(404, "File not found");
    // "inline" opens PDFs and images in the browser tab; "attachment" saves the file. Both are short-lived links.
    const wanted = req.query.disposition === undefined ? "" : v.oneOf(String(req.query.disposition), "Disposition", ["inline", "attachment"]);
    const download = wanted ? wanted === "attachment" : downloadByDefault;
    const storage = requireStorage(ctx);
    let url;
    try { url = await storage.signedUrl(config.supabase.bucket, a.file_path, 300, download ? a.file_name || "file" : undefined); }
    catch (error) { console.error("Signed URL failed:", error.message); throw new HttpError(502, "File download is unavailable"); }
    res.json({ url, fileName: a.file_name, type: a.file_type, expiresIn: 300 });
  }

  // One file by its own id (the V6 way: every attached file has an id, so every one can be opened).
  r.get("/api/attachments/:id", auth, limiters.heavy.guard, async (req, res) => {
    await link(req, res, await attachmentWithOwner(db, v.id(req.params.id, "file")), { downloadByDefault: false });
  });

  // A file a student attached to their homework submission.
  r.get("/api/submission-files/:id", auth, limiters.heavy.guard, async (req, res) => {
    await link(req, res, await submissionFileWithOwner(db, v.id(req.params.id, "file")), { downloadByDefault: false });
  });

  // Older clients: /api/files/homework/12 opens the FIRST file of that homework.
  r.get("/api/files/:kind/:id", auth, limiters.heavy.guard, async (req, res) => {
    const kind = req.params.kind;
    if (!isAttachmentKind(kind)) throw new HttpError(400, "File type must be one of: homework, tests");
    const first = await db.one(`SELECT id FROM attachments WHERE ${parentColumn(kind)}=$1 ORDER BY id LIMIT 1`, [v.id(req.params.id)]);
    await link(req, res, first && await attachmentWithOwner(db, first.id), { downloadByDefault: true });
  });
}
