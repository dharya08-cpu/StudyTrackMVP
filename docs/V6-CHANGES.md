# StudyTrack V6: what changed

## 1. Menu for students and teachers
* **Student:** the row of tabs is gone. Everything is in **Menu**: Overview, Study log, Homework (with a count of homework you have not submitted), Tests, Attendance, Syllabus, Planner, **Calendar** (View calendar, **Edit my calendar**), Announcements, My classes, Notifications, Security & privacy.
* **Teacher:** pick the class at the top of the Menu, then Overview, Study activity, Homework, Tests, Results, Attendance, Syllabus, Students. Join requests, Add a class, Announcements, Calendar & timetable, Notifications, institute and security follow.
* One shared, accessible menu (`client/src/menu.jsx`): Esc and tapping outside close it, keyboard focus stays inside, the page behind does not scroll, focus returns where it was.
* Appearance: **Auto / Light / Dark** at the bottom of the Menu (remembered in a plain cookie).

## 2. My calendar (students)
* Menu > Calendar > **Edit my calendar** lists your goals, revision plans and tasks (Open / Done / All) with *days left*, *Due today* or *Overdue*. Add, edit, tick done, delete.
* The same items appear on **View calendar** (teal, marked "Mine", with a ring on the date dot). Tap a day, then **+ Add to my calendar**.
* Each item has a type (Study goal, Revision, My task), title, optional subject, a **start date and complete-by date** (quick presets: same day, 3 days, 1 week, 2 weeks, 1 month), optional times and notes.
* An open goal or revision plan for a subject adds points to that subject in **What to study today** ("Your goal for this subject is due in 2 days").
* Private: teachers and other students can never see them. Up to 500 items per student, each spanning at most a year.
* Code: `student_plan_items` table, `routes/planner.js`, `calendar.js`, `my-calendar.jsx`.

## 3. Many files per homework or test (the bug)
**Cause:** `homework` and `tests` each had one `file_path` column, so every "attach" overwrote the last file.
**Fix:** a new `attachments` table holds one row per file.
* Create homework or a test with up to **5 files** at once; add more later with **+ Add files** (up to 10 per item).
* Students and teachers see every file with its own **View** (PDF, JPG, PNG open in the browser) and **Download** button.
* Teachers can **Remove** a single file. Deleting a homework removes all its stored files.
* Each file has its own access-checked, 5-minute link: `GET /api/attachments/:id`. The old `/api/files/:kind/:id` still works (it opens the first file).
* Existing files are copied into the new table automatically by migration `003_v6.sql`. The old columns are left in place and no longer used, so you can roll back.
* Storage quotas, admin overviews, institute deletion, demo data and backups all count every file now.

## 4. Design
* New colour system (`client/src/styles.css` tokens): deeper indigo brand, teal for "yours", a distinct colour per calendar item type (always with an icon or text too), softer neutrals.
* Contrast measured against WCAG: every text pair is 4.5:1 or better, most 7:1+; form borders are 3:1+. Light and dark themes both checked.
* 44 px touch targets, 16 px inputs (no zoom on iPhones), clearer focus rings, reduced-motion support.
* No fonts are downloaded (the phone's own font), so nothing extra loads and the CSP stays strict.

## 5. Security and privacy
See [SECURITY.md](SECURITY.md#v6-hardening-in-one-list). Highlights: one generic login error; scrypt cost raised with automatic upgrade of old hashes; 10-character passwords with a common-word check; tighter CSP/permissions; **Download my data** and **Delete my account**.

## 6. Due-date reminders (students)
* Students get an in-app notification **the day before, on the day, and when something is overdue** for homework not yet handed in, tests, their own exams, and their own goals, revision plans and tasks. Each item gets one reminder per stage, never repeated.
* They are created as the student's bell checks in (at most every 30 minutes), so they need no scheduler and work on hosts that sleep. At most 20 per check, and nothing older than 7 days is nagged about.
* Students switch them off in Menu > Security & privacy. Code: `reminders.js`, table `reminders_sent`.

## 7. Parent view
* Menu > **Parent view**: the student creates a secret link (valid 90 days), sees exactly what it shows in a preview, shares it (copy, or WhatsApp), makes a new one (the old one stops) or stops sharing.
* The parent opens `/parent#<secret>` with no account: study time and streak, homework status, recent marks and average, attendance, what is coming up. **Never shown:** e-mail, phone, class codes, teacher feedback, notes, or the titles of the student's own goals. Printable.
* Safety: only a hash of the secret is stored; the secret sits in the link's `#` part so it never reaches server logs or Referer headers; every kind of failure gives the same answer; guessing is rate limited; the link dies when the student is banned or deleted. Code: `parent.js`, `routes/parent.js`, `parent.jsx`.

## 8. Student submission files
* When handing in homework a student can attach up to 5 PDF, JPG, PNG or DOCX files. They can add or remove files until the teacher reviews it; after that it is locked (but stays viewable).
* Teachers see each student's files under the submission, with View and Download. Only the student and that class's teacher can open a file (`/api/submission-files/:id`).
* Files count against the institute's storage limit and are removed with the homework, the class, the institute or the student's account. Code: table `submission_files`.

## 9. Sign-in alerts
* Each account remembers the *kinds* of device it has used (browser + system + phone/computer, as a hash; no IP address or full browser string is stored). A sign-in from a new kind of device creates an **in-app alert** and, when e-mail is set up, an **e-mail** (at most one every 10 minutes).
* The first sign-in, and the first one after upgrading, only teach the account its device, so there is no alert storm. Demo accounts never alert. A broken mail service never blocks signing in. Switch off in Menu > Security & privacy.
* Honest limit: an attacker on the *same kind* of device (say Chrome on Windows) would not trigger it. The alert is a tripwire, not a lock. Code: `login-alerts.js`.

## 10. Class report for teachers
* **Download report** on every classroom page: an Excel workbook (Summary, Results, Attendance, Homework, About) or one sheet as CSV. One row per student; e-mail, phone and parent details are left out on purpose.
* Names that look like formulas (`=HYPERLINK(...)`) are stored as plain text in Excel and neutralised in CSV. No spreadsheet library is needed (`xlsx.js`). Only the teacher's own class can be exported, and exports are logged.

## 11. Demo accounts
All of the above is seeded in the demo data. See [DEMO.md](DEMO.md).

## 12. Works for 100+ people at once
Tested with 112 students and 12 teachers (two institutes, 16 classes) working simultaneously, plus 106 clients over real network connections. Nothing leaked between classes, teachers or students; 589 deliberate cross-access attempts were all refused. The test found and fixed: one wifi router locked out most of a classroom (per-IP limits), file limits that simultaneous uploads could exceed, password-login pile-ups, and unbounded upload memory. See [SCALE.md](SCALE.md).

## Upgrading
1. Deploy. Migrations `003_v6.sql` and `004_v6_features.sql` run automatically at start (they only add tables and columns, and copy file records).
2. Nothing to set. Optional: `MAX_UPLOAD_TOTAL_MB` (default 40).
3. People keep their passwords; the new 10-character rule applies when a password is created or changed. Hashes are upgraded the next time someone logs in.
4. Backups from older versions still restore (their old single files become attachments).

## Behaviour changes to know about
* Log-in failures return `INVALID_CREDENTIALS` (401) instead of `NO_ACCOUNT` (404) / `WRONG_PASSWORD`. The app shows one message for all of them.
* A teacher who still has classes, or who runs an institute, cannot delete their own account from the page (it would delete their students' records). They are told what to do first.
* Two test files left over from V3 (`join-flow`, `storage`) could not run any more and were removed; their cases are covered by the current suites.
* `studytrack.db` and `zipFile.zip` (old copies that were inside the repository) are not part of this package. If `studytrack.db` ever held real people, remove it from your Git history.

## Tested
`npm test` (all server tests), `npm run qa` (72 static checks), `npm run e2e` (24 real-browser steps incl. the file bug and My calendar). The browser and database logic run against the real route code; Postgres itself, Supabase Storage and Google are replaced by in-memory stand-ins in tests, so do one pass on your live Render deployment after deploying.
