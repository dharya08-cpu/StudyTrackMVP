// Dependency-free source checks for the security and V4 requirements. Run with: npm run qa
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const walk = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (["node_modules", "shots", "dist"].includes(e.name)) continue; const f = path.join(dir, e.name); e.isDirectory() ? walk(f, out) : out.push(f); } return out; };
const read = f => fs.readFileSync(f, "utf8");
const serverFiles = walk(path.join(root, "server/src")).concat(path.join(root, "server/server.js"));
const clientFiles = walk(path.join(root, "client/src")).filter(f => /\.(jsx?|css)$/.test(f));
const server = serverFiles.map(read).join("\n"), client = clientFiles.map(read).join("\n");
const migration = fs.readdirSync(path.join(root, "server/src/migrations")).filter(f => f.endsWith(".sql")).map(f => read(path.join(root, "server/src/migrations", f))).join("\n");
const passwordLogin = read(path.join(root, "server/src/routes/accounts.js"));
const pkgs = read(path.join(root, "server/package.json")) + read(path.join(root, "client/package.json"));
const ignore = read(path.join(root, ".gitignore"));

const must = [
  ["PostgreSQL driver, no SQLite in production", /from "pg"/, server, true], ["student_class_memberships table", /CREATE TABLE student_class_memberships/, migration, true],
  ["unique student/class membership", /UNIQUE \(student_id, class_id\)/, migration, true], ["users.class_code is gone", /class_code/, migration, false],
  ["Google ID token signature check", /crypto\.verify\("RSA-SHA256"/, server, true], ["audience check", /claims\.aud !== clientId/, server, true], ["verified Gmail rule", /GMAIL_DOMAINS/, server, true], ["Workspace accounts rejected (hd)", /claims\.hd/, server, true],
  ["one-time nonce bound to the browser", /DELETE FROM login_nonces/, server, true], ["no password hashing library", /bcrypt|argon2|scrypt/i, pkgs, false], ["no JWT library", /jsonwebtoken/, pkgs, false], ["no plain-text password column (only password_hash)", /\bpassword\s+(TEXT|VARCHAR)/i, migration, false], ["passwords hashed with scrypt", /crypto\.scrypt/, server, true],
  ["passwords hashed with scrypt", /crypto\.scrypt/, server, true], ["e-mail links stored hashed and single-use", /used_at IS NULL/, server, true], ["login lock-outs", /pwFailEmail/, server, true], ["demo accounts isolated", /teacher_is_demo/, server, true], ["verified before log in", /EMAIL_NOT_VERIFIED/, server, true], ["details page", /CREATE TABLE email_tokens/, read(path.join(root, "server/src/migrations/002_accounts.sql")), true], ["no plain password column", /\bpassword\s+TEXT/i, read(path.join(root, "server/src/migrations/002_accounts.sql")), false],
  ["session secrets stored hashed", /secret_hash/, server, true], ["httpOnly session cookie", /httpOnly = true/, server, true], ["SameSite=Strict session cookie", /sameSite: "Strict"/, server, true], ["__Host- cookie prefix in production", /__Host-st_session/, server, true],
  ["CSRF token check", /BAD_CSRF/, server, true], ["origin guard", /BAD_ORIGIN/, server, true], ["CORS allow-list", /corsOrigins/, server, true], ["Content-Security-Policy", /Content-Security-Policy/, server, true], ["no unsafe-eval in CSP", /unsafe-eval/, server, false], ["HSTS", /Strict-Transport-Security/, server, true],
  ["rate limiter", /createLimiter/, server, true], ["login lock-out", /limiters\.login\.guard/, server, true], ["spam join protection", /TOO_MANY_PENDING/, server, true], ["join cool-down", /COOLDOWN/, server, true],
  ["request size limit", /limit: "100kb"/, server, true], ["multipart limits", /fileSize: config\.maxUploadBytes/, server, true], ["files never written to disk", /memoryStorage/, server, true],
  ["upload content sniffing", /function sniff/, server, true], ["PDF active-content scan", /JavaScript\|JS\|Launch/, server, true], ["DOCX macro check", /vbaproject/i, server, true], ["random storage keys", /crypto\.randomUUID/, server, true],
  ["bucket must be private", /is PUBLIC/, server, true], ["short-lived signed links", /signedUrl\(config\.supabase\.bucket, a\.file_path, 300/, server, true], ["storage path never sent to browsers", /file_path/, client, false],
  ["no request data interpolated into SQL text", /`[^`$]*\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[^`]*\$\{\s*(req|body|b)\.[\w.]+\s*\}/, server, false], ["sessions: log out everywhere", /logout-all/, server, true], ["sessions: revoke others", /revoke-others/, server, true], ["re-verification for email change", /REAUTH_REQUIRED/, server, true],
  ["notification centre", /CREATE TABLE notifications/, migration, true], ["announcements to classes/institute", /CHECK \(scope IN \('class','classes','institute'\)\)/, migration, true], ["calendar", /CREATE TABLE calendar_events/, migration, true],
  ["student goals", /CREATE TABLE student_goals/, migration, true], ["study planner", /CREATE TABLE study_plan_slots/, migration, true], ["exam countdowns", /CREATE TABLE student_exams/, migration, true],
  ["backups", /CREATE TABLE backup_runs/, migration, true], ["restore test in a rolled-back transaction", /ROLLBACK/, server, true], ["homework create route (v3 bug)", /r\.post\("\/api\/teacher\/homework", \.\.\.guard, uploadMany/, server, true],
  ["V6: one row per attached file", /CREATE TABLE attachments/, migration, true], ["V6: student's own calendar table", /CREATE TABLE student_plan_items/, migration, true],
  ["V6: attaching adds, never replaces", /UPDATE (homework|tests) SET file_path/, server, false], ["V6: generic login error", /INVALID_CREDENTIALS/, server, true], ["V6: password login never reveals whether an account exists", /No StudyTrack account|WRONG_PASSWORD[\s\S]{0,40}Incorrect password\./, passwordLogin, false],
  ["V6.1: parent link stores only a hash", /token_hash TEXT NOT NULL UNIQUE/, migration, true], ["V6.1: parent link has no plain token column", /CREATE TABLE parent_links[^;]*\n\s*token TEXT/, migration, false],
  ["V6.1: parent secret is read from the URL fragment", /location\.hash/, client, true], ["V6.1: sign-in alerts are hooked into sign-in", /noteSignIn\(ctx, req, user\)/, server, true],
  ["V6.1: spreadsheet formula-injection guard", /formula-injection guard/, server, true], ["V6.1: student files use the same inspection", /assertStorageQuota\(ctx, owner, info\.size\)/, server, true],
  ["V6.2: file limits are exact under simultaneous uploads", /isBeyondLimit\(db, "submission_files"/, server, true], ["V6.2: uploads share a memory budget", /createUploadGate\(/, server, true],
  ["V6.2: a busy hashing queue is never reported as a wrong password", /instanceof HttpError\) throw error; return false/, server, true], ["V6.2: per-IP limits scale for classrooms", /ipLimitFactor/, server, true],
  ["V6: self-service data export and deletion", /\/api\/account\/export/, server, true], ["V6: file links only open http(s)", /protocol === "https:"/, client, true],
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
