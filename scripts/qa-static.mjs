// Dependency-free source checks for the security and V4 requirements. Run with: npm run qa
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const walk = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (["node_modules", "shots", "dist"].includes(e.name)) continue; const f = path.join(dir, e.name); e.isDirectory() ? walk(f, out) : out.push(f); } return out; };
const read = f => fs.readFileSync(f, "utf8");
const serverFiles = walk(path.join(root, "server/src")).concat(path.join(root, "server/server.js"));
const clientFiles = walk(path.join(root, "client/src")).filter(f => /\.(jsx?|css)$/.test(f));
const server = serverFiles.map(read).join("\n"), client = clientFiles.map(read).join("\n");
const migration = read(path.join(root, "server/src/migrations/001_init.sql"));
const pkgs = read(path.join(root, "server/package.json")) + read(path.join(root, "client/package.json"));
const ignore = read(path.join(root, ".gitignore"));

const must = [
  ["PostgreSQL driver, no SQLite in production", /from "pg"/, server, true], ["student_class_memberships table", /CREATE TABLE student_class_memberships/, migration, true],
  ["unique student/class membership", /UNIQUE \(student_id, class_id\)/, migration, true], ["users.class_code is gone", /class_code/, migration, false],
  ["Google ID token signature check", /crypto\.verify\("RSA-SHA256"/, server, true], ["audience check", /claims\.aud !== clientId/, server, true], ["verified Gmail rule", /GMAIL_DOMAINS/, server, true], ["Workspace accounts rejected (hd)", /claims\.hd/, server, true],
  ["one-time nonce bound to the browser", /DELETE FROM login_nonces/, server, true], ["no password hashing library", /bcrypt|argon2|scrypt/i, pkgs, false], ["no JWT library", /jsonwebtoken/, pkgs, false], ["no password column", /password/i, migration, false],
  ["session secrets stored hashed", /secret_hash/, server, true], ["httpOnly session cookie", /httpOnly = true/, server, true], ["SameSite=Strict session cookie", /sameSite: "Strict"/, server, true], ["__Host- cookie prefix in production", /__Host-st_session/, server, true],
  ["CSRF token check", /BAD_CSRF/, server, true], ["origin guard", /BAD_ORIGIN/, server, true], ["CORS allow-list", /corsOrigins/, server, true], ["Content-Security-Policy", /Content-Security-Policy/, server, true], ["no unsafe-eval in CSP", /unsafe-eval/, server, false], ["HSTS", /Strict-Transport-Security/, server, true],
  ["rate limiter", /createLimiter/, server, true], ["login lock-out", /limiters\.login\.guard/, server, true], ["spam join protection", /TOO_MANY_PENDING/, server, true], ["join cool-down", /COOLDOWN/, server, true],
  ["request size limit", /limit: "100kb"/, server, true], ["multipart limits", /fileSize: config\.maxUploadBytes/, server, true], ["files never written to disk", /memoryStorage/, server, true],
  ["upload content sniffing", /function sniff/, server, true], ["PDF active-content scan", /JavaScript\|JS\|Launch/, server, true], ["DOCX macro check", /vbaproject/i, server, true], ["random storage keys", /crypto\.randomUUID/, server, true],
  ["bucket must be private", /is PUBLIC/, server, true], ["short-lived signed links", /signedUrl\(config\.supabase\.bucket, rec\.file_path, 300/, server, true], ["storage path never sent to browsers", /file_path/, client, false],
  ["no request data interpolated into SQL text", /`[^`$]*\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[^`]*\$\{\s*(req|body|b)\.[\w.]+\s*\}/, server, false], ["sessions: log out everywhere", /logout-all/, server, true], ["sessions: revoke others", /revoke-others/, server, true], ["re-verification for email change", /REAUTH_REQUIRED/, server, true],
  ["notification centre", /CREATE TABLE notifications/, migration, true], ["announcements to classes/institute", /CHECK \(scope IN \('class','classes','institute'\)\)/, migration, true], ["calendar", /CREATE TABLE calendar_events/, migration, true],
  ["student goals", /CREATE TABLE student_goals/, migration, true], ["study planner", /CREATE TABLE study_plan_slots/, migration, true], ["exam countdowns", /CREATE TABLE student_exams/, migration, true],
  ["backups", /CREATE TABLE backup_runs/, migration, true], ["restore test in a rolled-back transaction", /ROLLBACK/, server, true], ["homework create route (v3 bug)", /r\.post\("\/api\/teacher\/homework", \.\.\.guard, uploadMw/, server, true],
  ["homework create form in the UI", /Create homework/, client, true], ["no dangerouslySetInnerHTML", /dangerouslySetInnerHTML/, client, false], ["no eval", /\beval\s*\(|new Function\s*\(/, client + server, false], ["no tokens in web storage", /localStorage|sessionStorage/, client, false],
  ["external links are safe", /target="_blank"(?![^>]*noopener)/, client, false], ["no remote http:// URLs in client", /["'`]http:\/\/(?!localhost)/, client, false], ["db/zip files ignored by git", /\*\.db/, ignore, true], ["sw: robots disallow api", /Disallow: \/api\//, read(path.join(root, "client/public/robots.txt")), true],
];
let failed = 0;
for (const [name, re, text, shouldMatch] of must) {
  const found = re.test(text);
  if (found !== shouldMatch) { failed++; console.error(`FAIL  ${name}`); }
}
// the client must never contain secrets
for (const f of clientFiles) if (/SERVICE_ROLE|ADMIN_KEY\s*=|SESSION_SECRET/.test(read(f))) { failed++; console.error(`FAIL  secret name in client file ${f}`); }
console.log(failed ? `\n${failed} check(s) failed` : `All ${must.length} static checks passed`);
process.exit(failed ? 1 : 0);
