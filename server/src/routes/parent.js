// Parent view: the student creates (and can cancel) a secret link; whoever has it sees a read-only weekly summary.
// Only a hash of the secret is stored. The secret travels in the link's #fragment, so it never appears in server logs,
// proxies or Referer headers, and the page sends it in a POST body.
import crypto from "node:crypto";
import { HttpError } from "../validate.js";
import { sha256 } from "../security.js";
import { buildParentSummary } from "../parent.js";

export const PARENT_LINK_DAYS = 90;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function parentRoutes(ctx, r) {
  const { db, clock, auth, role, limiters } = ctx;
  const student = [auth, role("student")];
  const view = row => row && { active: true, created_at: row.created_at, expires_at: row.expires_at, last_viewed_at: row.last_viewed_at, view_count: row.view_count };
  const activeLink = (studentId) => db.one("SELECT * FROM parent_links WHERE student_id=$1 AND revoked_at IS NULL AND expires_at>$2 ORDER BY id DESC LIMIT 1", [studentId, clock.nowIso()]);

  r.get("/api/student/parent-link", ...student, async (req, res) => {
    const me = await db.one("SELECT parent_name FROM users WHERE id=$1", [req.user.id]);
    res.json({ link: view(await activeLink(req.user.id)) || { active: false }, parent_name: me.parent_name || "", days: PARENT_LINK_DAYS });
  });
  // Making a new link cancels the old one, so there is only ever one live link per student.
  r.post("/api/student/parent-link", ...student, limiters.heavy.guard, async (req, res) => {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = clock.now();
    await db.tx(async t => {
      await t.exec("UPDATE parent_links SET revoked_at=$1 WHERE student_id=$2 AND revoked_at IS NULL", [now.toISOString(), req.user.id]);
      await t.exec("INSERT INTO parent_links(student_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4)", [req.user.id, sha256(token), now.toISOString(), new Date(now.getTime() + PARENT_LINK_DAYS * 86400000).toISOString()]);
    });
    await ctx.audit(req, "parent_link_created", "");
    res.status(201).json({ token, path: `/parent#${token}`, link: view(await activeLink(req.user.id)) }); // the only time the secret is ever shown
  });
  r.delete("/api/student/parent-link", ...student, limiters.heavy.guard, async (req, res) => {
    const n = await db.exec("UPDATE parent_links SET revoked_at=$1 WHERE student_id=$2 AND revoked_at IS NULL", [clock.nowIso(), req.user.id]);
    if (n) await ctx.audit(req, "parent_link_revoked", "");
    res.json({ ok: true });
  });
  // Exactly what the parent will see, so the student can check it before sharing.
  r.get("/api/student/parent-link/preview", ...student, async (req, res) => res.json({ summary: await buildParentSummary(db, clock, req.user.id) }));

  // Public: no sign-in. Every kind of failure gets the same answer.
  r.post("/api/parent/view", limiters.parentView.guard, async (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const invalid = new HttpError(404, "This link is not valid any more. Ask the student for a new one.", "LINK_INVALID");
    if (!TOKEN_RE.test(token)) throw invalid;
    const row = await db.one("SELECT * FROM parent_links WHERE token_hash=$1", [sha256(token)]);
    if (!row || row.revoked_at || new Date(row.expires_at) <= clock.now()) throw invalid;
    const summary = await buildParentSummary(db, clock, row.student_id);
    if (!summary) throw invalid;
    await db.exec("UPDATE parent_links SET last_viewed_at=$1,view_count=view_count+1 WHERE id=$2", [clock.nowIso(), row.id]);
    res.json({ summary, expires_at: row.expires_at });
  });
}
