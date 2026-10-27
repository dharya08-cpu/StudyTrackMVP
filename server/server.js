// StudyTrack V4 server entry point.
import { loadConfig } from "./src/config.js";
import { createDb } from "./src/db.js";
import { applyMigrations } from "./src/migrate.js";
import { createClock } from "./src/dates.js";
import { createGoogleVerifier } from "./src/google.js";
import { createContext } from "./src/context.js";
import { createBackupService } from "./src/backup.js";
import { createExpressApp } from "./src/app.js";
import { makeUploadMw } from "./src/upload-middleware.js";
import { purgeExpired } from "./src/sessions.js";
import { seedDemo } from "./src/demo.js";

process.on("unhandledRejection", reason => console.error("Unhandled rejection:", reason));

async function main() {
  const config = loadConfig();
  const clock = createClock(config.timeZone || config.timezone);
  const db = createDb(config);
  await db.one("SELECT 1 AS ok"); // fail fast if the database is unreachable
  await applyMigrations(db, { log: console.log });

  let storage = null;
  if (config.supabase.url && config.supabase.serviceKey) {
    const { createSupabaseStorage } = await import("./src/storage.js");
    storage = await createSupabaseStorage({ url: config.supabase.url, serviceKey: config.supabase.serviceKey });
    for (const bucket of [config.supabase.bucket, config.supabase.backupBucket]) {
      const isPublic = await storage.isPublic(bucket);
      if (isPublic === true) throw new Error(`Supabase bucket "${bucket}" is PUBLIC. Make it private in the Supabase dashboard (Storage -> bucket -> Edit) so files cannot be reached by guessing URLs.`);
      if (isPublic === null) console.warn(`Could not confirm that bucket "${bucket}" exists and is private. Create it as a private bucket.`);
    }
  } else console.warn("Supabase is not configured: file uploads and backups are disabled.");

  const google = createGoogleVerifier({ clientId: config.googleClientId, clock });
  const uploadMw = await makeUploadMw(config);
  const ctx = createContext({ db, config, clock, storage, google, uploadMw });
  ctx.backups = createBackupService({ db, storage, config, clock });
  const app = await createExpressApp(ctx);

  const server = app.listen(config.port, () => console.log(`StudyTrack V4 listening on ${config.port} (${config.nodeEnv})`));
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 65_000;
  ctx.backups.start();
  if (config.allowDemo && !(await db.one("SELECT 1 AS x FROM users WHERE is_demo=TRUE"))) seedDemo(ctx).then(r => console.log(`Demo accounts created (${r.users} accounts, ${r.classes} classes).`)).catch(e => console.error("Demo seeding failed:", e.message));
  else if (config.allowDemo) console.log("Demo accounts are enabled.");
  const maintenance = setInterval(() => purgeExpired(db, clock).catch(e => console.error("Maintenance failed:", e.message)), 60 * 60_000);
  maintenance.unref();
  purgeExpired(db, clock).catch(() => {});

  const shutdown = async signal => {
    console.log(`${signal} received, shutting down`);
    ctx.backups.stop();
    clearInterval(maintenance);
    server.close(async () => { await db.close().catch(() => {}); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
main().catch(error => { console.error("Fatal start-up error:", error.message); process.exit(1); });
