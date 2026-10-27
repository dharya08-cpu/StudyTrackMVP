// PostgreSQL access (Supabase Postgres or any Postgres 13+). Every query is parameterised ($1, $2 ...).
// The same small interface (query, one, many, exec, script, tx) is what the rest of the code uses.
import pg from "pg";

const { Pool, types } = pg;
// Predictable JavaScript types: counts and sums become numbers, dates stay "YYYY-MM-DD", timestamps become ISO strings.
types.setTypeParser(20, value => Number(value));
types.setTypeParser(1700, value => Number(value));
types.setTypeParser(1082, value => value);
types.setTypeParser(1184, value => new Date(value).toISOString());

function wrap(client, { release = null, inTx = false } = {}) {
  const api = {
    dialect: "postgres",
    async query(sql, params = []) {
      const result = await client.query(sql, params);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
    async many(sql, params = []) { return (await api.query(sql, params)).rows; },
    async one(sql, params = []) { return (await api.query(sql, params)).rows[0] ?? null; },
    async exec(sql, params = []) { return (await api.query(sql, params)).rowCount; },
    async script(sql) { await client.query(sql); },
    async tx(fn) { return fn(api); }, // already inside a transaction: join it
  };
  return api;
}

export function createDb(config) {
  const ssl = config.databaseSsl === "disable" ? false
    : config.databaseSsl === "verify" ? { rejectUnauthorized: true, ca: config.databaseCa || undefined }
    : { rejectUnauthorized: false };
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    query_timeout: 20_000,
    application_name: "studytrack",
    ssl,
    // Test-suite isolation only (a private schema per test app). Never set in production.
    ...(config.databaseSearchPath && /^[a-z0-9_]+$/.test(config.databaseSearchPath) ? { options: `-c search_path=${config.databaseSearchPath}` } : {}),
  });
  pool.on("error", error => console.error("Postgres pool error:", error.message));

  async function inTransaction(fn, begin = "BEGIN") {
    const client = await pool.connect();
    try {
      await client.query(begin);
      const out = await fn(wrap(client, { inTx: true }));
      await client.query("COMMIT");
      return out;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* connection already gone */ }
      throw error;
    } finally { client.release(); }
  }

  const base = wrap(pool);
  return {
    ...base,
    dialect: "postgres",
    async tx(fn) { return inTransaction(fn); },
    // One consistent, read-only view of the whole database (used by backups).
    async snapshot(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        return await fn(wrap(client));
      } finally {
        try { await client.query("ROLLBACK"); } catch { /* ignore */ }
        client.release();
      }
    },
    // Runs fn against a throw-away schema. The transaction is always rolled back, so nothing persists
    // and a failed restore test can never touch real data.
    async withScratch(fn) {
      const client = await pool.connect();
      const schema = `restore_test_${Date.now().toString(36)}`;
      try {
        await client.query("BEGIN");
        await client.query(`CREATE SCHEMA ${schema}`);
        await client.query(`SET LOCAL search_path TO ${schema}`);
        return await fn(wrap(client, { inTx: true }));
      } finally {
        try { await client.query("ROLLBACK"); } catch { /* ignore */ }
        client.release();
      }
    },
    async close() { await pool.end(); },
  };
}
