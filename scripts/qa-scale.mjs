// Static checks for the things that only go wrong when many people use the app at once and that a small test cannot show.
// Run with: npm run qa:scale
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".js") ? [path.join(d, e.name)] : []));
const files = [...walk(path.join(root, "server/src")), path.join(root, "server/server.js")];
let failed = 0;
const fail = msg => { failed++; console.error("FAIL ", msg); };

// A transaction holds one database connection. If its body uses the OUTER handle, it needs a second connection, and a
// crowd of simultaneous transactions then starves the pool and everything freezes (Postgres only; SQLite cannot show it).
// Slow network or CPU work inside a transaction holds that connection for no reason.
let tx = 0;
for (const f of files) {
  const s = fs.readFileSync(f, "utf8");
  for (const m of s.matchAll(/\b(\w+)\.tx\(\s*async\s*\(?(\w+)\)?\s*=>\s*\{/g)) {
    let i = m.index + m[0].length, depth = 1; while (depth && i < s.length) { depth += (s[i] === "{") - (s[i] === "}"); i++; }
    const body = s.slice(m.index + m[0].length, i), line = s.slice(0, m.index).split("\n").length, where = `${path.relative(root, f)}:${line}`; tx++;
    if (m[1] !== m[2] && new RegExp(`\\b${m[1]}\\b(?!\\.tx)`).test(body)) fail(`${where}: a transaction uses the outer connection '${m[1]}' (use '${m[2]}')`);
    if (!/demo\.js$/.test(f) && /putFile|removeFiles|storage\.|mailer\.|signedUrl|hashPassword|verifyPassword|scrypt|fetch\(/.test(body)) fail(`${where}: slow network/CPU work inside a transaction`);
  }
}
console.log(`${tx} transactions checked`);

// Module-level mutable state is shared by every user of the process: only the known, intended ones are allowed.
const ALLOWED = { "passwords.js": ["dummy", "running", "waiting"] }; // the timing-equalising hash, and the hashing queue
for (const f of files) {
  const s = fs.readFileSync(f, "utf8"), base = path.basename(f);
  for (const m of s.matchAll(/^(?:let|var)\s+(\w+)|^const\s+(\w+)\s*=\s*(?:new (?:Map|Set)\(|\[\]|\{\})/gm)) {
    const name = m[1] ?? m[2];
    if (/^[A-Z0-9_]+$/.test(name)) continue;                    // constants
    if (!(ALLOWED[base] || []).includes(name)) fail(`${path.relative(root, f)}: module-level shared state '${name}' (one user's request could affect another's)`);
  }
}

// Limits counted per IP address must scale with the classroom factor, or a coaching centre behind one router is locked out.
const ctx = fs.readFileSync(path.join(root, "server/src/context.js"), "utf8");
for (const name of ["api", "nonce", "login", "joinIp", "register", "mailIp", "pwIp"]) if (!new RegExp(`${name}: createLimiter\\(\\{ now, max: limits\\.${name} \\?\\? \\d+ \\* ipf`).test(ctx)) fail(`limiter '${name}' does not scale with IP_LIMIT_FACTOR`);
for (const name of ["pwFail", "pwFailEmail", "changePw", "adminLogin"]) if (new RegExp(`${name}: createLimiter\\(\\{[^}]*\\* ipf`).test(ctx)) fail(`per-account protection '${name}' must never be multiplied`);

if (failed) { console.error(`\n${failed} scale check(s) failed`); process.exit(1); }
console.log("All scale checks passed");
