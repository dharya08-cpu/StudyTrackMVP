// Versioned, forward-only migrations. Every file runs once, inside a transaction, with a lock so two
// instances starting together cannot apply it twice. A changed file that was already applied is an error.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
export const migrationFiles = () => fs.readdirSync(dir).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
export const migrationSql = file => fs.readFileSync(path.join(dir, file), "utf8");
export const latestMigrationVersion = () => migrationFiles().at(-1)?.replace(/\.sql$/, "") || "none";

export async function applyMigrations(db, { log = () => {} } = {}) {
  await db.tx(async t => {
    if (t.dialect === "postgres") await t.query("SELECT pg_advisory_xact_lock(727274)");
    await t.script("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  });
  const applied = [];
  for (const file of migrationFiles()) {
    const version = file.replace(/\.sql$/, "");
    const sql = migrationSql(file);
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");
    await db.tx(async t => {
      if (t.dialect === "postgres") await t.query("SELECT pg_advisory_xact_lock(727274)");
      const row = await t.one("SELECT checksum FROM schema_migrations WHERE version=$1", [version]);
      if (row) {
        if (row.checksum !== checksum) throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead of editing an old one.`);
        return;
      }
      await t.script(sql);
      await t.exec("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [version, checksum]);
      applied.push(version);
      log(`Applied migration ${version}`);
    });
  }
  return applied;
}
