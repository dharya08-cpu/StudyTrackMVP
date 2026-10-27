# Handling data-deletion requests

The privacy policy promises a reply within 30 days. V4 has no "Delete my account" button, so do it by hand.

## A student (or a teacher with no institute role)
Supabase dashboard > **SQL Editor**, then run (change the e-mail):

```sql
DELETE FROM users WHERE email = 'person@gmail.com';
DELETE FROM teacher_blocks WHERE student_email = 'person@gmail.com';
```

The first line removes everything tied to the person: sessions, class memberships, join requests, study logs, goals, planner, exams, homework submissions, marks, attendance and notifications. The second removes the leftover copy of the e-mail in teachers' block lists. This was tested.

## A teacher
Deleting a teacher also deletes their classes and everything inside those classes (homework, tests, marks and attendance of their students). Warn the institute first. Files they uploaded stay in the storage bucket; remove them in Supabase > Storage (folder `t<teacher id>/` or `i<institute id>/`).

## An institute head: do NOT use SQL
Use Admin panel > Institutes > Delete (with or without data). Deleting the head directly leaves an orphan institute.

## What stays
* Backups keep a copy until they rotate out (daily 14 days, weekly 8 weeks, a few manual ones). The privacy policy says so.
* Failed sign-in records hold only a user number and a masked network address, and are deleted after 90 days.

Reply to the person by e-mail once done, and note the date.
