// Shared start-up for the command-line tools: reads the same environment variables as the server.
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db.js";
import { createClock } from "../src/dates.js";

export const args = (() => {
  const out = { _: [] }, a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) { out._.push(a[i]); continue; }
    const key = a[i].slice(2);
    if (a[i + 1] && !a[i + 1].startsWith("--")) out[key] = a[++i]; else out[key] = true;
  }
  return out;
})();

export async function boot({ databaseUrl = null, needStorage = false } = {}) {
  const config = loadConfig(process.env);
  if (databaseUrl) config.databaseUrl = databaseUrl;
  if (!config.databaseUrl) throw new Error("DATABASE_URL is not set");
  const db = createDb(config);
  const clock = createClock(config.timezone);
  let storage = null;
  if (config.supabase.url && config.supabase.serviceKey) {
    const { createSupabaseStorage } = await import("../src/storage.js");
    storage = await createSupabaseStorage({ url: config.supabase.url, serviceKey: config.supabase.serviceKey });
  } else if (needStorage) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for this command");
  return { config, db, clock, storage };
}
export const fail = error => { console.error(`\nERROR: ${error.message}`); process.exit(1); };
