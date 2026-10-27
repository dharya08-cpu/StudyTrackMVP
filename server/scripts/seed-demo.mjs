// Creates (or resets) the demo accounts: npm run seed:demo      Needs ALLOW_DEMO=true in the environment.
import { boot, fail } from "./_boot.mjs";
import { applyMigrations } from "../src/migrate.js";
import { seedDemo } from "../src/demo.js";

try {
  const { db, config, clock, storage } = await boot();
  await applyMigrations(db, { log: console.log });
  const r = await seedDemo({ db, config, clock, storage });
  console.log(`Demo ready: ${r.users} accounts, ${r.classes} classes, ${r.study_logs} study logs, ${r.worksheets} worksheets.\n`);
  console.table(r.accounts.map(a => ({ email: a.email, password: a.password, role: a.role, name: a.name })));
  console.log(`Class codes: ${r.classes_list?.join(", ") || "DEMO01 to DEMO06"}   Institute code: ${r.institute}`);
  await db.close();
} catch (error) { fail(error); }
