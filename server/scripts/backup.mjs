// Takes a backup now: npm run backup [-- --kind daily|weekly|manual]
import { boot, args, fail } from "./_boot.mjs";
import { createBackupService } from "../src/backup.js";

try {
  const { db, config, clock, storage } = await boot({ needStorage: true });
  const kind = ["daily", "weekly", "manual"].includes(args.kind) ? args.kind : "manual";
  const result = await createBackupService({ db, storage, config, clock }).run(kind);
  console.log(JSON.stringify(result, null, 2));
  await db.close();
  process.exit(result.ok || result.skipped ? 0 : 1);
} catch (error) { fail(error); }
