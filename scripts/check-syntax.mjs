// Syntax-checks every server file: npm run check
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "shots") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full); else if (/\.(js|mjs)$/.test(entry.name)) files.push(full);
  }
})("server");
let bad = 0;
for (const file of files) { const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" }); if (r.status !== 0) { bad++; console.error(`SYNTAX ERROR in ${file}\n${r.stderr}`); } }
console.log(bad ? `${bad} file(s) failed` : `${files.length} server files OK`);
process.exit(bad ? 1 : 0);
