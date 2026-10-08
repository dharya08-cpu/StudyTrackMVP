// End-to-end harness: real client bundle + real server routes/middleware/security headers, served over HTTP to a real browser.
// Only external services are faked: Google's script (a stub that signs test tokens) and file storage (in memory).
// Needs: playwright (with Chromium) and esbuild (a dependency of vite). Run: npm run e2e
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createTestApp, inject, googleToken } from "../helpers.mjs";
import { buildCsp } from "../../src/security.js";
import { errorHandler } from "../../src/router.js";
import { pageMiddleware, apiMiddleware } from "../../src/app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const clientSrc = path.resolve(here, "../../../client/src");

function findEsbuild() {
  const candidates = [path.resolve(here, "../../../client/node_modules/esbuild"), "/home/claude/.npm-global/lib/node_modules/tsx/node_modules/esbuild", "esbuild"];
  for (const c of candidates) { try { return require(c); } catch { /* try next */ } }
  throw new Error("esbuild not found (install the client dependencies first)");
}
export async function buildClient(outDir) {
  const esbuild = findEsbuild();
  fs.mkdirSync(path.join(outDir, "assets"), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(clientSrc, "main.jsx")], bundle: true, format: "esm", jsx: "automatic", outfile: path.join(outDir, "assets/main.js"), loader: { ".js": "jsx" },
    define: { "import.meta.env.VITE_API_URL": "undefined" }, nodePaths: [path.resolve(here, "../../../client/node_modules"), "/home/claude/.npm-global/lib/node_modules"], logLevel: "error",
  });
  fs.writeFileSync(path.join(outDir, "index.html"), `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>StudyTrack</title><link rel="stylesheet" href="/assets/main.css"/></head><body><div id="root"></div><script type="module" src="/assets/main.js"></script></body></html>`);
}

// Minimal multipart parser for the upload tests (production uses multer).
function parseMultipart(buf, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  const fields = {}; let file = null;
  const sep = Buffer.from(`--${boundary}`);
  let pos = buf.indexOf(sep);
  while (pos !== -1) {
    const next = buf.indexOf(sep, pos + sep.length);
    if (next === -1) break;
    const part = buf.subarray(pos + sep.length + 2, next - 2);
    const headEnd = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, headEnd).toString("utf8"), data = part.subarray(headEnd + 4);
    const name = /name="([^"]+)"/.exec(head)?.[1], filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (filename !== undefined) { if (data.length || filename) file = { buffer: Buffer.from(data), originalname: filename, mimetype: /Content-Type: (.+)/i.exec(head)?.[1]?.trim() || "", size: data.length }; }
    else if (name) fields[name] = data.toString("utf8");
    pos = next;
  }
  return { fields, file };
}

export async function startE2E({ port = 4173 } = {}) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "st-e2e-"));
  await buildClient(dist);
  const app = await createTestApp({ env: { APP_URL: `http://localhost:${port}` }, limits: { join: 1000, joinIp: 1000, upload: 1000, announce: 1000, heavy: 100000, login: 1000 }, startTime: new Date().toISOString() });
  // real time for the browser session: keep the test clock close to the wall clock
  const origin = Date.now(); const start = new Date(app.clock.now()).getTime();
  app.setTime(new Date(start).toISOString());
  const tickClock = () => app.setTime(new Date(start + (Date.now() - origin)).toISOString());
  const chain = [...pageMiddleware(app.ctx), ...apiMiddleware(app.ctx)];
  const onError = errorHandler(app.config);
  const csp = buildCsp({ isProd: false });
  const mime = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };

  const server = http.createServer(async (req, res) => {
    tickClock();
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname === "/__test/token") {
      const q = Object.fromEntries(url.searchParams);
      res.writeHead(200, { "content-type": "text/plain" }); return res.end(googleToken(app.clock, { sub: q.sub, email: q.email, name: q.name, nonce: q.nonce }));
    }
    if (url.pathname.startsWith("/api/")) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks); const ct = req.headers["content-type"] || "";
      let body, file = null;
      if (ct.startsWith("multipart/form-data")) { const p = parseMultipart(raw, ct); body = p.fields; file = p.file; }
      else if (raw.length) { try { body = JSON.parse(raw.toString()); } catch { body = undefined; } }
      const r = await inject(app, chain, onError, { method: req.method, url: req.url, body, headers: req.headers, file, ip: "127.0.0.1" });
      const headers = { ...r.headers, "content-type": "application/json" };
      if (r.setCookies.length) headers["set-cookie"] = r.setCookies;
      res.writeHead(r.status, headers); return res.end(JSON.stringify(r.body ?? {}));
    }
    const file = path.join(dist, url.pathname === "/" || !path.extname(url.pathname) ? "index.html" : url.pathname);
    if (!file.startsWith(dist) || !fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream", "content-security-policy": csp, "x-content-type-options": "nosniff" });
    res.end(fs.readFileSync(file));
  });
  await new Promise(r => server.listen(port, r));
  return { app, port, url: `http://localhost:${port}`, close: () => new Promise(r => server.close(r)) };
}

// Playwright route that replaces Google's script with a stub whose button signs in as window.__identity.
export const GOOGLE_STUB = `
(() => {
  let cfg = null;
  window.google = { accounts: { id: {
    initialize(c) { cfg = c; },
    renderButton(el) {
      el.innerHTML = '<button type="button" id="fake-google">Continue with Google</button>';
      el.querySelector('button').onclick = async () => {
        const id = window.__identity || {};
        const q = new URLSearchParams({ sub: id.sub, email: id.email, name: id.name || '', nonce: cfg.nonce });
        const credential = await (await fetch('/__test/token?' + q)).text();
        cfg.callback({ credential });
      };
    },
  } } };
})();`;
