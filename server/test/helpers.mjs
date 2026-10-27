// Shared test harness: builds the real app context on a test database and runs requests through the real middleware chain.
import crypto from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createClock } from "../src/dates.js";
import { createContext } from "../src/context.js";
import { applyMigrations } from "../src/migrate.js";
import { createGoogleVerifier } from "../src/google.js";
import { buildRoutes, pageMiddleware, apiMiddleware } from "../src/app.js";
import { errorHandler } from "../src/router.js";
import { createBackupService } from "../src/backup.js";
import { csrfTokenFor } from "../src/security.js";
import { adminCsrfFor } from "../src/sessions.js";
import { createSqliteDb } from "./sqlite-adapter.mjs";

// Default: in-memory SQLite stand-in (no setup). With TEST_DATABASE_URL=postgres://... every test app gets its own
// schema in that real PostgreSQL database (use a throw-away database; schemas named t_xxxx are left behind).
const pgSchemas = [];
let pgAdmin = null;
export async function createTestDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return createSqliteDb();
  const { default: pg } = await import("pg");
  const ssl = process.env.TEST_DATABASE_SSL === "require";
  const { createDb } = await import("../src/db.js");
  pgAdmin ??= new pg.Pool({ connectionString: url, max: 1, ssl: ssl ? { rejectUnauthorized: false } : false });
  const schema = `t_${crypto.randomBytes(5).toString("hex")}`;
  await pgAdmin.query(`CREATE SCHEMA ${schema}`);
  pgSchemas.push(schema);
  if (pgSchemas.length === 1) process.once("beforeExit", async () => { for (const s of pgSchemas) await pgAdmin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`).catch(() => {}); await pgAdmin.end().catch(() => {}); });
  return createDb({ databaseUrl: url, databaseSsl: ssl ? "require" : "disable", dbPoolMax: 4, databaseSearchPath: schema });
}

export const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "test-key-1", alg: "RS256", use: "sig" };
const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");

// Signs a Google-style ID token with the test key. Overrides let tests forge bad ones.
export function googleToken(clock, claims = {}, { kid = "test-key-1", alg = "RS256", key = keys.privateKey } = {}) {
  const now = Math.floor(clock.now().getTime() / 1000);
  const payload = { iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "sub-default", email: "default@gmail.com", email_verified: true, name: "Default User", iat: now, exp: now + 3600, ...claims };
  const head = b64({ alg, kid, typ: "JWT" }), body = b64(payload);
  const sig = alg === "none" ? "" : crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key).toString("base64url");
  return `${head}.${body}.${sig || "x"}`;
}
export const otherKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

export function memoryStorage() {
  const buckets = new Map();
  const get = name => { if (!buckets.has(name)) buckets.set(name, new Map()); return buckets.get(name); };
  return {
    name: "memory", buckets,
    async upload(b, path, buf, opts) { if (get(b).has(path)) throw new Error("exists"); get(b).set(path, { buf: Buffer.from(buf), ...opts }); },
    async remove(b, paths) { paths.forEach(p => get(b).delete(p)); },
    async signedUrl(b, path, seconds, name) { if (!get(b).has(path)) throw new Error("missing"); return `https://storage.test/${b}/${path}?token=abc&exp=${seconds}&dl=${encodeURIComponent(name || "")}`; },
    async download(b, path) { const f = get(b).get(path); if (!f) throw new Error("missing"); return f.buf; },
    async list(b) { return [...get(b).keys()].map(name => ({ name })); },
    async isPublic() { return false; },
  };
}

// Captures every e-mail instead of sending it, so tests can open the verification and reset links.
export function fakeMailer({ enabled = true } = {}) {
  const mailer = { enabled, provider: "fake", sent: [], failNext: false,
    async send(message) { if (mailer.failNext) { mailer.failNext = false; throw new Error("mail down"); } mailer.sent.push(message); },
    last: () => mailer.sent.at(-1),
    token: () => /token=([A-Za-z0-9_-]{43})/.exec(mailer.last()?.text || "")?.[1] ?? null };
  return mailer;
}

export async function createTestApp({ env = {}, limits = {}, withStorage = true, mailEnabled = true, startTime = "2026-10-07T08:00:00.000Z" } = {}) {
  let now = new Date(startTime);
  const clock = createClock("Asia/Kolkata", () => new Date(now));
  const config = loadConfig({ NODE_ENV: "test", APP_URL: "http://localhost", SESSION_SECRET: "test-session-secret-0123456789abcdef-test", ADMIN_KEY: "owner-key-123456", GOOGLE_CLIENT_ID: CLIENT_ID, STUDYTRACK_TIMEZONE: "Asia/Kolkata", ...env });
  const db = await createTestDb();
  await applyMigrations(db);
  const storage = withStorage ? memoryStorage() : null;
  const google = createGoogleVerifier({ clientId: CLIENT_ID, clock, fetchJwks: async () => ({ keys: [jwk], maxAgeSeconds: 3600 }) });
  const mailer = fakeMailer({ enabled: mailEnabled });
  const ctx = createContext({ db, config, clock, storage, google, mailer, limits: { api: 100000, ...limits } });
  ctx.backups = createBackupService({ db, storage, config, clock });
  const routes = buildRoutes(ctx);
  const chain = [...pageMiddleware(ctx), ...apiMiddleware(ctx)];
  const onError = errorHandler(config);
  const app = {
    ctx, db, clock, config, storage, routes, mail: mailer,
    setTime: iso => { now = new Date(iso); },
    advance: ms => { now = new Date(now.getTime() + ms); },
    request: (req) => inject(app, chain, onError, req),
    token: (claims, opts) => googleToken(clock, claims, opts),
  };
  return app;
}

function matchRoute(routes, method, path) {
  for (const route of routes) {
    if (route.method !== method.toLowerCase()) continue;
    const names = [];
    const re = new RegExp("^" + route.path.replace(/:([A-Za-z]+)/g, (_, n) => { names.push(n); return "([^/]+)"; }) + "/?$");
    const m = re.exec(path);
    if (m) return { route, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

// Runs one request through the same middleware as production: headers, CORS, rate limit, cookies, origin guard, auth, route.
export async function inject(app, chain, onError, { method = "GET", url, body, headers = {}, cookies = {}, file = null, ip = "203.0.113.5" }) {
  const [path, qs] = url.split("?");
  const query = Object.fromEntries(new URLSearchParams(qs || ""));
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (Object.keys(cookies).length) h.cookie = Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
  const req = { method, path, url, originalUrl: url, query, params: {}, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)), file, ip, headers: h, get: n => h[n.toLowerCase()], protocol: "http", secure: false };
  const res = { statusCode: 200, headers: {}, setCookies: [], body: undefined, headersSent: false, finished: null };
  res.promise = new Promise(resolve => { res.finished = resolve; });
  res.status = c => { res.statusCode = c; return res; };
  res.set = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
  res.append = (k, v) => { if (k.toLowerCase() === "set-cookie") res.setCookies.push(v); else res.headers[k.toLowerCase()] = res.headers[k.toLowerCase()] ? `${res.headers[k.toLowerCase()]}, ${v}` : v; return res; };
  res.removeHeader = k => { delete res.headers[k.toLowerCase()]; };
  res.json = o => { res.body = o; res.headersSent = true; res.finished(); return res; };
  res.end = () => { res.headersSent = true; res.finished(); return res; };
  const found = matchRoute(app.routes, method, path);
  const steps = [...chain];
  if (found) { req.params = found.params; steps.push(...found.route.mw, found.route.handler); }
  let index = 0, failed = null;
  const next = async err => {
    if (err) { failed = err; return onError(err, req, res, () => {}); }
    const step = steps[index++];
    if (!step) { if (!found && !res.headersSent) { res.status(404).json({ error: "Not found" }); } return; }
    try { await step(req, res, next); } catch (e) { await next(e); }
  };
  await next();
  // Middleware may call next() without returning it, so completion is the response itself (15 s safety net).
  let timer; const timedOut = await Promise.race([res.promise.then(() => false), new Promise(r => { timer = setTimeout(() => r(true), 15000); })]); clearTimeout(timer);
  if (timedOut) return { status: 599, body: { error: "test harness: the handler never responded" }, headers: res.headers, setCookies: res.setCookies, error: failed };
  return { status: res.statusCode, body: res.body, headers: res.headers, setCookies: res.setCookies, error: failed };
}

// A signed-in browser: keeps its cookies and CSRF token like the real client does.
export class Browser {
  constructor(app, { ip = "203.0.113.5", ua = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36" } = {}) { this.app = app; this.cookies = {}; this.csrf = null; this.ip = ip; this.ua = ua; }
  async call(method, url, body, extra = {}) {
    const headers = { origin: "http://localhost", "user-agent": this.ua, ...(this.csrf ? { "x-csrf-token": this.csrf } : {}), ...(extra.headers || {}) };
    const r = await this.app.request({ method, url, body, headers, cookies: this.cookies, ip: this.ip, file: extra.file || null });
    for (const c of r.setCookies) {
      const [pair, ...attrs] = c.split("; ");
      const [name, ...rest] = pair.split("=");
      const value = decodeURIComponent(rest.join("="));
      if (/Max-Age=0/.test(attrs.join(";")) || value === "") delete this.cookies[name]; else this.cookies[name] = value;
    }
    return r;
  }
  get(url, extra) { return this.call("GET", url, undefined, extra); }
  post(url, body, extra) { return this.call("POST", url, body ?? {}, extra); }
  put(url, body, extra) { return this.call("PUT", url, body ?? {}, extra); }
  patch(url, body, extra) { return this.call("PATCH", url, body ?? {}, extra); }
  delete(url, extra) { return this.call("DELETE", url, undefined, extra); }
  async register({ email, password, role = "student" }) { return this.post("/api/auth/register", { email, password, role }); }
  async login(email, password) { const r = await this.post("/api/auth/login", { email, password }); if (r.status === 200) this.csrf = r.body.csrfToken; return r; }
  // Opens the link from the last e-mail the way the web page does.
  async openMailLink(path = "/api/auth/verify-email") { const token = this.app.mail.token(); const r = await this.post(path, { token }); if (r.status === 200 && r.body.csrfToken) this.csrf = r.body.csrfToken; return r; }
  // Full Google sign-in: nonce cookie -> ID token bound to it -> session cookie + CSRF token.
  async signIn({ sub, email, name, role, claims = {} }) {
    const n = await this.post("/api/auth/nonce");
    const credential = this.app.token({ sub, email, name: name || email.split("@")[0], nonce: n.body.nonce, ...claims });
    const r = await this.post("/api/auth/google", { credential, role });
    if (r.status === 200) this.csrf = r.body.csrfToken;
    return r;
  }
}
export { csrfTokenFor, adminCsrfFor };
