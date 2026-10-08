// Guards PostgreSQL compatibility: the unit tests run on a SQLite stand-in, so this test rejects any SQL that only works there
// (or that PostgreSQL would refuse) before it can reach production.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const files = []; (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(path.join(d, f.name)) : f.name.endsWith(".js") && files.push(path.join(d, f.name)); })(src);
const SQL_START = /\b(SELECT\b[\s\S]*?\bFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i;
const strings = [];
for (const file of files) {
  const code = fs.readFileSync(file, "utf8");
  for (const m of code.matchAll(/`([^`]*)`|"((?:[^"\\\n]|\\.)*)"/g)) { const text = m[1] ?? m[2]; if (SQL_START.test(text)) strings.push({ file: path.basename(file), text }); }
}
const BANNED = [
  [/\bdatetime\s*\(/i, "SQLite datetime()"], [/\bstrftime\s*\(/i, "SQLite strftime()"], [/\bINSERT\s+OR\b/i, "INSERT OR ..."], [/\bAUTOINCREMENT\b/i, "AUTOINCREMENT"],
  [/COLLATE\s+NOCASE/i, "COLLATE NOCASE"], [/\bPRAGMA\b/i, "PRAGMA"], [/\bIFNULL\s*\(/i, "IFNULL()"], [/\bGROUP_CONCAT\b/i, "GROUP_CONCAT"], [/\browid\b/i, "rowid"],
  [/VALUES\s*\(\s*\?/i, "? placeholders"], [/[=<>]\s*\?\s*(\)|,|\s|$)/, "? placeholders"], [/\bROUND\s*\(/i, "ROUND() (fails on double precision in PostgreSQL)"],
  [/[^_.\w]date\s*\(/i, "date() function"], [/\b(banned|suspended|read_only|email_verified|teacher_banned)\s*=\s*[01]\b/i, "boolean compared with 0/1"],
  [/\bFOR\s+UPDATE\b/i, "FOR UPDATE (not on the SQLite stand-in)"], [/\bILIKE\b/i, "ILIKE"], [/::\w+/, "PostgreSQL :: cast (use CAST)"],
  [/\$\d+\s+IS\s+(NOT\s+)?NULL/i, "untyped parameter in IS NULL (PostgreSQL cannot infer its type)"], [/SELECT\s+\$\d+/i, "untyped SELECT $n"],
];
test("found SQL strings to lint", () => assert.ok(strings.length > 150, `only ${strings.length} SQL strings found`));
test("no SQLite-only or PostgreSQL-hostile SQL in the server source", () => {
  const problems = [];
  for (const { file, text } of strings) for (const [re, why] of BANNED) if (re.test(text)) problems.push(`${file}: ${why}: ${text.replace(/\s+/g, " ").slice(0, 110)}`);
  assert.deepEqual(problems, []);
});
test("every GROUP BY selects only grouped columns or aggregates (PostgreSQL is strict, SQLite is not)", () => {
  const problems = [];
  for (const { file, text } of strings) {
    const g = /GROUP BY\s+([\w.,\s]+?)(?:\s+ORDER|\s+HAVING|\s+LIMIT|$|`|")/i.exec(text.replace(/\s+/g, " "));
    if (!g) continue;
    const grouped = g[1].split(",").map(s => s.trim().split(".").pop());
    const select = /SELECT\s+([\s\S]*?)\s+FROM/i.exec(text.replace(/\s+/g, " "))[1];
    // split select list on top-level commas
    const items = []; let depth = 0, cur = "";
    for (const ch of select) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { items.push(cur); cur = ""; } else cur += ch; }
    items.push(cur);
    for (const item of items) {
      const expr = item.replace(/\s+AS\s+\w+\s*$/i, "").trim();
      if (/\b(COUNT|SUM|MAX|MIN|AVG)\s*\(/i.test(expr)) continue;
      const col = expr.split(".").pop();
      if (!grouped.includes(col)) problems.push(`${file}: "${expr}" is not in GROUP BY (${grouped.join(",")})`);
    }
  }
  assert.deepEqual(problems, []);
});
test("migration uses only portable PostgreSQL DDL", () => {
  const sql = fs.readFileSync(path.join(src, "migrations/001_init.sql"), "utf8");
  for (const bad of [/\bJSONB\b/, /\bARRAY\b/, /\bGENERATED\b/, /CREATE EXTENSION/i, /\bBIGSERIAL\b/, /ADD CONSTRAINT/i, /\bUUID\b/]) assert.ok(!bad.test(sql), String(bad));
  assert.ok(/CREATE TABLE student_class_memberships/.test(sql) && /UNIQUE \(student_id, class_id\)/.test(sql));
  assert.ok(!/class_code/.test(sql), "the old users.class_code is gone");
});
