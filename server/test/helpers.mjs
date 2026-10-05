// Shared helpers for the StudyTrack API tests. Boots the real server.js on a
// random port with a throw-away SQLite file and talks to it over HTTP.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ADMIN_KEY = "test-admin-key-123456";

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on("error", reject);
  });
}

export async function startServer(extraEnv = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studytrack-test-"));
  const dbFile = path.join(dir, "test.db");
  const child = spawn(process.execPath, ["server.js"], {
    cwd: serverDir,
    env: { ...process.env, NODE_ENV: "test", PORT: String(port), DB_PATH: dbFile, ADMIN_KEY, JWT_SECRET: "test-jwt-secret", TEACHER_SIGNUP_LIMIT: "5000", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start in time:\n${output}`)), 15000);
    const onData = chunk => { output += chunk; if (output.includes("StudyTrack API running")) { clearTimeout(timer); resolve(); } };
    child.stdout.on("data", onData);
    child.stderr.on("data", c => { output += c; });
    child.on("exit", code => { clearTimeout(timer); reject(new Error(`Server exited early (${code}):\n${output}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  async function call(method, route, { token, body, classId, headers = {} } = {}) {
    const res = await fetch(base + route, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(classId ? { "x-class-id": String(classId) } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }
  const api = {
    get: (route, opts) => call("GET", route, opts),
    post: (route, body, opts = {}) => call("POST", route, { ...opts, body: body ?? {} }),
    patch: (route, body, opts = {}) => call("PATCH", route, { ...opts, body: body ?? {} }),
    del: (route, opts) => call("DELETE", route, opts),
  };
  const stop = () => new Promise(resolve => { child.on("exit", () => { fs.rmSync(dir, { recursive: true, force: true }); resolve(); }); child.kill("SIGTERM"); });
  return { api, stop, base, dbFile };
}

let counter = 0;
export function makeKit(api) {
  const unique = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;
  async function student(name = "Student") {
    const email = `s${unique()}@example.com`;
    const r = await api.post("/api/auth/register", { name, email, password: "secret123" });
    if (r.status !== 201) throw new Error(`student register failed: ${JSON.stringify(r)}`);
    return { email, password: "secret123", token: r.data.token, id: r.data.user.id, name };
  }
  async function teacher(name = "Teacher", classCode = "") {
    const email = `t${unique()}@example.com`;
    const r = await api.post("/api/auth/teacher-register", { name, email, password: "secret123", className: `${name} Class`, classCode });
    if (r.status !== 201) throw new Error(`teacher register failed: ${JSON.stringify(r)}`);
    const ctx = await api.get("/api/teacher/context", { token: r.data.token });
    return { email, password: "secret123", token: r.data.token, id: r.data.user.id, name, classes: ctx.data.classes, classId: ctx.data.classes[0].id, classCode: ctx.data.classes[0].code };
  }
  async function adminToken() {
    const r = await api.post("/api/admin/login", { key: ADMIN_KEY });
    if (r.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(r)}`);
    return r.data.token;
  }
  const instituteBody = (extra = {}) => ({
    instituteName: "Bright Future Academy", phone: "+91 98765 43210", city: "Pune",
    description: "Maths and science coaching", expectedTeachers: 5, expectedStudents: 120, ...extra,
  });
  async function activeInstitute({ code } = {}) {
    const email = `h${unique()}@example.com`;
    const created = await api.post("/api/auth/institute-request", instituteBody({ coachingCode: code || "", name: "Head Teacher", email, password: "secret123" }));
    if (created.status !== 201) throw new Error(`institute request failed: ${JSON.stringify(created)}`);
    const admin = await adminToken();
    const approved = await api.post(`/api/admin/institutes/${created.data.institute.id}/status`, { action: "approve" }, { token: admin });
    if (approved.status !== 200) throw new Error(`approve failed: ${JSON.stringify(approved)}`);
    return { admin, instituteId: created.data.institute.id, code: created.data.institute.code, head: { email, password: "secret123", token: created.data.token, id: created.data.user.id } };
  }
  async function joinInstitute(code, name = "Joiner") {
    const email = `j${unique()}@example.com`;
    const r = await api.post("/api/auth/teacher-join-institute", { name, email, password: "secret123", coachingCode: code });
    if (r.status !== 201) throw new Error(`join failed: ${JSON.stringify(r)}`);
    return { email, password: "secret123", token: r.data.token, id: r.data.user.id, name };
  }
  return { student, teacher, adminToken, instituteBody, activeInstitute, joinInstitute, unique };
}
