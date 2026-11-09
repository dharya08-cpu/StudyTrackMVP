# V4 change log: where each request lives

| # | Your request | Implementation |
|---|---|---|
| fix | Teacher could not upload homework / PDF / text | v3's teacher screen had **no create-homework form** at all (only an "attach file" button on homework that could not be created). V4 adds `POST /api/teacher/homework` (text, due date, optional file, one or several classes) and the *Create homework* form in `client/src/teacher-room.jsx`. Tests: classes.test "HOMEWORK (v3 bug fixed)", e2e step 6. |
| 1 | SQLite to PostgreSQL, better Supabase storage | `server/src/db.js`, `migrations/001_init.sql`, `import-sqlite.js`. Two private buckets (files, backups); signed 5-minute links. |
| 2 | Only verified Gmail | `google.js` `assertVerifiedGmail`: `email_verified`, `@gmail.com`/`@googlemail.com`, no Workspace (`hd`). |
| 3 | Privacy, safety, security | `docs/SECURITY.md`. |
| 4 | Smart study planner | `planner.js`, `routes/planner.js`, `client/src/planner.jsx`: weekly timetable (class slots + own study blocks), exam countdowns (own exams + class tests), "what to study today" scored from exams, goal left, neglect, weak scores, syllabus left, today's plan and homework. Each suggestion lists its reasons. |
| 5 | Multiple classes | `student_class_memberships` (unique per student/class). `users.class_code` removed. Per-class and "all classes" views, join/leave, per-class removal, per-class attendance. An institute seat is used once however many of its classes a student joins. |
| 6 | Account recovery / email change / sessions | Google-only (no passwords). Re-verified *Change linked Gmail*, log out everywhere, session management. See README. |
| 7 | Session/device management | Security > Active sessions: device icon, OS and browser, location or masked address, "Active now" / "2 hours ago", *Log out* per device, *Log out all other devices*. |
| 8 | Attack protections, headers, CORS, CSP, validation, rate limits | `docs/SECURITY.md`. |
| 5b | File-upload security | `files.js`: never trusts name, MIME, extension or size. |
| 9 | Notification centre | `notifications` table, bell with unread count, list, mark read/all, delete, paging. Created by announcements, homework, tests, marks, join requests/decisions, reviews, holidays/events, institute decisions. |
| 10 | Announcements | `routes/communication.js`, `announcements.jsx`: one class, several classes, or the whole institute (heads only). Important flag. Delivered to the notification centre; deleting removes it. |
| 11 | Calendar | `calendar.js`, `calendar.jsx`: 📚 classes (weekly timetable), 📝 homework deadlines, 🧪 tests, 📢 events, 📅 holidays (+ 🎯 own exams). Holidays mark class sessions. |
| 12 | Student goals | `goals.js`, `GoalsCard`: "2h 45m / 4h" with bar, Mon to Sun ticks, weekly total, streak. |
| 13 | Backups | `backup.js`, `scripts/`, Admin > Backups, `docs/RECOVERY.md`: daily + weekly, retention, automatic weekly restore test, manual restore test, tampering detection. |

## Behaviour changes to be aware of
* There is no student/teacher password or "teacher registration with a class" step. Teachers sign in with Google, then create a class, join an institute with a code or request their own institute from the Menu.
* A student without a class can still log study, set goals and plan; class features appear after joining.
* If an institute is suspended, only **that** institute's classes pause for a student; their other classes keep working.
* Removed from V3: `/api/auth/login`, `/api/auth/teacher-register`, `/api/auth/institute-request`. Institute requests are now signed-in (`POST /api/institute/request`).
* Storage keys are no longer sent to browsers; files are opened through `GET /api/files/:kind/:id`.

## Upgrading checklist
1. Create Supabase project, buckets, Google client (README 1 to 2).
2. Set Render variables (README 3), remove `JWT_SECRET`, `DB_PATH`. Remove old `package-lock.json` files if `npm ci` is used anywhere (Render uses `npm install`, so they refresh by themselves).
3. Deploy. Tables are created automatically.
4. Import V3 data (README 4).
5. Run `TEST_DATABASE_URL=... npm test` against a scratch database, then `npm run backup` and `npm run backup:verify`.

## V4.1 additions
* Separate **Log in** and **Sign up** pages; Gmail + password (e-mail verified) or Google; forgot / reset / change password.
* One-time **details page** after sign-up (parent or guardian for students); Google name pre-filled for confirmation.
* **Demo accounts**: 3 teachers, 2 students, 6 classes, 1 institute, weeks of data (see [docs/DEMO.md](DEMO.md)).
* Weekly study trend now compares completed days with the same days last week (it used to compare a half week with a whole week).
* Privacy policy updated for the new data (profile details, parent or guardian, password hashes, e-mail sending).
