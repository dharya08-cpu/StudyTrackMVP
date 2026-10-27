// Multipart parsing with hard limits: one file, memory only (nothing is ever written to local disk), small text fields.
export async function makeUploadMw(config) {
  const multer = (await import("multer")).default;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 20, fieldSize: 64 * 1024, parts: 25, headerPairs: 50 },
  });
  return (req, res, next) => upload.single("file")(req, res, next);
}
