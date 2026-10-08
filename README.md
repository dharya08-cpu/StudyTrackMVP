# StudyTrack V4

A study-progress app for students, teachers and coaching institutes. React front end, Express API, **PostgreSQL (Supabase)** database, **Supabase Storage** for files, **Google-only sign-in**.

Everything in your V4 list is in this version. See [docs/V4-CHANGES.md](docs/V4-CHANGES.md) for where each item lives, [docs/SECURITY.md](docs/SECURITY.md) for the security design and [docs/RECOVERY.md](docs/RECOVERY.md) for backups and disaster recovery.

## What is new in V4

| | |
|---|---|
| Database | SQLite became **PostgreSQL** (Supabase). Versioned migrations run automatically on start. |
| Sign-in | **Google only, verified Gmail only.** No passwords exist anywhere. |
| Classes | A student can be in **many classes** (`student_class_memberships`). A teacher can create many classes. |
| Homework fix | Teachers can now **create homework** (text, due date, PDF/JPG/PNG/DOCX file) for one or several classes. |
| Planner | Weekly timetable, exam countdowns, "what to study today". |
| Goals | Daily and weekly study goals with progress bar, weekly ticks and streak. |
| Calendar | Classes, homework deadlines, tests, events and holidays in one calendar. |
| Announcements | To one class, several classes or the whole institute. |
| Notifications | Notification centre with an unread bell. |
| Sessions | **Security > Active sessions**, log out one device, all other devices, or everywhere. |
| Security | CSRF, CSP and security headers, CORS allow-list, rate limits, upload inspection, private files. |
| Backups | Daily + weekly backups, **automatic restore test**, recovery runbook. |

### About "forgot / reset / change password"
Your list asked for password reset features and also for Google-only login. With Google-only sign-in there is **no password to forget, reset or change**, so those features would be dead code and extra attack surface. The equivalents are built instead:
* **Reset / recovery** is Google's own account recovery.
* **Change email with re-verification**: Security > Account > *Change linked Gmail*. You confirm your current Google account, then prove ownership of the new Gmail with a fresh Google sign-in. All other devices are logged out.
* **Logout from all devices** and **session management**: Security > Active sessions.

## Repository layout

```
client/            React + Vite front end
  src/             screens: student.jsx, teacher*.jsx, calendar.jsx, planner.jsx, security.jsx, admin.jsx ...
server/
  server.js        entry point
  src/
    config.js      validated environment (production refuses weak settings)
    db.js          PostgreSQL pool (parameterised queries only)
    migrate.js + migrations/001_init.sql
    google.js      verifies Google ID tokens, verified-Gmail rule
    sessions.js    server-side sessions, device parsing, admin tokens
    security.js    headers, CSP, CORS, cookies, CSRF
    files.js       upload inspection by real content
    backup.js      snapshot, restore, restore-test, scheduler
    routes/        every API route, one file per area
  scripts/         migrate, backup, backup:verify, restore, import:sqlite
  test/            81 automated tests + end-to-end browser test
docs/              RECOVERY.md, SECURITY.md, V4-CHANGES.md
```

## Setup

### 1. Supabase (database and files)
1. Create a project at supabase.com.
2. **Database**: Project Settings > Database > *Connection string* > copy the **Transaction pooler** string (works on Render's IPv4 network). Put it in `DATABASE_URL`. Keep `DATABASE_SSL=require`.
3. **Storage**: create **two PRIVATE buckets**: `studytrack-files` and `studytrack-backups`. Leave "Public bucket" **off**. The server refuses to start in production if a bucket is public, so files can never be reached by guessing URLs.
4. Project Settings > API > copy the project URL into `SUPABASE_URL` and the **service_role** key into `SUPABASE_SERVICE_ROLE_KEY`. This key is a server secret. Never put it in the client.

### 2. Google sign-in
1. Google Cloud Console > APIs & Services > **OAuth consent screen**: choose *External*, fill the basic details, then **Publish app** (while it is in "Testing", only 100 listed test users can sign in).
2. Credentials > **Create credentials > OAuth client ID** > *Web application*.
3. **Authorized JavaScript origins**: your Render URL (for example `https://studytrack.onrender.com`) and `http://localhost:5000` for local work. No redirect URI is needed.
4. Copy the **Client ID** into `GOOGLE_CLIENT_ID`.

### 3. Render (one web service)
* Build command: `npm run build`   Start command: `npm start`   Health check path: `/api/health`
* Environment variables (also listed in `server/.env.example` and `render.yaml`):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Supabase pooler connection string |
| `SESSION_SECRET` | 32+ random characters (`openssl rand -hex 32`) |
| `ADMIN_KEY` | 12+ characters; your owner key for `/admin` |
| `GOOGLE_CLIENT_ID` | from step 2 |
| `APP_URL` | your public https URL |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | from step 1 |
| `TRUST_PROXY` | `1` |
| `BACKUP_ENABLED` | `true` |

The old `JWT_SECRET` and `DB_PATH` variables are no longer used. Delete them.

### 4. Bring your V3 data over (optional, one time)
Download the SQLite file from your running V3 service (or use a copy), then, from a machine with Node 22+ (or `npm i --no-save better-sqlite3`) and `DATABASE_URL` set:
```
npm --prefix server install
npm run import:sqlite --prefix server -- --sqlite ./studytrack.db --confirm
```
Students who were in a class are turned into real memberships. Passwords are **not** copied. Each person signs in with Google once and is matched to their old account by e-mail (only Gmail addresses can sign in; the import prints a note for any other address).

### 5. Local development
```
cp server/.env.example server/.env       # fill in values (a Supabase DB is fine for development)
npm run install:all
npm --prefix server run dev              # API on :3001
npm --prefix client run dev              # app on :5000 (proxies /api to :3001)
```

## Everyday commands

| Command | What it does |
|---|---|
| `npm test` | 81 server tests (security, multi-class, uploads, planner, backups, import ...) |
| `npm run e2e` | Real-browser end-to-end test, 19 steps (needs Playwright + Chromium) |
| `npm run qa` | Static checks of the security invariants |
| `npm run check` | Syntax check of every server file |
| `npm run migrate` | Apply database migrations manually (the server also does this on start) |
| `npm run backup` / `backup:verify` | Take a backup now / prove the newest backup restores |

### About the tests
The suite runs against an in-memory SQLite stand-in so it needs no database setup (Node 22+ has SQLite built in; on Node 20 `npm install` adds the `better-sqlite3` dev dependency). Because production uses PostgreSQL, a lint test (`sql-lint.test.mjs`) rejects any SQL that only works on SQLite or that PostgreSQL would refuse. **To run the whole suite against real PostgreSQL**, point it at a throw-away database:
```
TEST_DATABASE_URL=postgresql://user:pass@host:5432/scratchdb npm test
```
Each test gets its own schema (`t_xxxx`). Do this once after your first deploy.

## Known limits (honest list)
* Rate-limit counters live in server memory: right for one instance (Render free/starter). With several instances, move them to Redis.
* The city in *Active sessions* appears only if your host adds a geo header (for example Cloudflare). Otherwise a masked address is shown. Full IPs are never stored.
* Backups are logical (JSON) snapshots held in memory while being built: fine up to a few hundred MB. For larger databases use Supabase's own point-in-time recovery as well.
* Files are not virus-scanned by an antivirus engine. They are inspected by real content (type, structure, macros, scripts, embedded files) and stored in a private bucket, which blocks the common attacks.
