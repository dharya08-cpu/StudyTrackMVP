// Restores a backup: npm run restore -- --id 12 --confirm   |   npm run restore -- --file ./backup.ndjson.gz --confirm
// Options: --target-url postgres://...  (restore into a different database, e.g. a fresh Supabase project)
//          --wipe                        (replace existing data; otherwise the target must be empty)
import fs from "node:fs";
import { boot, args, fail } from "./_boot.mjs";
import { applyMigrations } from "../src/migrate.js";
import { restoreSnapshot } from "../src/backup.js";

try {
  if (!args.confirm) throw new Error("Restoring changes the target database. Re-run with --confirm after checking DATABASE_URL / --target-url.");
  const source = await boot({ needStorage: !args.file });          // holds backup_runs and the storage credentials
  const db = typeof args["target-url"] === "string" ? (await boot({ databaseUrl: args["target-url"] })).db : source.db;
  let buffer, expected = null;
  if (args.file) buffer = fs.readFileSync(args.file);
  else {
    const meta = await source.db.one("SELECT storage_path,sha256 FROM backup_runs WHERE id=$1 AND status='ok'", [Number(args.id)]);
    if (!meta) throw new Error("Backup id not found in backup_runs of DATABASE_URL (use --file with a downloaded backup instead)");
    buffer = await source.storage.download(source.config.supabase.backupBucket, meta.storage_path); expected = meta.sha256;
  }
  await applyMigrations(db, { log: console.log });
  const out = await restoreSnapshot(buffer, db, { expectedSha256: expected, wipe: Boolean(args.wipe) });
  console.log(`Restored ${out.total} rows (backup created ${out.manifest.created_at}).`);
  console.table(out.tables);
  if (db !== source.db) await db.close();
  await source.db.close();
} catch (error) { fail(error); }
