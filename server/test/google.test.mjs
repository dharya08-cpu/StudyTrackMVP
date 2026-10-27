import test from "node:test";
import assert from "node:assert/strict";
import { createTestApp, googleToken, otherKey, CLIENT_ID } from "./helpers.mjs";
import { assertVerifiedGmail } from "../src/google.js";

const setup = async () => { const app = await createTestApp(); return { app, verify: t => app.ctx.google.verify(t), tok: (c, o) => googleToken(app.clock, c, o) }; };
const bad = (p, code = "GOOGLE_TOKEN_INVALID") => assert.rejects(p, e => e.code === code);

test("a correctly signed Google token verifies", async () => {
  const { verify, tok } = await setup();
  const claims = await verify(tok({ sub: "abc" }));
  assert.equal(claims.sub, "abc");
});
test("forged / tampered / wrong-key / alg=none / wrong issuer / wrong audience / expired tokens are all rejected", async () => {
  const { verify, tok, app } = await setup();
  await bad(verify(tok({}, { key: otherKey })));
  await bad(verify(tok({}, { alg: "none" })));
  await bad(verify(tok({}, { kid: "unknown-kid" })));
  await bad(verify(tok({ iss: "https://evil.example.com" })));
  await bad(verify(tok({ aud: "someone-elses-client-id" })));
  await bad(verify(tok({ exp: Math.floor(app.clock.now().getTime() / 1000) - 600 })));
  await bad(verify(tok({ iat: Math.floor(app.clock.now().getTime() / 1000) + 3600 })));
  await bad(verify(tok({ sub: "" })));
  const parts = tok({ email: "a@gmail.com" }).split(".");
  const tampered = `${parts[0]}.${Buffer.from(JSON.stringify({ iss: "accounts.google.com", aud: CLIENT_ID, sub: "x", email: "admin@gmail.com", exp: 9999999999 })).toString("base64url")}.${parts[2]}`;
  await bad(verify(tampered));
  await bad(verify("not-a-token"));
  await bad(verify(undefined));
  await bad(verify("a.b.c".padEnd(30, "x")));
});
test("verified-Gmail-only policy", () => {
  assert.equal(assertVerifiedGmail({ sub: "1", email: "A.B@Gmail.com", email_verified: true, name: "A" }).email, "a.b@gmail.com");
  assert.ok(assertVerifiedGmail({ sub: "1", email: "x@googlemail.com", email_verified: "true" }));
  for (const claims of [
    { email: "x@gmail.com", email_verified: false }, { email: "x@gmail.com" }, { email: "x@yahoo.com", email_verified: true },
    { email: "x@school.edu", email_verified: true, hd: "school.edu" }, { email: "x@gmail.com", email_verified: true, hd: "gmail.com" },
    { email: "x@gmail.com.evil.com", email_verified: true }, { email: "x@evilgmail.com", email_verified: true }, { email: "", email_verified: true }, {},
  ]) assert.throws(() => assertVerifiedGmail({ sub: "1", ...claims }), e => e.status === 403 && e.code === "GMAIL_REQUIRED");
});
test("Google sign-in not configured is a clear 503, not a crash", async () => {
  const app = await createTestApp();
  const { createGoogleVerifier } = await import("../src/google.js");
  await assert.rejects(createGoogleVerifier({ clientId: "", clock: app.clock }).verify("x".repeat(30)), e => e.status === 503);
});
