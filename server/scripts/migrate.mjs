// Applies database migrations: npm run migrate
import { boot, fail } from "./_boot.mjs";
import { applyMigrations } from "../src/migrate.js";

try {
  const { db } = await boot();
  const applied = await applyMigrations(db, { log: console.log });
  console.log(applied.length ? `Applied ${applied.length} migration(s).` : "Database is already up to date.");
  await db.close();
} catch (error) { fail(error); }
