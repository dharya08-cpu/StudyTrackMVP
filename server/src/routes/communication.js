// Notification centre, announcements and the academic calendar.
import { HttpError, v } from "../validate.js";
import { resolveAudience, recipientIds } from "../audience.js";
import { notify, inList, studentClasses } from "../repo.js";
import { buildCalendar, MAX_RANGE_DAYS } from "../calendar.js";

export function communicationRoutes(ctx, r) {
  const { db, clock, auth, role, limiters } = ctx;
  const teacher = [auth, role("teacher")], student = [auth, role("student")];
  const pageSize = req => Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);

  // ---- Notification centre ----
  r.get("/api/notifications", auth, async (req, res) => {
    const params = [req.user.id];
    let where = "user_id=$1";
    if (req.query.before) { params.push(v.id(req.query.before, "cursor")); where += ` AND id<$${params.length}`; }
    if (req.query.unread === "1") where += " AND read_at IS NULL";
    params.push(pageSize(req));
    const rows = await db.many(`SELECT id,type,title,body,priority,class_id,ref_type,ref_id,created_at,read_at FROM notifications WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`, params);
    const unread = (await db.one("SELECT COUNT(*) AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL", [req.user.id])).n;
    res.json({ notifications: rows, unread, next: rows.length === params.at(-1) ? rows.at(-1).id : null });
  });
  r.get("/api/notifications/unread-count", auth, async (req, res) => {
    res.json({ unread: (await db.one("SELECT COUNT(*) AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL", [req.user.id])).n });
  });
  r.post("/api/notifications/read-all", auth, async (req, res) => {
    res.json({ ok: true, updated: await db.exec("UPDATE notifications SET read_at=$1 WHERE user_id=$2 AND read_at IS NULL", [clock.nowIso(), req.user.id]) });
  });
  r.post("/api/notifications/:id/read", auth, async (req, res) => {
    const n = await db.exec("UPDATE notifications SET read_at=COALESCE(read_at,$1) WHERE id=$2 AND user_id=$3", [clock.nowIso(), v.id(req.params.id), req.user.id]);
    if (!n) throw new HttpError(404, "Notification not found");
    res.json({ ok: true });
  });
  r.delete("/api/notifications/:id", auth, async (req, res) => {
    const n = await db.exec("DELETE FROM notifications WHERE id=$1 AND user_id=$2", [v.id(req.params.id), req.user.id]);
    if (!n) throw new HttpError(404, "Notification not found");
    res.json({ ok: true });
  });

  // ---- Announcements ----
  r.post("/api/teacher/announcements", ...teacher, limiters.announce.guard, async (req, res) => {
    const title = v.str(req.body?.title, "Title", { max: 120 });
    const body = v.str(req.body?.body, "Message", { max: 2000, multiline: true });
    const priority = req.body?.priority === undefined ? "normal" : v.oneOf(req.body.priority, "Priority", ["normal", "important"]);
    const audience = await resolveAudience(db, req, req.body);
    const id = await db.tx(async t => {
      const row = await t.one("INSERT INTO announcements(author_id,institute_id,scope,title,body,priority,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id", [req.user.id, audience.instituteId, audience.scope, title, body, priority, clock.nowIso()]);
      for (const classId of audience.classIds) await t.exec("INSERT INTO announcement_targets(announcement_id,class_id) VALUES($1,$2)", [row.id, classId]);
      return row.id;
    });
    const recipients = await recipientIds(db, audience, req.user.id);
    await notify(db, clock, recipients, { type: "announcement", title, body: body.slice(0, 300), priority, classId: audience.classIds.length === 1 ? audience.classIds[0] : null, refType: "announcement", refId: id });
    res.status(201).json({ id, delivered: recipients.length });
  });
  r.get("/api/teacher/announcements", ...teacher, async (req, res) => {
    const rows = await db.many("SELECT id,scope,title,body,priority,created_at FROM announcements WHERE author_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 50", [req.user.id]);
    if (!rows.length) return res.json({ announcements: [] });
    const p = [];
    const targets = await db.many(`SELECT tg.announcement_id,c.name FROM announcement_targets tg JOIN classes c ON c.id=tg.class_id WHERE tg.announcement_id IN (${inList(p, rows.map(x => x.id))}) ORDER BY c.name`, p);
    res.json({ announcements: rows.map(a => ({ ...a, classes: a.scope === "institute" ? ["Entire institute"] : targets.filter(t => t.announcement_id === a.id).map(t => t.name) })) });
  });
  r.delete("/api/teacher/announcements/:id", ...teacher, async (req, res) => {
    const id = v.id(req.params.id);
    const n = await db.exec("UPDATE announcements SET deleted_at=$1 WHERE id=$2 AND author_id=$3 AND deleted_at IS NULL", [clock.nowIso(), id, req.user.id]);
    if (!n) throw new HttpError(404, "Announcement not found");
    await db.exec("DELETE FROM notifications WHERE ref_type='announcement' AND ref_id=$1", [id]);
    res.json({ ok: true });
  });
  r.get("/api/student/announcements", ...student, async (req, res) => {
    const params = [req.user.id];
    let before = "";
    if (req.query.before) { params.push(v.id(req.query.before, "cursor")); before = ` AND a.id<$${params.length}`; }
    params.push(pageSize(req));
    const rows = await db.many(`SELECT a.id,a.title,a.body,a.priority,a.scope,a.created_at,u.name AS author_name FROM announcements a JOIN users u ON u.id=a.author_id
      WHERE a.deleted_at IS NULL${before} AND (
        EXISTS (SELECT 1 FROM announcement_targets tg JOIN student_class_memberships m ON m.class_id=tg.class_id AND m.student_id=$1 AND m.status='active' WHERE tg.announcement_id=a.id)
        OR (a.scope='institute' AND EXISTS (SELECT 1 FROM student_class_memberships m JOIN classes c ON c.id=m.class_id JOIN users t ON t.id=c.teacher_id WHERE m.student_id=$1 AND m.status='active' AND t.institute_id=a.institute_id)))
      ORDER BY a.id DESC LIMIT $${params.length}`, params);
    res.json({ announcements: rows });
  });

  // ---- Calendar events and holidays (teacher) ----
  r.post("/api/teacher/calendar-events", ...teacher, async (req, res) => {
    const b = req.body || {};
    const kind = v.oneOf(b.kind, "Type", ["event", "holiday"]);
    const title = v.str(b.title, "Title", { max: 120 }), description = v.optStr(b.description, "Details", { max: 1000, multiline: true });
    const startDate = v.date(b.startDate, "Start date"), endDate = b.endDate ? v.date(b.endDate, "End date") : startDate;
    if (endDate < startDate) throw new HttpError(400, "End date cannot be before start date");
    if (clock.daysBetween(startDate, endDate) > 60) throw new HttpError(400, "An event can span at most 60 days");
    const startTime = b.startTime ? v.time(b.startTime, "Start time") : null, endTime = b.endTime ? v.time(b.endTime, "End time") : null;
    if (startTime && endTime && endTime <= startTime) throw new HttpError(400, "End time must be after start time");
    const audience = await resolveAudience(db, req, b);
    const id = await db.tx(async t => {
      const row = await t.one(`INSERT INTO calendar_events(created_by,institute_id,kind,title,description,start_date,end_date,start_time,end_time,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [req.user.id, audience.instituteId, kind, title, description, startDate, endDate, startTime, endTime, clock.nowIso()]);
      for (const classId of audience.classIds) await t.exec("INSERT INTO calendar_event_targets(event_id,class_id) VALUES($1,$2)", [row.id, classId]);
      return row.id;
    });
    const recipients = await recipientIds(db, audience, req.user.id);
    await notify(db, clock, recipients, { type: kind, title: `${kind === "holiday" ? "Holiday" : "Event"}: ${title}`, body: startDate === endDate ? startDate : `${startDate} to ${endDate}`, classId: audience.classIds.length === 1 ? audience.classIds[0] : null, refType: "calendar_event", refId: id });
    res.status(201).json({ id });
  });
  r.delete("/api/teacher/calendar-events/:id", ...teacher, async (req, res) => {
    const n = await db.exec("DELETE FROM calendar_events WHERE id=$1 AND created_by=$2", [v.id(req.params.id), req.user.id]);
    if (!n) throw new HttpError(404, "Event not found");
    res.json({ ok: true });
  });

  // ---- One calendar: classes, homework deadlines, tests, events, holidays (+ the student's own exams) ----
  r.get("/api/calendar", auth, limiters.heavy.guard, async (req, res) => {
    const from = v.date(req.query.from ?? clock.startOfWeek(), "From"), to = v.date(req.query.to ?? clock.shift(from, 41), "To");
    if (to < from) throw new HttpError(400, "'to' cannot be before 'from'");
    if (clock.daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw new HttpError(400, `The calendar range can be at most ${MAX_RANGE_DAYS} days`);
    const wanted = req.query.classId ? v.id(req.query.classId, "class") : null;
    let classes;
    if (req.user.role === "teacher") {
      classes = await db.many("SELECT c.id,c.name,t.institute_id FROM classes c JOIN users t ON t.id=c.teacher_id WHERE c.teacher_id=$1 ORDER BY c.id", [req.user.id]);
    } else {
      classes = (await studentClasses(db, req.user.id)).filter(c => c.available).map(c => ({ id: c.id, name: c.name, institute_id: c.institute_id }));
    }
    if (wanted) { classes = classes.filter(c => c.id === wanted); if (!classes.length) throw new HttpError(404, "Class not found"); }
    let schedule = [], homework = [], tests = [], events = [], exams = [];
    if (classes.length) {
      const ids = classes.map(c => c.id);
      let p = [];
      schedule = await db.many(`SELECT id,class_id,weekday,start_time,end_time,subject,room FROM class_schedule WHERE class_id IN (${inList(p, ids)})`, p);
      p = [from, to];
      homework = await db.many(`SELECT id,class_id,title,due_date FROM homework WHERE due_date>=$1 AND due_date<=$2 AND class_id IN (${inList(p, ids)})`, p);
      p = [from, to];
      tests = await db.many(`SELECT id,class_id,title,subject,test_date FROM tests WHERE test_date>=$1 AND test_date<=$2 AND class_id IN (${inList(p, ids)})`, p);
      const instIds = [...new Set(classes.map(c => c.institute_id).filter(Boolean))];
      p = [to, from];
      const classMarks = inList(p, ids);
      let instClause = "";
      if (instIds.length) instClause = ` OR (e.institute_id IN (${inList(p, instIds)}) AND NOT EXISTS (SELECT 1 FROM calendar_event_targets tg2 WHERE tg2.event_id=e.id))`;
      const rows = await db.many(`SELECT e.id,e.kind,e.title,e.description,e.start_date,e.end_date,e.start_time,e.end_time,e.institute_id FROM calendar_events e
        WHERE e.start_date<=$1 AND e.end_date>=$2 AND (EXISTS (SELECT 1 FROM calendar_event_targets tg WHERE tg.event_id=e.id AND tg.class_id IN (${classMarks}))${instClause})`, p);
      if (rows.length) {
        p = [];
        const targets = await db.many(`SELECT event_id,class_id FROM calendar_event_targets WHERE event_id IN (${inList(p, rows.map(e => e.id))})`, p);
        events = rows.map(e => ({ ...e, class_ids: targets.filter(t => t.event_id === e.id).map(t => t.class_id) }));
      }
    }
    if (req.user.role === "student") exams = await db.many("SELECT id,subject,title,exam_date FROM student_exams WHERE student_id=$1 AND exam_date>=$2 AND exam_date<=$3", [req.user.id, from, to]);
    res.json({ from, to, classes: classes.map(c => ({ id: c.id, name: c.name })), entries: buildCalendar({ from, to, classes, schedule, homework, tests, events, exams, clock }) });
  });
}
