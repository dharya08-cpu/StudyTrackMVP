// Copies a V3 SQLite database into PostgreSQL: npm run import:sqlite -- --sqlite ./studytrack.db --confirm [--wipe]
import { boot, args, fail } from "./_boot.mjs";
import { applyMigrations } from "../src/migrate.js";
import { importSqlite } from "../src/import-sqlite.js";

try {
  if (typeof args.sqlite !== "string") throw new Error("Usage: npm run import:sqlite -- --sqlite ./studytrack.db --confirm");
  if (!args.confirm) throw new Error("This writes into DATABASE_URL. Re-run with --confirm.");
  const { db } = await boot();
  await applyMigrations(db, { log: console.log });
  const report = await importSqlite({ sqlitePath: args.sqlite, target: db, wipe: Boolean(args.wipe) });
  console.log("Copied rows:"); console.table(report.copied);
  if (report.notes.length) console.log(`\nNotes (${report.notes.length}):\n - ${report.notes.slice(0, 30).join("\n - ")}`);
  if (report.skipped.length) console.log(`\nSkipped (${report.skipped.length}):\n - ${report.skipped.slice(0, 30).join("\n - ")}`);
  console.log("\nDone. Every student who was in a class is now a member of it in student_class_memberships.");
  await db.close();
} catch (error) { fail(error); }
