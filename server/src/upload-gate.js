// Caps how much upload data the server holds in memory at once. Files are buffered in memory (never written to local
// disk), so without a cap a crowd uploading at the same moment could exhaust a small host. Each upload "costs" its
// declared size; when the budget is full a new upload is told to retry in a few seconds. One upload is always allowed.
export function createUploadGate({ budgetBytes, maxRequestBytes }) {
  let used = 0, inFlight = 0;
  const costOf = req => Math.min(Number(req.get("content-length")) || maxRequestBytes, maxRequestBytes + 256 * 1024);
  const guard = (run) => (req, res, next) => {
    const cost = costOf(req);
    if (inFlight > 0 && used + cost > budgetBytes) {
      res.set?.("Retry-After", "5");
      return res.status(503).json({ error: "The server is busy receiving files right now. Please try again in a few seconds.", code: "BUSY" });
    }
    used += cost; inFlight++;
    let released = false;
    const release = () => { if (!released) { released = true; used -= cost; inFlight--; } };
    res.on("finish", release); res.on("close", release);
    return run(req, res, next);
  };
  return { guard, load: () => ({ used, inFlight }) };
}
