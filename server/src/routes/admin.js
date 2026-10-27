// Owner admin API. Protected by ADMIN_KEY; issues its own short-lived signed cookie that user sessions cannot be used as.
import { HttpError, v, parseId } from "../validate.js";
import { safeEqual, serializeCookie } from "../security.js";
import { signAdminToken, adminCsrfFor } from "../sessions.js";
import { adminCookieName } from "../auth.js";
import { instituteUsage, inList, notify } from "../repo.js";
import { seedDemo, demoStatus } from "../demo.js";

export function adminRoutes(ctx, r) {
  const { db, config, clock, adminAuth, limiters } = ctx;
  const logAdmin = (action, type, id, label, detail = "") => db.exec("INSERT INTO admin_log(action,target_type,target_id,target_label,detail,created_at) VALUES($1,$2,$3,$4,$5,$6)", [action, type, id ?? null, String(label || ""), String(detail || ""), clock.nowIso()]);
  const cookieOpts = { secure: config.isProd, sameSite: "Strict" };

  async function removeStorageObjects(paths) {
    const list = [...new Set(paths.filter(Boolean))];
    if (!list.length || !ctx.storage) return;
    for (let i = 0; i < list.length; i += 100) {
      try { await ctx.storage.remove(config.supabase.bucket, list.slice(i, i + 100)); } catch (error) { console.error("Storage cleanup failed:", error.message); }
    }
  }
  async function filePaths(where, params) {
    const hw = await db.many(`SELECT h.file_path AS p FROM homework h JOIN classes c ON c.id=h.class_id WHERE ${where} AND h.file_path IS NOT NULL`, params);
    const ts = await db.many(`SELECT x.file_path AS p FROM tests x JOIN classes c ON c.id=x.class_id WHERE ${where} AND x.file_path IS NOT NULL`, params);
    return [...hw, ...ts].map(x => x.p);
  }
  async function instituteRow(inst) {
    const head = inst.head_id ? await db.one("SELECT name,email FROM users WHERE id=$1", [inst.head_id]) : null;
    return { ...inst, read_only: Boolean(inst.read_only), head_name: head?.name || "", head_email: head?.email || inst.owner_email, usage: await instituteUsage(db, inst.id) };
  }
  async function instituteOr404(idParam) {
    const id = parseId(idParam);
    const inst = id && await db.one("SELECT * FROM institutes WHERE id=$1", [id]);
    if (!inst) throw new HttpError(404, "Institute not found");
    return inst;
  }
  const assertManaged = inst => {
    if (inst.control_mode === "independent") throw new HttpError(409, "This institute is independent. Return it to managed control before changing its access, limits or data.", "INDEPENDENT");
  };
  const reasonOf = body => v.optStr(body?.reason, "Reason", { max: 300 });

  r.post("/api/admin/login", limiters.adminLogin.guard, async (req, res) => {
    if (!config.adminKey) throw new HttpError(503, "Admin access is not configured. Set ADMIN_KEY on the server.");
    if (typeof req.body?.key !== "string" || !safeEqual(req.body.key, config.adminKey)) {
      limiters.adminLogin.fail(req);
      await ctx.audit(req, "admin_login_failed", "wrong key");
      throw new HttpError(401, "Incorrect admin key");
    }
    const token = signAdminToken(config.sessionSecret, clock);
    res.append("Set-Cookie", serializeCookie(adminCookieName(config), token, { ...cookieOpts, maxAgeSeconds: 12 * 3600 }));
    await ctx.audit(req, "admin_login", "ok");
    res.json({ csrfToken: adminCsrfFor(config.sessionSecret, token.split(".")[0]) });
  });
  r.get("/api/admin/session", adminAuth, (req, res) => res.json({ csrfToken: adminCsrfFor(config.sessionSecret, req.admin.payload) }));
  r.post("/api/admin/logout", adminAuth, (req, res) => {
    res.append("Set-Cookie", serializeCookie(adminCookieName(config), "", { ...cookieOpts, maxAgeSeconds: 0 }));
    res.json({ ok: true });
  });

  r.get("/api/admin/overview", adminAuth, async (req, res) => {
    const n = async (sql, params = []) => (await db.one(sql, params)).n;
    const counts = Object.fromEntries((await db.many("SELECT status,COUNT(*) AS n FROM institutes GROUP BY status")).map(x => [x.status, x.n]));
    res.json({
      institutes: { total: await n("SELECT COUNT(*) AS n FROM institutes"), pending: counts.pending || 0, active: counts.active || 0, suspended: counts.suspended || 0, banned: counts.banned || 0, rejected: counts.rejected || 0, independent: await n("SELECT COUNT(*) AS n FROM institutes WHERE control_mode='independent'") },
      teachers: await n("SELECT COUNT(*) AS n FROM users WHERE role='teacher'"), students: await n("SELECT COUNT(*) AS n FROM users WHERE role='student'"),
      classes: await n("SELECT COUNT(*) AS n FROM classes"), suspended_classes: await n("SELECT COUNT(*) AS n FROM classes WHERE suspended=TRUE"),
      active_sessions: await n("SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at>$1", [clock.nowIso()]),
      storage_bytes: (await n("SELECT COALESCE(SUM(file_size),0) AS n FROM homework")) + (await n("SELECT COALESCE(SUM(file_size),0) AS n FROM tests")),
      database_bytes: db.dialect === "postgres" ? await n("SELECT pg_database_size(current_database()) AS n") : 0,
    });
  });
  r.get("/api/admin/log", adminAuth, async (req, res) => res.json({ log: await db.many("SELECT * FROM admin_log ORDER BY id DESC LIMIT 60") }));
  r.get("/api/admin/security-events", adminAuth, async (req, res) => {
    res.json({ events: await db.many("SELECT id,user_id,type,ip_masked,detail,created_at FROM security_events ORDER BY id DESC LIMIT 150") });
  });

  r.get("/api/admin/institutes", adminAuth, async (req, res) => {
    const rows = await db.many("SELECT * FROM institutes ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,id DESC");
    res.json({ institutes: await Promise.all(rows.map(instituteRow)) });
  });
  r.get("/api/admin/institutes/:id", adminAuth, async (req, res) => {
    const inst = await instituteOr404(req.params.id);
    const teachers = await db.many("SELECT id,name,email,institute_role,banned,created_at FROM users WHERE institute_id=$1 AND role='teacher' ORDER BY id", [inst.id]);
    const out = [];
    for (const t of teachers) {
      const classes = await db.many(`SELECT c.id,c.name,c.code,c.suspended,(SELECT COUNT(*) FROM student_class_memberships m WHERE m.class_id=c.id AND m.status='active') AS student_count FROM classes c WHERE c.teacher_id=$1 ORDER BY c.id`, [t.id]);
      out.push({ ...t, banned: Boolean(t.banned), classes: classes.map(c => ({ ...c, suspended: Boolean(c.suspended) })) });
    }
    res.json({ institute: await instituteRow(inst), teachers: out });
  });

  const TRANSITIONS = { approve: { from: ["pending"], to: "active" }, reject: { from: ["pending"], to: "rejected" }, suspend: { from: ["active"], to: "suspended" }, reactivate: { from: ["suspended"], to: "active" }, ban: { from: ["active", "suspended"], to: "banned" }, unban: { from: ["banned"], to: "active" } };
  r.post("/api/admin/institutes/:id/status", adminAuth, async (req, res) => {
    const inst = await instituteOr404(req.params.id);
    const action = v.oneOf(req.body?.action, "Action", Object.keys(TRANSITIONS)), reason = reasonOf(req.body);
    const rule = TRANSITIONS[action];
    assertManaged(inst);
    if (!rule.from.includes(inst.status)) throw new HttpError(409, `You can't ${action} an institute that is ${inst.status}`);
    const keepReason = ["reject", "suspend", "ban"].includes(action) ? reason : "";
    await db.exec("UPDATE institutes SET status=$1,status_reason=$2,approved_at=$3 WHERE id=$4", [rule.to, keepReason, action === "approve" ? clock.nowIso() : inst.approved_at, inst.id]);
    await logAdmin(action, "institute", inst.id, `${inst.name} (${inst.code})`, reason);
    if (inst.head_id) await notify(db, clock, [inst.head_id], { type: "institute_status", title: `Your institute "${inst.name}" is now ${rule.to}`, body: keepReason, priority: ["suspended", "banned", "rejected"].includes(rule.to) ? "important" : "normal" });
    res.json({ institute: await instituteRow(await db.one("SELECT * FROM institutes WHERE id=$1", [inst.id])) });
  });
  r.patch("/api/admin/institutes/:id/limits", adminAuth, async (req, res) => {
    const inst = await instituteOr404(req.params.id);
    assertManaged(inst);
    const maxTeachers = v.optInt(req.body?.max_teachers, "Teacher limit", { min: 1, max: 100000 }), maxStudents = v.optInt(req.body?.max_students, "Student limit", { min: 1, max: 1000000 });
    const storageLimit = v.optInt(req.body?.storage_limit_mb, "Storage limit", { min: 1, max: 10000000 }), readOnly = req.body?.read_only === true;
    await db.exec("UPDATE institutes SET max_teachers=$1,max_students=$2,storage_limit_mb=$3,read_only=$4 WHERE id=$5", [maxTeachers, maxStudents, storageLimit, readOnly, inst.id]);
    await logAdmin("limits", "institute", inst.id, `${inst.name} (${inst.code})`, `teachers=${maxTeachers ?? "unlimited"} students=${maxStudents ?? "unlimited"} storageMB=${storageLimit ?? "unlimited"} readOnly=${readOnly}`);
    res.json({ institute: await instituteRow(await db.one("SELECT * FROM institutes WHERE id=$1", [inst.id])) });
  });
  // "independent": the owner releases control after payment; suspension, bans, limits and read-only no longer apply.
  r.patch("/api/admin/institutes/:id/control", adminAuth, async (req, res) => {
    const inst = await instituteOr404(req.params.id);
    const mode = v.oneOf(req.body?.mode, "Mode", ["independent", "managed"]);
    if (mode === inst.control_mode) return res.json({ institute: await instituteRow(inst) });
    if (mode === "independent") {
      if (inst.status !== "active") throw new HttpError(409, "Only an active institute can be made independent. Approve or reactivate it first.");
      await db.tx(async t => {
        await t.exec("UPDATE institutes SET control_mode='independent',read_only=FALSE,max_teachers=NULL,max_students=NULL,storage_limit_mb=NULL WHERE id=$1", [inst.id]);
        await t.exec("UPDATE classes SET suspended=FALSE,suspend_reason='' WHERE teacher_id IN (SELECT id FROM users WHERE institute_id=$1)", [inst.id]);
        await t.exec("UPDATE users SET banned=FALSE,ban_reason='' WHERE institute_id=$1", [inst.id]);
      });
    } else await db.exec("UPDATE institutes SET control_mode='managed' WHERE id=$1", [inst.id]);
    await logAdmin(mode === "independent" ? "make-independent" : "return-to-managed", "institute", inst.id, `${inst.name} (${inst.code})`);
    res.json({ institute: await instituteRow(await db.one("SELECT * FROM institutes WHERE id=$1", [inst.id])) });
  });
  r.patch("/api/admin/institutes/:id/note", adminAuth, async (req, res) => {
    const inst = await instituteOr404(req.params.id);
    await db.exec("UPDATE institutes SET admin_note=$1 WHERE id=$2", [v.optStr(req.body?.note, "Note", { max: 1000, multiline: true }), inst.id]);
    res.json({ ok: true });
  });
  // withData=false: teachers stay as independent teachers. withData=true: teacher accounts, classes and all class data are deleted.
  r.delete("/api/admin/institutes/:id", adminAuth, async (req, res) => {
    const inst = await instituteOr404(req.params.id);
    assertManaged(inst);
    const withData = String(req.query.withData || "") === "true";
    const teacherIds = (await db.many("SELECT id FROM users WHERE institute_id=$1 AND role='teacher'", [inst.id])).map(x => x.id);
    let paths = [];
    await db.tx(async t => {
      if (withData && teacherIds.length) {
        const p = [];
        const marks = inList(p, teacherIds);
        paths = await (async () => {
          const hw = await t.many(`SELECT h.file_path AS p FROM homework h JOIN classes c ON c.id=h.class_id WHERE c.teacher_id IN (${marks}) AND h.file_path IS NOT NULL`, p);
          const ts = await t.many(`SELECT x.file_path AS p FROM tests x JOIN classes c ON c.id=x.class_id WHERE c.teacher_id IN (${marks}) AND x.file_path IS NOT NULL`, p);
          return [...hw, ...ts].map(x => x.p);
        })();
        await t.exec(`DELETE FROM users WHERE id IN (${marks})`, p);
      } else await t.exec("UPDATE users SET institute_id=NULL,institute_role=NULL,institute_note='' WHERE institute_id=$1", [inst.id]);
      await t.exec("DELETE FROM institutes WHERE id=$1", [inst.id]);
    });
    await removeStorageObjects(paths);
    await logAdmin(withData ? "delete-with-data" : "delete", "institute", inst.id, `${inst.name} (${inst.code})`, `${teacherIds.length} teacher(s)`);
    res.json({ ok: true, teachers: teacherIds.length, withData });
  });

  r.get("/api/admin/classes", adminAuth, async (req, res) => {
    const rows = await db.many(`SELECT c.id,c.name,c.code,c.suspended,c.suspend_reason,c.created_at,t.id AS teacher_id,t.name AS teacher_name,t.email AS teacher_email,t.banned AS teacher_banned,
      i.id AS institute_id,i.name AS institute_name,i.code AS institute_code,i.control_mode,
      (SELECT COUNT(*) FROM student_class_memberships m WHERE m.class_id=c.id AND m.status='active') AS student_count,
      (SELECT COALESCE(SUM(h.file_size),0) FROM homework h WHERE h.class_id=c.id) + (SELECT COALESCE(SUM(x.file_size),0) FROM tests x WHERE x.class_id=c.id) AS storage_bytes
      FROM classes c JOIN users t ON t.id=c.teacher_id LEFT JOIN institutes i ON i.id=t.institute_id ORDER BY c.id DESC`);
    res.json({ classes: rows.map(x => ({ ...x, suspended: Boolean(x.suspended), teacher_banned: Boolean(x.teacher_banned) })) });
  });
  async function classOr404(idParam) {
    const id = parseId(idParam);
    const row = id && await db.one("SELECT c.*,t.institute_id,i.control_mode FROM classes c JOIN users t ON t.id=c.teacher_id LEFT JOIN institutes i ON i.id=t.institute_id WHERE c.id=$1", [id]);
    if (!row) throw new HttpError(404, "Class not found");
    if (row.control_mode === "independent") throw new HttpError(409, "This class belongs to an independent institute and can't be changed from the admin panel.", "INDEPENDENT");
    return row;
  }
  r.post("/api/admin/classes/:id/status", adminAuth, async (req, res) => {
    const cls = await classOr404(req.params.id);
    const action = v.oneOf(req.body?.action, "Action", ["suspend", "reactivate"]), reason = reasonOf(req.body);
    await db.exec("UPDATE classes SET suspended=$1,suspend_reason=$2 WHERE id=$3", [action === "suspend", action === "suspend" ? reason : "", cls.id]);
    await logAdmin(action, "class", cls.id, `${cls.name} (${cls.code})`, reason);
    res.json({ ok: true });
  });
  r.delete("/api/admin/classes/:id", adminAuth, async (req, res) => {
    const cls = await classOr404(req.params.id);
    const paths = await filePaths("c.id=$1", [cls.id]);
    await db.exec("DELETE FROM classes WHERE id=$1", [cls.id]);
    await removeStorageObjects(paths);
    await logAdmin("delete", "class", cls.id, `${cls.name} (${cls.code})`);
    res.json({ ok: true });
  });

  r.get("/api/admin/teachers", adminAuth, async (req, res) => {
    const rows = await db.many(`SELECT u.id,u.name,u.email,u.banned,u.ban_reason,u.created_at,u.institute_id,u.institute_role,i.name AS institute_name,i.control_mode,
      (SELECT COUNT(*) FROM classes c WHERE c.teacher_id=u.id) AS class_count,
      (SELECT COUNT(DISTINCT m.student_id) FROM student_class_memberships m JOIN classes c ON c.id=m.class_id WHERE c.teacher_id=u.id AND m.status='active') AS student_count
      FROM users u LEFT JOIN institutes i ON i.id=u.institute_id WHERE u.role='teacher' ORDER BY u.id DESC`);
    res.json({ teachers: rows.map(x => ({ ...x, banned: Boolean(x.banned) })) });
  });
  r.post("/api/admin/teachers/:id/status", adminAuth, async (req, res) => {
    const id = parseId(req.params.id);
    const teacher = id && await db.one("SELECT u.id,u.name,u.email,i.control_mode FROM users u LEFT JOIN institutes i ON i.id=u.institute_id WHERE u.id=$1 AND u.role='teacher'", [id]);
    if (!teacher) throw new HttpError(404, "Teacher not found");
    if (teacher.control_mode === "independent") throw new HttpError(409, "This teacher belongs to an independent institute and can't be changed from the admin panel.", "INDEPENDENT");
    const action = v.oneOf(req.body?.action, "Action", ["ban", "unban"]), reason = reasonOf(req.body);
    await db.exec("UPDATE users SET banned=$1,ban_reason=$2 WHERE id=$3", [action === "ban", action === "ban" ? reason : "", teacher.id]);
    if (action === "ban") await db.exec("UPDATE sessions SET revoked_at=$1,revoked_reason='banned' WHERE user_id=$2 AND revoked_at IS NULL", [clock.nowIso(), teacher.id]);
    await logAdmin(action, "teacher", teacher.id, `${teacher.name} <${teacher.email}>`, reason);
    res.json({ ok: true });
  });

  // ---- Demo accounts (for showing StudyTrack to real teachers) ----
  r.get("/api/admin/demo", adminAuth, async (req, res) => res.json({ enabled: config.allowDemo, ...(await demoStatus(db)) }));
  r.post("/api/admin/demo/reset", adminAuth, async (req, res) => {
    const out = await seedDemo(ctx);
    await logAdmin("demo-reset", "demo", null, "demo accounts", `${out.users} accounts, ${out.classes} classes`);
    res.status(201).json(out);
  });

  // ---- Backups: list, run now, test-restore ----
  r.get("/api/admin/backups", adminAuth, async (req, res) => res.json(await ctx.backups.summary()));
  r.post("/api/admin/backups/run", adminAuth, async (req, res) => {
    const out = await ctx.backups.run("manual");
    await logAdmin("backup", "database", null, "manual backup", out.ok ? `${out.size_bytes} bytes` : out.error);
    res.status(out.ok ? 201 : 500).json(out);
  });
  r.post("/api/admin/backups/:id/verify", adminAuth, async (req, res) => {
    const out = await ctx.backups.verify(v.id(req.params.id, "backup"));
    await logAdmin("backup-verify", "database", null, `backup #${req.params.id}`, out.ok ? "restore test passed" : out.error);
    res.json(out);
  });
}
