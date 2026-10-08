import test from "node:test";
import assert from "node:assert/strict";
import { createTestApp, Browser } from "./helpers.mjs";

test("health, google sign-in and /api/me work end to end", async () => {
  const app = await createTestApp();
  const h = await app.request({ method: "GET", url: "/api/health" });
  assert.equal(h.status, 200);
  const b = new Browser(app);
  const r = await b.signIn({ sub: "s1", email: "ana@gmail.com", name: "Ana", role: "student" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.isNew, true);
  const me = await b.get("/api/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, "ana@gmail.com");
});
