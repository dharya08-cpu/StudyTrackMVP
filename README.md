# StudyTrack V2

StudyTrack is a student/teacher study management app with study logging, homework, tests/results, attendance, syllabus coverage, analytics and responsive dashboards.

## V2 scope

- Teacher study activity and student analytics
- Daily/weekly study totals and subject/category breakdowns
- Study-hours + test-performance history
- Teacher dashboard and quick student status
- Recent activity
- Homework submission/review tracking
- Test percentage/history/trends
- Teacher-side student results
- Attendance register, percentage and streaks
- Chapter-level syllabus coverage
- Responsive UI with loading, empty and error states

Not included in this version: photo/PDF homework uploads and Parent View.

## Local run

Requirements: Node.js 20.

From the repository root:

```bash
npm install
npm run build
npm start
```

The server serves the production client from `client/dist` and listens on Render's `PORT` value when deployed.

For development, run the server and Vite separately:

```bash
cd server && npm install && npm start
cd client && npm install && npm run dev
```

## Environment variables

Development defaults are documented in `server/.env.example`.

Production requires:

- `NODE_ENV=production`
- `JWT_SECRET` — a long random secret used to sign login tokens
- `DB_PATH` — a path on persistent storage, not the repository filesystem
- `STUDYTRACK_TIMEZONE=Asia/Kolkata` unless your users are in another timezone
- `CLIENT_ORIGIN` only when the frontend/API are served from different origins

A completely new production database also needs `INITIAL_TEACHER_PASSWORD` (12+ characters). Optional `INITIAL_TEACHER_EMAIL`, `INITIAL_TEACHER_NAME`, `INITIAL_CLASS_CODE`, `INITIAL_CLASS_NAME`, and `INITIAL_STUDENT_PASSWORD` are documented in `.env.example`.

The supplied database already contains the StudyTrack demo teacher/student records. The passwords are no longer shown in the application UI. Change them before treating the deployment as a real production system.

## Database safety

The server runs startup migrations for the V2 attendance, syllabus and homework-submission fields and creates analytics indexes without deleting existing records.

SQLite is safe for this single-instance MVP only when its database file is stored on persistent storage. Do **not** point `DB_PATH` at the repository copy on a free/ephemeral Render filesystem. Render documents that free web services have an ephemeral filesystem; local SQLite data can be lost on restart/redeploy/spindown. Paid Render web services can use a persistent disk, or the application can later be migrated to a managed PostgreSQL database.

## Render

Use a **Web Service** connected to this repository.

- Root Directory: leave blank
- Build Command: `npm run build`
- Start Command: `npm start`
- Health Check Path: `/api/health`
- Node: 20

For a persistent SQLite deployment, attach a persistent disk and mount it at `/var/data`, then set:

```text
NODE_ENV=production
JWT_SECRET=<your long random secret>
DB_PATH=/var/data/studytrack.db
STUDYTRACK_TIMEZONE=Asia/Kolkata
```

If the API and frontend are served by this same service, do not set `CLIENT_ORIGIN`.

## Important Render storage limitation

A free Render web service cannot attach a persistent disk. Render says local SQLite files on free web services are lost on restart, redeploy, or spin-down. For a genuinely persistent free deployment, use an external managed PostgreSQL service instead of SQLite; that is a separate database migration step and should be done before storing important real student data.

## QA checks

The repository includes dependency-free source checks:

```bash
npm run check
npm run qa
```

A full production browser build still requires installing the npm dependencies in an environment with npm registry access. Render performs that dependency installation and the Vite build during deployment.
