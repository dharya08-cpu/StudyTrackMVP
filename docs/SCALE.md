# Can 100+ teachers and students use StudyTrack at the same time?

**Yes, with the settings and hosting notes below.** This page says what was tested, what was found and fixed, what the numbers were,
and, just as important, what was *not* proven.

## What was tested

| Test | What it does | Result |
|---|---|---|
| `scale.test.mjs` "100+ people at once" | 12 teachers (2 coaching institutes + 5 independent) and 112 students in 16 classes, mixed devices, ~40 students behind one wifi router, 10 using passwords. Everyone signs in at once, then teachers publish homework/tests/marks/attendance/announcements/events with files **while** students study, plan, share parent links, hand in work with files, and teachers review. Then every person's complete view of the app is scanned for anybody else's data. | 4,189 requests in 5.4 s, **no leaks**, nothing lost, duplicated or orphaned |
| same test, "attacks" | 589 deliberate attempts, all at once, to read, edit or delete other people's files, homework, marks, attendance, calendars, exports and submissions (students vs other classes/students, teachers vs other teachers' classes, signed-out visitors) | **all refused**; the database was unchanged afterwards |
| `scale.test.mjs` "simultaneous clicks" | 45 students join the same class and the teacher approves all at once; six simultaneous Submit clicks; 8 uploads at once; one student on two devices; two browser tabs writing the same attendance and marks; a homework deleted while 20 students hand in | exactly one of everything, limits kept exactly, no orphaned files |
| `scale.test.mjs` "one wifi" | 110 people on ONE IP sign in, join and work; plus proof that wrong-password lock-outs, one-account hammering and sign-up floods are **still** stopped | no one blocked; abuse still blocked |
| `scale-http.test.mjs` | 106 clients over **real network connections** to a real HTTP server, each with its own cookies, device and IP, through the production security chain | 1,696 requests, 536 req/s, **no refusals, no leaks** |
| cost check | database queries per request with 10 vs 80 students | **identical** (no per-student queries) |
| negative controls | a deliberate cross-class leak was planted | the scanner caught it (then it was removed) |

Run them yourself: `npm run test:scale` (about 20 seconds) and `npm run qa:scale`.

## Problems found and fixed

1. **One wifi locked everybody out (serious).** With the old defaults only **30 of 100** students behind one router could sign in, and then every request failed. Cause: several limits were counted per IP address (300 requests/min, 30 Google sign-ins per 10 min, 10 sign-ups/hour, 60 password logins per 15 min, 30 class joins per 10 min...), and a classroom shares one IP. Now those are multiplied by `IP_LIMIT_FACTOR` (default 10). Per-account protections are **not** multiplied.
2. **File limits could be exceeded by simultaneous uploads.** The 5-file and 10-file limits were checked before saving. They are now exact.
3. **A rush of password logins could pile up and time out.** Hashing is deliberately CPU-heavy. Now only a few run at once and an overloaded server answers "busy, try again" (503) instead of hanging. "Busy" is never reported as "wrong password".
4. **Many simultaneous uploads could exhaust memory.** Files are held in memory while received. Now all uploads in flight share a budget (`UPLOAD_INFLIGHT_MB`); extra ones are told to retry in a few seconds.
5. Worker threads raised from 4 to 6 so a login rush cannot delay everything else; two extra database indexes for cleanup paths.

## Settings (all optional; defaults suit ~100 to a few hundred people)

| Setting | Default | Meaning |
|---|---|---|
| `IP_LIMIT_FACTOR` | 10 | Multiplies limits counted per IP address (for classrooms behind one router). Lower it if you see abuse; raise it for a very large centre. |
| `DB_POOL_MAX` | 10 | Database connections. Ten comfortably serves 100+ people. Stay under your database's connection limit. |
| `UPLOAD_INFLIGHT_MB` | 100 | Upload data held in memory at once. Lower it on a 512 MB host if you see memory trouble. |
| `MAX_UPLOAD_MB` / `MAX_UPLOAD_TOTAL_MB` | 15 / 40 | Per file / per request. |
| `PASSWORD_HASH_PROFILE` | strong | `balanced` costs ~4x less CPU for small hosts. Existing stronger hashes are never weakened. |

## Hosting notes (estimates, not measurements of your host)

* **Password hashing is the one heavy thing.** Measured here on one core: about 160 ms per login and about 6 logins per second. A very small host (a fraction of a core) can be 5 to 10 times slower, so **a burst of 100 people typing passwords in the same minute** can take minutes and some will see "busy, try again". It only matters on first-day rollouts: sessions last 30 days, and **"Continue with Google" needs no hashing at all**. For rollout day use a plan with at least 0.5 to 1 CPU, or `PASSWORD_HASH_PROFILE=balanced`, or ask people to sign in with Google.
* Free hosting plans that **sleep when idle** make the first person after a quiet period wait up to a minute. For classes with fixed timings use an always-on plan.
* Run **one server instance**. Rate limiting is kept in that instance's memory; several instances would each count separately (everything else is in the database and would work).
* Memory: 512 MB is enough for this load.

## What this does NOT prove

* The tests run the real application code on an in-memory SQLite database, not on a live **Postgres**. Query counts, isolation and logic carry over; Postgres's own timing and locking do not. Two Postgres-only hazards were checked by scanning the code instead (`npm run qa:scale`): no transaction uses a second connection, and no transaction waits on slow work.
* Network quality on students' phones, real Google/Supabase/e-mail response times, and your host's actual CPU were not measured.
* It is a burst test of about a minute of heavy use, not a multi-day soak.
* A teacher sees their own students' study logs (the Study activity feature, by design). A student's private goals, calendar items and exams are never shown to teachers; the scan checks this.

After you deploy, a good real-world check: ask 20 to 30 people to sign in and use it together once, and watch Render's CPU and memory graphs.
