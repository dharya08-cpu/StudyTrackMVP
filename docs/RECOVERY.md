# Backups and recovery

**A backup that has never been restored is a hope, not a backup.** StudyTrack therefore tests its own backups.

## What is backed up
Every table that holds your data (users, classes, memberships, homework, tests, marks, study logs, attendance, syllabus, announcements, notifications, calendar, goals, planner, institutes). **Not** backed up on purpose: sessions, login nonces and security events (they hold secrets or are disposable; everyone just signs in again).

Files (homework and test attachments) live in the private `studytrack-files` Supabase bucket. Supabase stores them durably, but they are not copied by this backup. Do not delete that bucket.

## Schedule (automatic, when `BACKUP_ENABLED=true`)
| Backup | When | Kept |
|---|---|---|
| Daily | once a day (first check after midnight, India time) | newest 14 |
| Weekly | Sunday (`BACKUP_WEEKLY_DAY`) | newest 8 |
| Manual | Admin panel > Backups > *Back up now*, or `npm run backup` | newest 10 |

* Stored as a compressed, checksummed file in the private `studytrack-backups` bucket.
* Two server instances cannot take the same backup (a unique period key is claimed first).
* A failed backup is retried after an hour; a crashed run is marked failed.
* **Every weekly backup is automatically test-restored** (see below). The Admin panel shows the last successful restore test and warns if there is no backup in 36 hours.

## Proving a backup works (restore test)
```
npm run backup:verify            # newest backup
npm run backup:verify -- --id 12
```
or Admin panel > Backups > *Test restore*. The file is downloaded, its checksum and per-table checksums are verified, then **restored into a temporary schema inside a transaction that is always rolled back**, and every row count is compared with the manifest. Live data is never touched.

## Recovery procedures

### A. Someone deleted or corrupted data (database still alive)
1. Admin panel > Backups > find the backup from before the damage > note its `#id`.
2. Restore it into a **new, empty** Supabase project first and inspect it (procedure B), then copy back what you need. Restoring over the live database is only for total loss.

### B. Restore into a fresh database (disaster recovery, or to inspect a backup)
1. Create a new Supabase project (or an empty database). Copy its connection string.
2. On your computer, with the repo checked out and `npm --prefix server install` done, set the **old** project's Supabase variables (they hold the backup file) and run:
   ```
   export DATABASE_URL="<old project string, only needed to read backup_runs>"
   export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
   npm run restore --prefix server -- --id 12 --target-url "<NEW database string>" --confirm
   ```
   If the old database is gone, download the `.ndjson.gz` file from the `studytrack-backups` bucket in the Supabase dashboard and use `--file ./backup.ndjson.gz` instead of `--id` (then `DATABASE_URL` can simply be the new database).
3. The script creates the tables, verifies the checksums, loads the rows, resets the id counters and checks every row count.
4. Point Render's `DATABASE_URL` at the new database and redeploy. Check `/api/health`.
5. Run `npm run backup` once and `npm run backup:verify` to confirm the new database is protected too.

### C. Replace the live database in place (last resort)
Same command with `--wipe` and no `--target-url`. This deletes the current data first. Take a manual backup before doing it.

## Quarterly drill (5 minutes)
1. Admin panel > Backups: confirm a restore test passed this month.
2. Once a quarter do procedure B into a scratch Supabase project and open the app against it.
3. Write down the date. If a step fails, fix it that day.

## Also turn on
Supabase paid plans add daily physical backups and point-in-time recovery. If you can afford it, enable it as a second layer: the logical backups here protect against mistakes and let you move between projects, the platform backups protect against provider problems.
