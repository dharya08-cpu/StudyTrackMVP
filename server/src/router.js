// Routes are plain data: { method, path, mw[], handler }. server.js mounts them on Express and the tests run
// them through the same middleware chain, so what is tested is what runs.
export function createRouter() {
  const routes = [];
  const add = method => (path, ...fns) => { const handler = fns.pop(); routes.push({ method, path, mw: fns, handler }); };
  return { routes, get: add("get"), post: add("post"), put: add("put"), patch: add("patch"), delete: add("delete") };
}
export function errorHandler(config) {
  return (err, req, res, next) => {
    if (res.headersSent) return next?.(err);
    if (err?.status && err?.message && err.name !== "SyntaxError" && err.type === undefined) {
      return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON in request body" });
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "Request body is too large" });
    if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "That file is too large" });
    if (err?.name === "MulterError") return res.status(400).json({ error: "A single file upload is required" });
    console.error("Unhandled error:", config?.isProd ? err?.message : err);
    res.status(500).json({ error: "Internal server error" });
  };
}
