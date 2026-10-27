// Proves a backup can be restored: npm run backup:verify [-- --id 12]   (default: newest successful backup)
// The backup is restored into a temporary schema inside a transaction that is always rolled back.
import { boot, args, fail } from "./_boot.mjs";
import { createBackupService } from "../src/backup.js";

try {
  const { db, config, clock, storage } = await boot({ needStorage: true });
  const row = args.id ? await db.one("SELECT id FROM backup_runs WHERE id=$1 AND status='ok'", [Number(args.id)]) : await db.one("SELECT id FROM backup_runs WHERE status='ok' ORDER BY id DESC LIMIT 1");
  if (!row) throw new Error("No successful backup found. Run: npm run backup");
  const result = await createBackupService({ db, storage, config, clock }).verify(row.id);
  console.log(result.ok ? `OK  backup #${row.id} restored into a temporary schema: ${result.total_rows} rows matched the manifest.` : `FAILED  backup #${row.id}: ${result.error}`);
  await db.close();
  process.exit(result.ok ? 0 : 1);
} catch (error) { fail(error); }
