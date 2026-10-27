// TEST-ONLY database: runs the same SQL on SQLite (node:sqlite or better-sqlite3) so the suite needs no server.
// It translates only the handful of PostgreSQL spellings used by the schema ($n, SERIAL, TIMESTAMPTZ, now() ...).
// To run the same suite against real PostgreSQL instead: TEST_DATABASE_URL=postgres://... npm test (see createTestDb in helpers.mjs).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

async function openSqlite() {
  try { const { DatabaseSync } = await import("node:sqlite"); return { kind: "node", open: () => new DatabaseSync(":memory:") }; }
  catch { const Database = require("better-sqlite3"); return { kind: "better", open: () => new Database(":memory:") }; }
}
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
export const translateDdl = sql => sql
  .replace(/SERIAL PRIMARY KEY/g, "INTEGER PRIMARY KEY AUTOINCREMENT")
  .replace(/\bTIMESTAMPTZ\b/g, "TEXT").replace(/\bDATE\b/g, "TEXT").replace(/\bBOOLEAN\b/g, "INTEGER").replace(/DOUBLE PRECISION/g, "REAL")
  .replace(/DEFAULT now\(\)/g, `DEFAULT (${NOW})`);
const translateQuery = sql => sql.replace(/\$(\d+)/g, "?$1").replace(/\bnow\(\)/g, NOW);
const bind = params => params.map(p => (p === true ? 1 : p === false ? 0 : p === undefined ? null : p));

function wrap(raw, kind, state) {
  const api = {
    dialect: "sqlite",
    async query(sql, params = []) {
      const text = translateQuery(sql);
      const stmt = raw.prepare(text);
      const args = bind(params);
      try {
        if (/^\s*(select|with)\b/i.test(text) || /\breturning\b/i.test(text)) { const rows = stmt.all(...args).map(r => ({ ...r })); return { rows, rowCount: rows.length }; }
        const info = stmt.run(...args);
        return { rows: [], rowCount: Number(info.changes) };
      } catch (error) {
        if (/UNIQUE constraint failed/.test(error.message)) error.code = "23505";
        throw error;
      }
    },
    async many(sql, params) { return (await api.query(sql, params)).rows; },
    async one(sql, params) { return (await api.query(sql, params)).rows[0] ?? null; },
    async exec(sql, params) { return (await api.query(sql, params)).rowCount; },
    async script(sql) { raw.exec(translateDdl(sql)); },
    async tx(fn) {
      if (state.inTx) return fn(api);
      raw.exec("BEGIN"); state.inTx = true;
      try { const out = await fn(api); raw.exec("COMMIT"); return out; }
      catch (error) { try { raw.exec("ROLLBACK"); } catch { /* none */ } throw error; }
      finally { state.inTx = false; }
    },
    async snapshot(fn) { return fn(api); },
    async withScratch(fn) { return fn(await createSqliteDb({ scratch: true })); },
    async close() { raw.close?.(); },
  };
  return api;
}
export async function createSqliteDb() {
  const { open, kind } = await openSqlite();
  const raw = open();
  raw.exec("PRAGMA foreign_keys=ON");
  return wrap(raw, kind, { inTx: false });
}
