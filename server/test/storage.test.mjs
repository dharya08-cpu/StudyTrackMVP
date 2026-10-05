// File-storage behaviour (limits, size tracking, cleanup on delete).
// These tests need a stand-in for Supabase Storage, so they only run when
// STUDYTRACK_STORAGE_STUB=1 (the stub module records uploads in SUPA_LOG).
// A normal `npm test` skips them and never touches your real Supabase bucket.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startServer, makeKit } from "./helpers.mjs";

const enabled = process.env.STUDYTRACK_STORAGE_STUB === "1";
let srv, api, kit, admin, supaLog;
before(async () => {
  if (!enabled) return;
  supaLog = `/tmp/supa-${Date.now()}.log`;
  srv = await startServer({ SUPA_LOG: supaLog, SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k", SUPABASE_BUCKET: "b" });
  api = srv.api; kit = makeKit(api); admin = await kit.adminToken();
});
after(async () => { if (srv) await srv.stop(); });

const upload = (token, route, size, name, classId) => {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(size).fill(1)]), name);
  return fetch(srv.base + route, { method: "POST", headers: { authorization: `Bearer ${token}`, ...(classId ? { "x-class-id": String(classId) } : {}) }, body: form })
    .then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));
};
const removals = () => fs.readFileSync(supaLog, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(e => e.op === "remove").flatMap(e => e.paths);

test("storage limit blocks oversize uploads; replacing a file counts only the new size", { skip: !enabled }, async () => {
  const inst = await kit.activeInstitute();
  await api.patch(`/api/admin/institutes/${inst.instituteId}/limits`, { storage_limit_mb: 1 }, { token: admin });
  const klass = await api.post("/api/teacher/classes", { name: "Store", code: "STO001" }, { token: inst.head.token });
  const hw = await api.post("/api/teacher/homework", { title: "Sheet" }, { token: inst.head.token, classId: klass.data.id });
  assert.equal((await upload(inst.head.token, `/api/teacher/homework/${hw.data.id}/attach`, 400 * 1024, "a.pdf", klass.data.id)).status, 201);
  assert.equal((await upload(inst.head.token, `/api/teacher/homework/${hw.data.id}/attach`, 700 * 1024, "b.pdf", klass.data.id)).status, 201, "old 400 KB is replaced, not added");
  const hw2 = await api.post("/api/teacher/homework", { title: "Sheet 2" }, { token: inst.head.token, classId: klass.data.id });
  const tooBig = await upload(inst.head.token, `/api/teacher/homework/${hw2.data.id}/attach`, 500 * 1024, "c.pdf", klass.data.id);
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.data.code, "STORAGE_LIMIT");
  const detail = await api.get(`/api/admin/institutes/${inst.instituteId}`, { token: admin });
  assert.equal(detail.data.institute.usage.storage_bytes, 700 * 1024);
  assert.ok(removals().length >= 1, "the replaced file was removed from storage");
});

test("deleting an institute with its data removes the uploaded files", { skip: !enabled }, async () => {
  const inst = await kit.activeInstitute();
  const t = await kit.joinInstitute(inst.code, "Doomed");
  const klass = await api.post("/api/teacher/classes", { name: "Doomed", code: "DOOM77" }, { token: t.token });
  const hw = await api.post("/api/teacher/homework", { title: "hw" }, { token: t.token, classId: klass.data.id });
  assert.equal((await upload(t.token, `/api/teacher/homework/${hw.data.id}/attach`, 2048, "d.pdf", klass.data.id)).status, 201);
  assert.equal((await api.del(`/api/admin/institutes/${inst.instituteId}?withData=true`, { token: admin })).status, 200);
  assert.ok(removals().some(p => p.startsWith("DOOM77/homework/")), "storage objects were deleted");
});
