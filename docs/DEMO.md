# Demo accounts

For showing StudyTrack to real teachers. They are **public by design** (the passwords below), so they hold only made-up data and are completely separated from real accounts: demo users can never join real classes and real users can never join DEMO classes.

## Turn them on
1. In Render > Environment add `ALLOW_DEMO` = `true` and redeploy. The accounts are created automatically on start.
2. To restore everything to its starting point at any time: **Admin panel (`/admin`) > Demo > Reset demo data**, or `npm run seed:demo`.
3. Turn `ALLOW_DEMO` off (or delete it) when you do not need the demo: the demo logins then stop working.

## Logins (Log in page, type the Gmail and password)
| Gmail | Password | Role | Shows |
|---|---|---|---|
| demoteacher1@coaching.com | demoteacher1 | Teacher | Head of the institute: Physics (DEMO01) + Chemistry (DEMO02); institute page; announce to the whole institute |
| demoteacher2@coaching.com | demoteacher2 | Teacher | Teacher in the same institute: Maths (DEMO03) + Biology (DEMO04) |
| demoteacher3@coaching.com | demoteacher3 | Teacher | Independent teacher (no institute): English (DEMO05) + Computer Science (DEMO06) |
| demostudent1@coaching.com | demostudent1 | Student | Aarav: strong, improving marks, 12-day study streak, goal 4h/day (2h 45m logged today) |
| demostudent2@coaching.com | demostudent2 | Student | Diya: irregular study, falling marks, overdue homework: the warning signals |

Both students are in all 6 classes. A student can belong to classes of several institutes and of independent teachers at the same time, so no third student is needed.

## What each feature shows
* **Overview and goals**: progress bar, Mon to Sun ticks, streak, study by subject and type.
* **Homework**: reviewed, submitted, pending and overdue items. With file storage connected, every class has a worksheet and an answer key, and Physics also has a diagram picture, so you can show **several files, each with its own View and Download**.
* **Handing in work with files**: Aarav and Diya have uploaded PDFs and a photo with their submissions. Log in as a teacher, open Menu > Homework, tap a homework to see **the files each student handed in**.
* **Tests and results**: past tests with marks, an upcoming test, trends, solutions. The latest test of every class has a question paper and a solutions file.
* **Attendance and syllabus**: eight weeks of attendance, chapters done / in progress / not started.
* **Planner**: weekly timetable (class times + study blocks), exam countdowns, "what to study today" with reasons.
* **Calendar**: classes, homework deadlines, tests, events, holidays (a Diwali break flags classes on those days) and the student's own exams.
* **My calendar (students)**: Menu > Calendar > **Edit my calendar**. Aarav has six items (open, finished, due soon); Diya has an overdue revision plan and a task due today. They also appear on **View calendar** in teal.
* **Reminders**: both students already have due-date reminders (homework due tomorrow, overdue homework, an exam tomorrow, goals due). Open the bell or Menu > Notifications. Switch them off in Menu > Security & privacy.
* **Parent view**: both students have a live link. Open the link for Aarav or Diya from **Admin panel > Demo** (the page lists them). It needs no sign-in, so open it in a private window to show how a parent sees it. Students manage it in Menu > Parent view.
* **Sign-in alerts**: Aarav and Anita each have a "New sign-in on Safari on iOS" notification and a list of known devices. Logging in as a demo account never sends a real alert or e-mail.
* **Class report (teachers)**: any classroom page > **Download report** gives an Excel workbook (Summary, Results, Attendance, Homework) or a CSV of one sheet.
* **Announcements and notifications**: one class, several classes, whole institute, an important one; read and unread notifications.
* **Teacher side**: class overview with at-risk signals, per-student analytics, results, attendance, syllabus, announcements, calendar and timetable, institute page.

## A live joining demo
Log in as Diya, open Classes, tap **Leave** on a class, then enter its code (DEMO01 to DEMO06) and send the request. Log in as that class's teacher, open Menu > Join requests and press **Allow**.

## Safety notes
* Never put real names or data in demo accounts. Anyone with the password can edit them; Reset restores everything.
* Demo passwords and e-mail cannot be changed, and no e-mails are ever sent to them.
