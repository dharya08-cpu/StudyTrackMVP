# Security design

How each protection on your list is implemented, and which test proves it. Run `npm test` and `npm run qa`.

| Threat | Protection | Where | Test |
|---|---|---|---|
| **Brute-force login** | Per-IP lock-out after 10 failed sign-ins in 15 minutes (429 + Retry-After). Admin key: 5 tries then 15 minutes. | `ratelimit.js`, `context.js` | auth: "brute force" |
| **Credential stuffing** | Passwords are checked with scrypt (V6: N=2^15, r=8, p=2; older hashes are upgraded at the next log in; timing-equalised for unknown and Google-only accounts). Passwords need 10+ characters, a letter and a number, and must not be a common word with digits added. Lock-outs per network+account (8 wrong tries/15 min), per account across networks (20/hour) and per network (60 attempts/15 min). Google tokens are verified (RS256, issuer, audience, expiry), bound to a single-use nonce tied to the browser. | `passwords.js`, `routes/accounts.js`, `google.js` | accounts: "brute force", auth: "nonce binding" |
| **Account takeover by pre-registering a Gmail** | A password account must be verified through the e-mailed one-time link before it can log in; if Google later proves the address, any earlier password is deleted. Links are single-use, hashed in the database and expire (24 h / 1 h). | `routes/accounts.js`, `tokens.js` | accounts: "account takeover defences" |
| **Demo accounts mixing with real data** | Demo and real users can never join each other's classes or institute; demo passwords cannot be changed; demo logins only work while `ALLOW_DEMO=true`. | `joins.js`, `demo.js` | demo.test |
| **Account enumeration** | V6: the Log in page gives ONE answer ("Incorrect Gmail or password") for an unknown Gmail, a wrong password and a Google-only account, takes the same time, and counts towards the same lock-outs. Forgot-password and resend-verification give the same answer for any address. (Sign-up still says an address is taken, which it must, and is rate limited.) | `routes/accounts.js` | v6-security: "no account enumeration" |
| **SQL injection** | Every query is parameterised (`$1, $2`). The only dynamic SQL is placeholder lists and fixed identifiers. A static check fails the build if request data is put into SQL text. | all `src/` | `npm run qa`, sql-lint.test |
| **XSS** | React escapes all text; no `dangerouslySetInnerHTML`/`eval`. Strict CSP (no inline script, no `unsafe-eval`). Text input is stripped of control, zero-width and bidi characters. Session cookie is httpOnly, so scripts cannot steal it. Nothing sensitive is in web storage. | `validate.js`, `security.js`, client | unit tests, e2e (no CSP violations) |
| **CSRF** | Cookie is `SameSite=Strict`; every state-changing request needs an `Origin` from the allow-list **and** a per-session CSRF token. | `security.js`, `auth.js` | auth: "CSRF" |
| **Many files, many requests** | V6: up to 5 files per request and 10 per homework/test, 15 MB each and 40 MB per request (refused from the declared size before it is read). Every file is inspected before any is stored, so one bad file rejects the whole request and nothing is left behind. | `uploads.js`, `upload-middleware.js` | v6: "upload limits" |
| **Malicious file uploads** | Allow-list PDF/JPG/PNG/DOCX decided from the real bytes, never the file name, MIME type or declared size. PDFs with scripts/launch/embedded files, images with trailing or hidden code, DOCX with macros/OLE/executables/zip bombs are rejected. Random storage names, detected extension, memory-only parsing. | `files.js`, `uploads.js` | files.test, classes.test |
| **Oversized requests** | JSON 100 KB; files 15 MB each (configurable) and 40 MB per request; small multipart fields; request timeouts. | `app.js`, `upload-middleware.js`, `server.js` | files.test |
| **API abuse / scraping** | Per-IP (300/min) and per-user (400/min) limits, tighter limits on joining, uploads, announcements; pagination caps; `robots.txt` disallows `/api`; `X-Robots-Tag: noindex`. | `context.js` | classes: "rate limited" |
| **Spam joining requests** | One pending request per class, 10 open requests max, 20 per day, 24 h cool-down after a decline, teacher can block (confirmed). | `routes/student.js` | classes: "join-request rules" |
| **Unauthorized ID access / IDOR** | Every record is fetched through an ownership/membership check; foreign and non-existent ids give the same 404. Teachers see only their classes' students. Students see only their own classes. | `repo.js`, all routes | classes, comms, institute tests |
| **Privilege escalation** | Role middleware on every route; teacher-only, head-only and owner-only actions are separate checks; the owner admin has its own signed cookie, not usable with a user session. | `auth.js`, `routes/admin.js` | auth: "wrong-role", institute-admin |
| **Cross-institute file access** | Private buckets, random keys namespaced per institute, one link per **file** created per request after a membership check and valid 5 minutes. Removed students lose access immediately. The page only ever opens http(s) links. | `routes/files.js`, `attachments.jsx` | v6: "file access" |
| **Parent link guessing or leaking** | V6: a 256-bit random secret stored only as a hash, carried in the `#` part of the link (never in server logs or Referer), 90-day expiry, one live link per student, same answer for every failure, per-network rate limit, instant revoke. The page shows no e-mail, phone or private goals. | `routes/parent.js`, `parent.js` | v6-features: "parent view" |
| **Stolen account goes unnoticed** | V6: alert in the app (and by e-mail) when an account is used from a new kind of device. A tripwire for the common case, not a guarantee. | `login-alerts.js` | v6-features: "login alerts" |
| **Spreadsheet formula injection** | V6: class reports store names as plain text in Excel and prefix `=`, `+`, `-`, `@` in CSV; control characters that corrupt files are removed. | `xlsx.js` | v6-features: "export" |
| **Student files** | V6: student uploads use the same content inspection and size limits as teacher files; only the student and the class teacher can open them; they count toward the institute quota and are deleted with their owner. | `routes/student.js`, `routes/files.js` | v6-features: "submission files" |
| **Data rights** | V6: signed-in people can download all their data (never including password hashes) and delete their account (password or fresh Google check, plus typing DELETE). Teachers' block lists lose the deleted student's e-mail; the audit trail is cut loose from the account. | `routes/privacy.js` | v6-security: "download my data", "delete my account" |
| **Session theft / lost phone** | Opaque session tokens (only a hash is stored), 30-day / 14-day-idle limits, max 10 sessions, log out one/other/all devices, re-verification before changing Gmail. | `sessions.js`, `routes/auth.js` | auth: "active sessions", "session lifetime" |
| **Transport / browser hardening** | HSTS, CSP, `X-Frame-Options: DENY`, `nosniff`, referrer and permissions policies, COOP/CORP, `__Host-` cookies in production, `no-store` on the API. | `security.js` | auth: "security headers" |
| **CORS** | Allow-list from `CLIENT_ORIGIN`; no wildcard; credentials only for listed origins. | `security.js` | auth: "security headers" |
| **Secrets** | Production refuses to start with a weak `SESSION_SECRET`/`ADMIN_KEY` or a public storage bucket. Backups exclude sessions. Full IPs are never stored. | `config.js`, `server.js`, `backup.js` | unit: "config" |

## Operating it safely
* Keep `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET` and `ADMIN_KEY` only in Render's environment. Rotate `SESSION_SECRET` to sign everyone out.
* Review Admin panel > **Security** now and then: failed sign-ins, rejected uploads, session revocations.
* Keep dependencies current (`npm audit`, Dependabot).
* Do not commit `.env`, databases, zip files or backups (the `.gitignore` blocks them; V3 had committed `studytrack.db` and a zip, remove them from your repository history if the data was real).

## Shared networks (classrooms)
Limits counted per IP address are multiplied by `IP_LIMIT_FACTOR` (default 10) because a coaching centre shares one public IP. What protects accounts is unchanged and is **not** multiplied: wrong-password lock-outs per account, per-person request limits, upload and join limits per person, and the admin sign-in limit. If you ever see abuse from one network, lower the factor. Details and tests: [SCALE.md](SCALE.md).

## V6 hardening in one list
* No account discovery from the log-in form (same answer, same timing, same lock-outs).
* scrypt cost doubled and raised in parallelism; old hashes are rewritten transparently on the next successful log in.
* Password rule: 10 to 100 characters, letter + number, no common words with digits, not containing the e-mail name.
* CSP adds `worker-src 'none'`, `manifest-src 'self'`, `media-src 'none'`; Permissions-Policy turns off motion sensors and interest-cohort tracking.
* A wrong current password (or wrong password when deleting an account) no longer signs the user out of the page: only a real "not signed in" answer does.
* Self-service data download and account deletion, rate limited to 6 an hour per person.
* Backups include the new tables and still restore backups made by older versions.

## Not covered / your decisions
* Antivirus scanning of files (inspection is by structure and content; add ClamAV if you handle untrusted public uploads at scale).
* Multi-instance rate limiting (needs Redis).
* Privacy policy and consent for student data: required before real students use it (especially minors).
