// Multipart parsing with hard limits: files in memory only (nothing is ever written to local disk), small text fields.
// Single upload: one file (attach one more file to an existing homework or test).
// Multi upload: up to MAX_FILES files in one request (creating homework or a test with several files). A request whose
// declared size is already too large is refused before it is read, so it cannot use up the server's memory.
import { MAX_FILES_PER_REQUEST } from "./attachments.js";
import { createUploadGate } from "./upload-gate.js";

export async function makeUploadMw(config) {
  const multer = (await import("multer")).default;
  const limits = (files) => ({ fileSize: config.maxUploadBytes, files, fields: 20, fieldSize: 64 * 1024, parts: 25 + files, headerPairs: 50 });
  const one = multer({ storage: multer.memoryStorage(), limits: limits(1) });
  const many = multer({ storage: multer.memoryStorage(), limits: limits(MAX_FILES_PER_REQUEST) });
  const gate = createUploadGate({ budgetBytes: config.maxUploadInflightBytes, maxRequestBytes: config.maxUploadTotalBytes });
  const tooBig = req => Number(req.get("content-length") || 0) > config.maxUploadTotalBytes + 256 * 1024;
  const guard = (run) => gate.guard((req, res, next) => (tooBig(req)
    ? res.status(413).json({ error: `That upload is too large. Keep the files under ${Math.round(config.maxUploadTotalBytes / 1024 / 1024)} MB in total.`, code: "UPLOAD_REJECTED" })
    : run(req, res, next)));
  const single = guard((req, res, next) => one.single("file")(req, res, next));
  single.many = guard((req, res, next) => many.array("file", MAX_FILES_PER_REQUEST)(req, res, next));
  return single;
}
