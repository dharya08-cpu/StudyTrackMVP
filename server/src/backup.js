// Database backups: consistent logical snapshot -> gzip NDJSON with per-table checksums -> private storage bucket.
// Restore is verified, not assumed: a backup is test-restored into a throw-away schema and compared with its manifest.
import zlib from "node:zlib";
import crypto from "node:crypto";
import { applyMigrations, latestMigrationVersion } from "./migrate.js";
import { isUniqueViolation } from "./repo.js";

// Parents first (restore order). Sessions, login nonces and security events are deliberately NOT backed up.
export const BACKUP_TABLES = [
  "institutes", "users", "classes", "student_class_memberships", "join_requests", "teacher_blocks", "homework", "homework_submissions",
  "tests", "marks", "study_logs", "attendance", "syllabus_chapters", "admin_log", "notifications", "announcements", "announcement_targets",
  "class_schedule", "calendar_events", "calendar_event_targets", "student_goals", "study_plan_slots", "student_exams",
];
const SERIAL_TABLES = new Set(BACKUP_TABLES.filter(t => !["announcement_targets", "calendar_event_targets", "student_goals"].includes(t)));
const COLUMN = /^[a-z_][a-z0-9_]*$/;
const sha = data => crypto.createHash("sha256").update(data).digest("hex");

export async function createSnapshot(db, clock) {
  const tables = {}, lines = [];
  await db.snapshot(async s => {
    for (const table of BACKUP_TABLES) {
      const rows = await s.many(`SELECT * FROM ${table} ORDER BY 1`);
      const hash = crypto.createHash("sha256");
      for (const row of rows) { const line = JSON.stringify({ t: table, r: row }); hash.update(line + "\n"); lines.push(line); }
      tables[table] = { rows: rows.length, sha256: hash.digest("hex") };
    }
  });
  const manifest = { format: 1, created_at: clock.nowIso(), schema: latestMigrationVersion(), tables };
  lines.push(JSON.stringify({ manifest }));
  const buffer = zlib.gzipSync(Buffer.from(lines.join("\n") + "\n"), { level: 9 });
  return { buffer, manifest, sha256: sha(buffer), rowCounts: Object.fromEntries(Object.entries(tables).map(([k, x]) => [k, x.rows])) };
}

// After rows are inserted with explicit ids, PostgreSQL's id counters must continue after the highest id.
export async function resetSequences(t) {
  if (t.dialect !== "postgres") return;
  for (const table of SERIAL_TABLES) await t.query(`SELECT setval(pg_get_serial_sequence('${table}','id'), GREATEST(COALESCE(MAX(id),0),1), COALESCE(MAX(id),0) > 0) FROM ${table}`);
}

export function parseSnapshot(buffer, expectedSha256 = null) {
  if (expectedSha256 && sha(buffer) !== expectedSha256) throw new Error("Backup file checksum does not match: the file is corrupted or was modified");
  let text;
  try { text = zlib.gunzipSync(buffer, { maxOutputLength: 1024 * 1024 * 1024 }).toString("utf8"); } catch { throw new Error("Backup file is not a valid gzip archive"); }
  const lines = text.split("\n").filter(Boolean);
  let manifest;
  try { manifest = JSON.parse(lines.pop()).manifest; } catch { manifest = null; }
  if (!manifest || manifest.format !== 1 || !manifest.tables) throw new Error("Backup manifest is missing or unsupported");
  const rows = Object.fromEntries(BACKUP_TABLES.map(t => [t, []]));
  const hashes = Object.fromEntries(BACKUP_TABLES.map(t => [t, crypto.createHash("sha256")]));
  for (const line of lines) {
    const { t, r } = JSON.parse(line);
    if (!rows[t]) throw new Error(`Backup contains an unknown table "${t}"`);
    for (const key of Object.keys(r)) if (!COLUMN.test(key)) throw new Error(`Backup contains an invalid column name in ${t}`);
    rows[t].push(r); hashes[t].update(line + "\n");
  }
  for (const t of BACKUP_TABLES) {
    const m = manifest.tables[t];
    if (!m || m.rows !== rows[t].length || m.sha256 !== hashes[t].digest("hex")) throw new Error(`Backup integrity check failed for table ${t}`);
  }
  return { manifest, rows };
}

export async function restoreSnapshot(buffer, target, { expectedSha256 = null, wipe = false } = {}) {
  const { manifest, rows } = parseSnapshot(buffer, expectedSha256);
  await target.tx(async t => {
    if (wipe) for (const table of [...BACKUP_TABLES].reverse()) await t.exec(`DELETE FROM ${table}`);
    else for (const table of BACKUP_TABLES) if ((await t.one(`SELECT COUNT(*) AS n FROM ${table}`)).n > 0) throw new Error(`Target database is not empty (${table} has rows). Use an empty database or pass wipe.`);
    for (const table of BACKUP_TABLES) {
      const list = rows[table];
      if (!list.length) continue;
      const cols = Object.keys(list[0]);
      const sameShape = list.every(r => Object.keys(r).length === cols.length && cols.every(c => c in r));
      if (!sameShape) throw new Error(`Rows in ${table} do not share the same columns`);
      const chunk = Math.max(1, Math.min(500, Math.floor(30000 / cols.length)));
      for (let i = 0; i < list.length; i += chunk) {
        const params = [];
        const values = list.slice(i, i + chunk).map(r => `(${cols.map(c => { params.push(r[c]); return `$${params.length}`; }).join(",")})`);
        await t.exec(`INSERT INTO ${table}(${cols.join(",")}) VALUES ${values.join(",")}`, params);
      }
    }
    await resetSequences(t);
    for (const table of BACKUP_TABLES) {
      const n = (await t.one(`SELECT COUNT(*) AS n FROM ${table}`)).n;
      if (n !== manifest.tables[table].rows) throw new Error(`Row count mismatch after restore in ${table}: expected ${manifest.tables[table].rows}, found ${n}`);
    }
  });
  return { tables: Object.fromEntries(BACKUP_TABLES.map(t => [t, rows[t].length])), total: BACKUP_TABLES.reduce((s, t) => s + rows[t].length, 0), manifest };
}

// Restores into a disposable schema/database and throws away the result. Proves the backup can really be restored.
export async function verifySnapshot(db, buffer, expectedSha256 = null) {
  return db.withScratch(async scratch => {
    await applyMigrations(scratch);
    return restoreSnapshot(buffer, scratch, { expectedSha256 });
  });
}

export function createBackupService({ db, storage, config, clock }) {
  const bucket = config.supabase.backupBucket;
  const keep = { daily: config.backup.dailyKeep, weekly: config.backup.weeklyKeep, manual: 10 };
  const message = e => String(e?.message || e).slice(0, 500);

  async function run(kind, { periodKey = null } = {}) {
    const key = periodKey || (kind === "daily" ? `daily:${clock.today()}` : kind === "weekly" ? `weekly:${clock.startOfWeek()}` : `manual:${Date.now()}-${crypto.randomBytes(3).toString("hex")}`);
    let id;
    try { id = (await db.one("INSERT INTO backup_runs(period_key,kind,status,started_at) VALUES($1,$2,'running',$3) RETURNING id", [key, kind, clock.nowIso()])).id; }
    catch (error) { if (isUniqueViolation(error)) return { ok: false, skipped: true, error: "A backup for this period already exists" }; throw error; }
    try {
      if (!storage) throw new Error("File storage is not configured, so there is nowhere to put the backup");
      const snap = await createSnapshot(db, clock);
      const stamp = clock.nowIso().replace(/[-:]/g, "").replace(/\..*/, "");
      const path = `${kind}/${stamp}-${id}.ndjson.gz`;
      await storage.upload(bucket, path, snap.buffer, { contentType: "application/gzip" });
      await db.exec("UPDATE backup_runs SET status='ok',finished_at=$1,size_bytes=$2,storage_path=$3,sha256=$4,row_counts=$5 WHERE id=$6", [clock.nowIso(), snap.buffer.length, path, snap.sha256, JSON.stringify(snap.rowCounts), id]);
      await prune(kind);
      return { ok: true, id, kind, size_bytes: snap.buffer.length, storage_path: path, sha256: snap.sha256, row_counts: snap.rowCounts };
    } catch (error) {
      await db.exec("UPDATE backup_runs SET status='failed',finished_at=$1,error=$2 WHERE id=$3", [clock.nowIso(), message(error), id]);
      console.error("Backup failed:", message(error));
      return { ok: false, id, kind, error: message(error) };
    }
  }

  async function prune(kind) {
    const old = (await db.many("SELECT id,storage_path FROM backup_runs WHERE kind=$1 AND status='ok' ORDER BY id DESC", [kind])).slice(keep[kind]);
    for (const row of old) {
      try { if (storage && row.storage_path) await storage.remove(bucket, [row.storage_path]); await db.exec("DELETE FROM backup_runs WHERE id=$1", [row.id]); }
      catch (error) { console.error("Backup prune failed:", message(error)); }
    }
  }

  async function verify(id) {
    const row = await db.one("SELECT * FROM backup_runs WHERE id=$1", [id]);
    if (!row || row.status !== "ok" || !row.storage_path) return { ok: false, error: "Backup not found or not completed" };
    let result;
    try {
      const file = await storage.download(bucket, row.storage_path);
      const out = await verifySnapshot(db, file, row.sha256);
      result = { ok: true, id, total_rows: out.total, tables: out.tables };
      await db.exec("UPDATE backup_runs SET verified_at=$1,verify_status='ok',verify_detail=$2 WHERE id=$3", [clock.nowIso(), `${out.total} rows restored into a temporary schema and matched the manifest`, id]);
    } catch (error) {
      result = { ok: false, id, error: message(error) };
      await db.exec("UPDATE backup_runs SET verified_at=$1,verify_status='failed',verify_detail=$2 WHERE id=$3", [clock.nowIso(), message(error), id]);
    }
    return result;
  }

  // Called on start-up and every 30 minutes: makes sure today's daily and this week's weekly backup exist.
  async function tick() {
    const now = clock.now().getTime();
    const stale = new Date(now - 30 * 60_000).toISOString();
    await db.exec("UPDATE backup_runs SET status='failed',finished_at=$1,error='Interrupted (server restarted?)' WHERE status='running' AND started_at<$2", [clock.nowIso(), stale]);
    const due = async (kind, key) => {
      const row = await db.one("SELECT id,status,finished_at FROM backup_runs WHERE period_key=$1", [key]);
      if (!row) return true;
      if (row.status === "failed" && new Date(row.finished_at).getTime() < now - 60 * 60_000) { await db.exec("DELETE FROM backup_runs WHERE id=$1", [row.id]); return true; }
      return false;
    };
    const today = clock.today();
    const out = {};
    if (await due("daily", `daily:${today}`)) out.daily = await run("daily");
    if (clock.weekday(today) % 7 === config.backup.weeklyDay && await due("weekly", `weekly:${clock.startOfWeek()}`)) {
      out.weekly = await run("weekly");
      if (out.weekly.ok) out.verify = await verify(out.weekly.id); // the weekly restore drill
    }
    return out;
  }

  async function summary() {
    const runs = await db.many("SELECT id,kind,status,started_at,finished_at,size_bytes,sha256,row_counts,error,verified_at,verify_status,verify_detail FROM backup_runs ORDER BY id DESC LIMIT 30");
    const lastOk = kind => runs.find(r => r.kind === kind && r.status === "ok") || null;
    const lastVerified = runs.find(r => r.verify_status === "ok") || null;
    const newest = runs.find(r => r.status === "ok");
    const ageHours = newest ? (clock.now().getTime() - new Date(newest.finished_at).getTime()) / 3600_000 : null;
    return { enabled: config.backup.enabled && Boolean(storage), runs: runs.map(r => ({ ...r, row_counts: JSON.parse(r.row_counts || "{}") })), last_daily: lastOk("daily")?.finished_at ?? null, last_weekly: lastOk("weekly")?.finished_at ?? null, last_verified: lastVerified?.verified_at ?? null, stale: ageHours === null || ageHours > 36 };
  }

  let timer = null;
  return {
    run, verify, tick, summary, prune,
    start() {
      if (!config.backup.enabled || timer) return;
      const safeTick = () => tick().catch(e => console.error("Backup scheduler error:", message(e)));
      setTimeout(safeTick, 15_000).unref?.();
      timer = setInterval(safeTick, 30 * 60_000);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
