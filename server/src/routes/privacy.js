// Privacy rights without asking an administrator: download everything StudyTrack holds about me, and delete my account.
import { HttpError } from "../validate.js";
import { serializeCookie, maskIp, clientIp } from "../security.js";
import { sessionCookieName } from "../auth.js";
import { verifyPassword } from "../passwords.js";
import { removeFiles } from "../uploads.js";

const PROFILE_FIELDS = "id,name,email,role,first_name,last_name,phone,parent_name,parent_phone,grade,school,city,subjects,created_at,last_login_at,profile_completed_at";

export function privacyRoutes(ctx, r) {
  const { db, config, clock, auth, limiters } = ctx;
  const wait = (limiter, req, res) => new Promise((resolve, reject) => limiter.guard(req, res, e => (e ? reject(e) : resolve())));

  // Everything about the signed-in person as one JSON file. Never includes password hashes, session secrets or other people's data.
  r.get("/api/account/export", auth, async (req, res) => {
    await wait(limiters.privacy, req, res);
    const uid = req.user.id;
    const me = await db.one(`SELECT ${PROFILE_FIELDS} FROM users WHERE id=$1`, [uid]);
    const out = { exported_at: clock.nowIso(), account: { ...me, sign_in_methods: { google: Boolean((await db.one("SELECT google_sub FROM users WHERE id=$1", [uid])).google_sub), password: req.user.has_password } } };
    if (req.user.role === "student") {
      Object.assign(out, {
        classes: await db.many("SELECT c.name,c.code,m.joined_at,m.status FROM student_class_memberships m JOIN classes c ON c.id=m.class_id WHERE m.student_id=$1 ORDER BY m.id", [uid]),
        study_logs: await db.many("SELECT category,subject,minutes,study_date,note,created_at FROM study_logs WHERE student_id=$1 ORDER BY study_date,id", [uid]),
        study_goal: await db.one("SELECT daily_minutes,weekly_minutes,updated_at FROM student_goals WHERE student_id=$1", [uid]),
        weekly_study_blocks: await db.many("SELECT weekday,start_time,end_time,subject,note FROM study_plan_slots WHERE student_id=$1 ORDER BY weekday,start_time", [uid]),
        my_exams: await db.many("SELECT subject,title,exam_date,notes FROM student_exams WHERE student_id=$1 ORDER BY exam_date", [uid]),
        my_calendar: await db.many("SELECT kind,title,subject,notes,start_date,end_date,start_time,end_time,done_at FROM student_plan_items WHERE student_id=$1 ORDER BY start_date,id", [uid]),
        homework_submissions: await db.many("SELECT h.title,hs.note,hs.status,hs.feedback,hs.submitted_at,hs.reviewed_at FROM homework_submissions hs JOIN homework h ON h.id=hs.homework_id WHERE hs.student_id=$1 ORDER BY hs.id", [uid]),
        marks: await db.many("SELECT t.title,t.subject,m.marks,t.max_marks,m.remark FROM marks m JOIN tests t ON t.id=m.test_id WHERE m.student_id=$1 ORDER BY m.id", [uid]),
        homework_files_uploaded: await db.many("SELECT h.title,f.file_name,f.file_size,f.created_at FROM submission_files f JOIN homework_submissions s ON s.id=f.submission_id JOIN homework h ON h.id=s.homework_id WHERE f.student_id=$1 ORDER BY f.id", [uid]),
        parent_link: (await db.one("SELECT created_at,expires_at,last_viewed_at,view_count,revoked_at FROM parent_links WHERE student_id=$1 ORDER BY id DESC LIMIT 1", [uid])) || null,
        reminders: { enabled: Boolean((await db.one("SELECT reminders_enabled FROM users WHERE id=$1", [uid])).reminders_enabled) },
        attendance: await db.many("SELECT c.name AS class,a.attendance_date,a.status FROM attendance a JOIN classes c ON c.id=a.class_id WHERE a.student_id=$1 ORDER BY a.attendance_date", [uid]),
      });
    } else {
      Object.assign(out, {
        classes: await db.many("SELECT name,code,created_at FROM classes WHERE teacher_id=$1 ORDER BY id", [uid]),
        homework_posted: await db.many("SELECT title,due_date,created_at FROM homework WHERE teacher_id=$1 ORDER BY id", [uid]),
        tests_posted: await db.many("SELECT title,subject,max_marks,test_date,created_at FROM tests WHERE teacher_id=$1 ORDER BY id", [uid]),
        note: "Records about your students belong to them and your classes; they are not part of this export.",
      });
    }
    out.known_devices = await db.many("SELECT label,first_seen_at,last_seen_at FROM known_devices WHERE user_id=$1 ORDER BY id", [uid]);
    out.notifications = await db.many("SELECT type,title,body,created_at FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 500", [uid]);
    out.security_log = await db.many("SELECT type,ip_masked,created_at FROM security_events WHERE user_id=$1 ORDER BY id DESC LIMIT 200", [uid]);
    await ctx.audit(req, "data_export", "");
    res.set("Content-Disposition", 'attachment; filename="studytrack-my-data.json"');
    res.json(out);
  });

  // Deleting an account is permanent. It needs the password (or a fresh Google check) and the word DELETE.
  r.delete("/api/account", auth, async (req, res) => {
    await wait(limiters.privacy, req, res);
    const uid = req.user.id;
    if (req.user.is_demo) throw new HttpError(403, "Demo accounts can't be deleted.", "DEMO_LOCKED");
    if (req.body?.confirm !== "DELETE") throw new HttpError(400, "Type DELETE to confirm.", "CONFIRM_REQUIRED");
    const me = await db.one("SELECT password_hash,institute_role FROM users WHERE id=$1", [uid]);
    if (me.password_hash) {
      await wait(limiters.changePw, req, res);
      if (typeof req.body?.password !== "string" || !(await verifyPassword(req.body.password, me.password_hash))) {
        limiters.changePw.fail(req);
        throw new HttpError(401, "Your password is not correct.", "WRONG_PASSWORD");
      }
    } else await new Promise((resolve, reject) => ctx.requireRecentReauth(req, res, e => (e ? reject(e) : resolve()))); // Google-only: confirm with Google first
    if (req.user.role === "teacher") {
      if (["head", "co_head"].includes(me.institute_role)) throw new HttpError(409, "You manage a coaching institute. Hand it over or ask StudyTrack support before deleting your account.", "INSTITUTE_HEAD");
      if ((await db.one("SELECT COUNT(*) AS n FROM classes WHERE teacher_id=$1", [uid])).n > 0) throw new HttpError(409, "You still have classes. Delete your classes first (their students lose access), then delete your account.", "CLASSES_EXIST");
    }
    const filePaths = (await db.many("SELECT file_path FROM submission_files WHERE student_id=$1", [uid])).map(x => x.file_path); // removed from storage after the rows go
    await db.tx(async t => {
      // Teachers' block lists keep an address only to stop a student re-joining; erase it when that student is deleted.
      await t.exec("UPDATE teacher_blocks SET student_email='deleted-'||id,student_name='' WHERE student_id=$1", [uid]);
      await t.exec("UPDATE security_events SET user_id=NULL WHERE user_id=$1", [uid]);
      await t.exec("DELETE FROM users WHERE id=$1", [uid]); // sessions, logs, goals, calendar, submissions, marks, attendance and notifications go with it
    });
    await removeFiles(ctx, filePaths);
    // Recorded WITHOUT the user id: the audit trail must not stay tied to a person who asked to be erased.
    await db.exec("INSERT INTO security_events(user_id,type,ip_masked,detail,created_at) VALUES(NULL,$1,$2,$3,$4)", ["account_deleted", maskIp(clientIp(req)), req.user.role, clock.nowIso()]);
    res.append("Set-Cookie", serializeCookie(sessionCookieName(config), "", { secure: config.isProd, sameSite: "Strict", maxAgeSeconds: 0 }));
    res.json({ ok: true });
  });
}
