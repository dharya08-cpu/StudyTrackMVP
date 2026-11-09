// The same questions as scale.test.mjs, but over REAL network connections: a real HTTP server, and 106 independent clients
// (own cookie jar, own device, own IP address) sending requests at the same time through the production middleware chain
// (security headers, CORS, rate limits, cookies, CSRF and origin checks, authentication).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTestApp, inject } from "./helpers.mjs";
import { pageMiddleware, apiMiddleware } from "../src/app.js";
import { errorHandler } from "../src/router.js";

const UAS = [
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15",
];

async function startServer(app) {
  const chain = [...pageMiddleware(app.ctx), ...apiMiddleware(app.ctx)], onError = errorHandler(app.config);
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks); let body; if (raw.length) { try { body = JSON.parse(raw.toString()); } catch { /* not JSON */ } }
    const r = await inject(app, chain, onError, { method: req.method, url: req.url, body, headers: req.headers, ip: req.headers["x-test-ip"] || req.socket.remoteAddress });
    const headers = { ...r.headers, "content-type": "application/json" }; if (r.setCookies.length) headers["set-cookie"] = r.setCookies;
    res.writeHead(r.status, headers); res.end(JSON.stringify(r.body ?? {}));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}

const timings = [];
class Wire { // one person's browser
  constructor(base, app, { ip, ua }) { this.base = base; this.app = app; this.ip = ip; this.ua = ua; this.jar = new Map(); this.csrf = null; }
  async req(method, path, body) {
    const t0 = performance.now();
    const res = await fetch(this.base + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { origin: "http://localhost", "user-agent": this.ua, "x-test-ip": this.ip, "content-type": "application/json", ...(this.jar.size ? { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}), ...(this.csrf ? { "x-csrf-token": this.csrf } : {}) } });
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split(";"), i = pair.indexOf("="); /max-age=0|expires=thu, 01 jan 1970/i.test(c) ? this.jar.delete(pair.slice(0, i)) : this.jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = null; }
    timings.push({ ms: performance.now() - t0, status: res.status });
    return { status: res.status, body: json, headers: res.headers, text };
  }
  get(p) { return this.req("GET", p); } post(p, b = {}) { return this.req("POST", p, b); }
  async signIn(identity) {
    const n = await this.post("/api/auth/nonce");
    const r = await this.post("/api/auth/google", { credential: this.app.token({ ...identity, nonce: n.body.nonce }), role: identity.role });
    if (r.status === 200) this.csrf = r.body.csrfToken; return r;
  }
}
const ok = (r, what) => { assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text.slice(0, 160)}`); return r; };

test("106 people over real network connections at once: signed in, working, and each sees only their own world", { timeout: 180000 }, async () => {
  const app = await createTestApp({ env: { IP_LIMIT_FACTOR: "10" }, limits: { api: undefined } });
  const srv = await startServer(app);
  try {
    const today = app.clock.today();
    const teachers = Array.from({ length: 6 }, (_, i) => new Wire(srv.url, app, { ip: `198.51.100.${i + 1}`, ua: UAS[i % 4] }));
    // 100 students: 60 behind one coaching-centre router (one IP), 40 elsewhere
    const students = Array.from({ length: 100 }, (_, i) => new Wire(srv.url, app, { ip: i < 60 ? "203.0.113.77" : `192.0.2.${i}`, ua: UAS[i % 4] }));
    const wall0 = performance.now();

    // everyone signs in together
    const sign = await Promise.all([
      ...teachers.map((t, i) => t.signIn({ sub: `t${i}`, email: `zt${i}t@gmail.com`, name: `Tutor ZT${i}T`, role: "teacher" })),
      ...students.map((s, i) => s.signIn({ sub: `s${i}`, email: `zq${i}q@gmail.com`, name: `Pupil ZQ${i}Q`, role: "student" })),
    ]);
    sign.forEach((r, i) => ok(r, `sign in ${i}`));
    const sample = sign[0]; // the response a real browser would get
    const cookie = sample.headers.getSetCookie().join(" | ");
    assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Strict/i);
    assert.equal(sample.headers.get("cache-control"), "no-store"); assert.equal(sample.headers.get("x-content-type-options"), "nosniff"); assert.equal(sample.headers.get("x-frame-options"), "DENY");
    assert.match(sample.headers.get("content-security-policy") || "", /default-src 'self'/);
    students.forEach((s, i) => { s.i = i; s.id = sign[6 + i].body.user.id; });

    // every teacher makes a class; every student joins one (a few join two); teachers approve, all at the same time
    const classes = []; await Promise.all(teachers.map(async (t, i) => { const c = ok(await t.post("/api/teacher/classes", { name: `Class ZC${i}C` }), `class ${i}`).body; classes[i] = { k: i, ...c, teacher: t, students: [] }; t.cls = classes[i]; }));
    const mine = s => [s.i % 6, ...(s.i % 9 === 0 && (s.i + 2) % 6 !== s.i % 6 ? [(s.i + 2) % 6] : [])];
    await Promise.all(students.map(async s => { for (const k of mine(s)) { ok(await s.post("/api/student/join-request", { classCode: classes[k].code }), `join s${s.i}`); classes[k].students.push(s); } }));
    await Promise.all(teachers.map(async t => {
      const pending = ok(await t.req("GET", "/api/teacher/join-requests", undefined), "pending").body.pending;
      assert.equal(pending.length, t.cls.students.length, "every join request reached the right teacher");
      await Promise.all(pending.map(async p => ok(await t.post(`/api/teacher/join-requests/${p.id}/approve`, {}), "approve")));
    }));

    // teachers publish; students log, plan, and look around: all at once
    await Promise.all([
      ...teachers.map(async t => {
        const k = t.cls.k;
        await Promise.all([
          t.post("/api/teacher/homework", { title: `HW#c${k}#1`, description: `HW#c${k}#1 text`, dueDate: app.clock.shift(today, 2) }),
          t.post("/api/teacher/announcements", { title: `ANN#c${k}`, body: `ANN#c${k} body`, scope: "class", classIds: [t.cls.id] }),
        ].map(async p => ok(await p, `teacher ${k} publish`)));
      }),
      ...students.map(async s => {
        for (let j = 0; j < 3; j++) ok(await s.post("/api/student/study-log", { category: "self-study", subject: `STUDY#s${s.i}`, minutes: 20 + j, studyDate: today }), `study s${s.i}`);
        ok(await s.post("/api/student/plan-items", { kind: "goal", title: `PLAN#s${s.i}#1`, startDate: today, endDate: today }), `plan s${s.i}`);
      }),
    ]);
    // students hand in their work, then everyone reads everything, all at once
    await Promise.all(students.map(async s => {
      const dash = ok(await s.get("/api/student/dashboard"), `dash s${s.i}`).body;
      for (const h of dash.homework) ok(await s.post(`/api/student/homework/${h.id}/submit`, { note: `SUB#s${s.i}#c${classes.find(c => c.id === h.class_id).k}` }), `submit s${s.i}`);
    }));
    const wall = performance.now() - wall0;

    // ---- each person's complete view contains only their own world ----
    const leaks = [];
    const tok = text => ({ c: new Set([...text.matchAll(/#c(\d+)\b|ZC(\d+)C/g)].map(m => Number(m[1] ?? m[2]))), s: new Set([...text.matchAll(/#s(\d+)\b|ZQ(\d+)Q|zq(\d+)q@/g)].map(m => Number(m[1] ?? m[2] ?? m[3]))), t: new Set([...text.matchAll(/ZT(\d+)T|zt(\d+)t@/g)].map(m => Number(m[1] ?? m[2]))) });
    await Promise.all(students.map(async s => {
      let blob = ""; for (const u of ["/api/student/dashboard", "/api/calendar?from=2026-10-01&to=2026-10-31", "/api/notifications?limit=100", "/api/student/announcements", "/api/student/plan-items", "/api/account/export"]) { const r = ok(await s.get(u), `${u} s${s.i}`); blob += r.text; }
      const seen = tok(blob), myClasses = new Set(mine(s)), myTeachers = new Set(mine(s));
      for (const c of seen.c) if (!myClasses.has(c)) leaks.push(`student ${s.i} sees class ${c}`);
      for (const x of seen.s) if (x !== s.i) leaks.push(`student ${s.i} sees student ${x}`);
      for (const x of seen.t) if (!myTeachers.has(x)) leaks.push(`student ${s.i} sees teacher ${x}`);
      for (const k of myClasses) for (const need of [`HW#c${k}#1`, `ANN#c${k}`, `SUB#s${s.i}#c${k}`]) if (!blob.includes(need)) leaks.push(`student ${s.i} is missing ${need}`);
      if (!blob.includes(`STUDY#s${s.i}`)) leaks.push(`student ${s.i} is missing their study log`);
    }));
    await Promise.all(teachers.map(async t => {
      let blob = ""; for (const u of ["/api/teacher/overview", "/api/teacher/announcements"]) blob += ok(await t.get(u), `${u} t${t.cls.k}`).text;
      const ov = JSON.parse((await t.get("/api/teacher/overview")).text); for (const h of ov.homework) blob += (await t.get(`/api/teacher/homework/${h.id}/submissions`)).text;
      const seen = tok(blob), mineS = new Set(t.cls.students.map(s => s.i));
      for (const c of seen.c) if (c !== t.cls.k) leaks.push(`teacher ${t.cls.k} sees class ${c}`);
      for (const x of seen.s) if (!mineS.has(x)) leaks.push(`teacher ${t.cls.k} sees student ${x}`);
      for (const x of seen.t) if (x !== t.cls.k) leaks.push(`teacher ${t.cls.k} sees teacher ${x}`);
      if (/PLAN#/.test(blob)) leaks.push(`teacher ${t.cls.k} sees a student's private goal`);
    }));
    assert.deepEqual(leaks, [], `leaks over the wire:\n${leaks.slice(0, 15).join("\n")}`);

    // ---- nothing was lost or doubled, and the server never refused normal use ----
    const n = async sql => (await app.db.one(sql)).n;
    const joins = students.reduce((a, s) => a + mine(s).length, 0);
    assert.equal(await n("SELECT COUNT(*) AS n FROM student_class_memberships WHERE status='active'"), joins);
    assert.equal(await n("SELECT COUNT(*) AS n FROM study_logs"), 300); assert.equal(await n("SELECT COUNT(*) AS n FROM homework_submissions"), joins);
    assert.equal(await n("SELECT COUNT(DISTINCT student_id) AS n FROM study_logs"), 100);
    const bad = timings.filter(t => t.status >= 500 || t.status === 429 || t.status === 503); assert.equal(bad.length, 0, `refusals: ${JSON.stringify(bad.slice(0, 3))}`);
    const ms = timings.map(t => t.ms).sort((a, b) => a - b), p = q => ms[Math.floor(ms.length * q)].toFixed(0);
    console.log(`  [http] ${teachers.length + students.length} clients, ${timings.length} requests over real sockets in ${(wall / 1000).toFixed(1)}s (${(timings.length / (wall / 1000)).toFixed(0)} req/s); latency p50 ${p(0.5)} ms, p95 ${p(0.95)} ms, max ${ms.at(-1).toFixed(0)} ms; 60 students on one IP, no refusals`);
  } finally { await srv.close(); }
});
