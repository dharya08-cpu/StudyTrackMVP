# StudyTrack V3

StudyTrack is a student/teacher study management app: study logging, homework, tests/results, attendance, syllabus coverage, analytics and responsive dashboards.

V3 adds class-code joining with teacher approval, a teacher menu, teacher self sign-up, **Coaching Institutes**, and an **owner admin panel** that lets you control who can use the app.

## What's new in V3

| Area | What changed |
| --- | --- |
| Teacher menu | A **Menu** button (top-left, with a red badge when requests are waiting) opens a slide-in menu: My classroom, **Students**, Add a class, Coaching institute, Logout. |
| Student login | After the first login the student is asked for a **class code**, then sees: *"Your request has been sent to X's class. You will be permitted to class once they allow you to enter. Please wait."* The page updates by itself. |
| Joining requests | Menu → **Students** → **Student Joining Request** (top of the list) shows every request as *"Student A wants to join your Class 2 batch"* with a green **✓ Allow** and a red **✕ Deny**. Allow adds the student immediately. Deny offers **Deny & Remove** and **Deny & Block** (blocking asks "Are you sure?" first). A blocked email can never send a request to any of that teacher's classes; the teacher can unblock later. Students who are removed or blocked see that the teacher didn't allow them to join. |
| Class rooms | Under **Students** every class is listed (Class 1, Class 2, ...). Opening one shows that class's students, analytics, performance, homework, tests, attendance and syllabus. Teachers can also remove a student from a class. |
| Teacher sign-up | The Termux step is gone. The teacher login page has **New teacher? Create your account now** (name, email, password, class name, class code). The class code is stored in the database and shows up in your admin panel. No approval needed. |
| Coaching institutes | **+ Create Your Own Coaching Institute** (with an ⓘ explanation) is in the teacher menu and on the teacher login page. Step 1: email and password. Step 2: institute name, coaching code, phone, city, size, description. It then waits for **your** approval. |
| Join an institute | **Have an institute code? Join here** on the teacher login page. The code is verified first; then the teacher lands on the institute homepage. |
| Institute homepage | The institute name with stars and emoji, then every teacher with their classes, student counts, test average, attendance, homework count and a feedback note. Heads and co-heads can add feedback, make other teachers **co-heads**, and remove teachers. |
| Owner admin panel | Open `/admin`, enter `ADMIN_KEY`. Approve or reject institutes, see every coaching code and class code, suspend / ban / delete, set limits, switch read-only, and make an institute independent after payment. |

## Running locally

Requirements: Node.js 20.

```bash
npm run build          # installs server + client dependencies and builds the client
npm start              # serves the API and the built client on PORT (default 3001)
```

For development, run the API and Vite separately:

```bash
cd server && npm install && npm start
cd client && npm install && npm run dev      # http://localhost:5000, proxies /api to :3001
```

Copy `server/.env.example` to `server/.env` for local settings. The owner admin panel needs `ADMIN_KEY`.

## Environment variables

Production requires:

- `NODE_ENV=production`
- `JWT_SECRET` – long random secret for login tokens
- `ADMIN_KEY` – **12+ characters**. This is the password for `/admin`. Keep it private.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET` – file storage for homework/test attachments
- `DB_PATH` – path on persistent storage (see "Database safety")
- `STUDYTRACK_TIMEZONE=Asia/Kolkata` unless your users are elsewhere

Optional:

- `CLIENT_ORIGIN` – only when frontend and API are on different origins
- `TRUST_PROXY` – number of proxies in front of Node. Defaults to `1` in production (correct for Render) so rate limits see each visitor's real IP. Use `0` if Node faces the internet directly.
- `TEACHER_SIGNUP_LIMIT` – teacher sign-ups / institute requests per IP per hour (default 20)
- `INITIAL_TEACHER_*`, `INITIAL_CLASS_*`, `INITIAL_STUDENT_PASSWORD` – seed a demo teacher on a brand-new production database. **Not required any more**: a fresh database can start empty because teachers sign up themselves.

`ADMIN_KEY` used to guard the old Termux "create teacher" command. That endpoint no longer exists; the key now opens the admin panel instead.

## Owner admin panel (`/admin`)

Sign in with `ADMIN_KEY`. The session lasts 12 hours and is a different kind of token from normal logins, so no teacher or student can use it. After 8 wrong keys from one address the login is locked for 15 minutes.

**Approval queue.** A new institute is *pending*. Its coaching code does not work and the head sees "Waiting for approval" until you press **Approve**. **Reject** (with an optional reason) lets the head fix details and submit again.

**Controls per institute**

- **Suspend / Reactivate** – everyone in the institute (teachers and students) is locked out immediately, including people already logged in. Data is kept.
- **Ban / Unban** – same lock-out, recorded as a ban.
- **Limits** – maximum teachers, maximum students, storage in MB (blank = unlimited), and **Read-only mode** (everyone can look, nobody can change anything). Teacher joins, student approvals and uploads are refused with a clear message once a limit is reached.
- **Usage** – teachers, classes, students, stored records and file storage used.
- **Private note** – only you see it (payment status, agreement, etc.).
- **Delete institute only** – removes the institute and its code; the teachers keep their accounts and classes as ordinary independent teachers.
- **Delete institute and all its data** – also deletes those teacher accounts, their classes, homework, tests, marks and uploaded files. Students stay registered but lose their class. You must type `DELETE ALL`.

**Make independent (after payment).** Clears every limit, pause and read-only setting and detaches the institute from your control. While independent, the panel refuses to suspend, ban, limit or delete it or anything in it. **Return to managed control** reverses it. Only an *active* institute can be made independent.

**Classes and Teachers tabs** list every class code and every teacher account (including independent teachers who never joined an institute) with suspend / reactivate / delete for classes and ban / unban for teachers. **Activity** shows the last 60 admin actions.

Demo safety: an unapproved institute cannot be used, and a suspended one locks everyone out at once, so nobody can keep running a demo without your approval. Individual independent teachers (who never created an institute) can still be suspended or banned from the Classes and Teachers tabs.

## Database safety

Startup migrations only add tables, columns and indexes; existing records are never deleted. Upgrading from V2 keeps all users, classes and data. Students who already belong to a class go straight to their dashboard.

SQLite is safe for this single-instance MVP **only on persistent storage**. A free Render web service has an ephemeral filesystem, so the database can be lost on restart or redeploy. Attach a persistent disk (paid) mounted at `/var/data` and set `DB_PATH=/var/data/studytrack.db`, or move to managed PostgreSQL before storing real student data.

## Render

Use a **Web Service** connected to this repository.

- Root Directory: leave blank
- Build Command: `npm run build`
- Start Command: `npm start`
- Health Check Path: `/api/health`
- Node: 20

If API and frontend run on this one service, do not set `CLIENT_ORIGIN`. The `/admin` page is served by the same app.

## Tests and QA

```bash
npm run check     # syntax check of server.js
npm run qa        # dependency-free source checks (includes a route-protection scan)
npm test          # API integration tests against the real server (run `npm install` in server/ first)
```

The integration tests start `server.js` on a random port with a temporary database. They cover class joining, approve / deny / block, multi-class rooms, teacher sign-up, institutes, roles, suspension, bans, limits, read-only mode, independent mode and deletion. Two storage tests are skipped unless `STUDYTRACK_STORAGE_STUB=1` is set, so a normal run never touches your real Supabase bucket.

## API overview

Public: `POST /api/auth/login`, `/register` (student), `/teacher-register`, `/teacher-join-institute`, `/institute-request`.

Teacher: `GET /api/teacher/context`, `POST /api/teacher/classes`, `GET /api/teacher/join-requests`, `POST /api/teacher/join-requests/:id/approve|deny`, `DELETE /api/teacher/blocks/:id`, `DELETE /api/teacher/students/:id`, plus the existing class endpoints. The selected class is sent in the `x-class-id` header.

Student: `GET /api/student/class-status`, `POST /api/student/join-request`, `POST /api/student/join-request/cancel`, plus the existing student endpoints.

Institute: `GET /api/institute/home`, `POST /api/institute/join|leave`, `POST /api/institute/members/:id/role|note`, `DELETE /api/institute/members/:id`.

Admin (admin token only): `/api/admin/login|overview|log|institutes|classes|teachers` with status, limits, control, note and delete routes.

## Known limits

- Rate limits are kept in server memory, so they reset when the server restarts and apply per server instance.
- Students waiting for approval check for the answer every 7 seconds while the page is visible (no websockets).
- Per-institute usage shows record counts and file bytes; it does not measure database bytes per institute (the overview shows the total database size).
- Co-heads can manage teachers but cannot change or remove the head, and the head cannot leave the institute. There is no in-app way to transfer the head role yet; that is a manual database change for now.
- A teacher can belong to one institute at a time.
