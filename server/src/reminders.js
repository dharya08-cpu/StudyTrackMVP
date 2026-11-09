// Due-date reminders for students: homework, their own goals/revision/tasks, tests and their own exams.
// Each item gets at most one reminder per stage ("due tomorrow", "due today", "overdue"), tracked in reminders_sent.
// Runs when the student's bell checks in (at most every 30 minutes per student), so it needs no scheduler and works on
// hosts that sleep. Reminders are in-app notifications; students can switch them off in Security & privacy.
import { studentClasses, inList, notify } from "./repo.js";

const CHECK_EVERY_MS = 30 * 60_000;
const OVERDUE_DAYS = 7;       // older items are not nagged about
const MAX_PER_RUN = 20;       // never flood someone who has been away for weeks
const KIND_WORD = { goal: "study goal", revision: "revision plan", task: "task" };

const stageFor = (due, today, tomorrow) => (due === tomorrow ? "tomorrow" : due === today ? "today" : due < today ? "overdue" : null);
const WHEN = { tomorrow: "due tomorrow", today: "due today", overdue: "overdue" };

export async function sendRemindersFor(ctx, user, { force = false } = {}) {
  const { db, clock } = ctx;
  if (user.role !== "student" || !user.reminders_enabled) return 0;
  const now = clock.now();
  if (!force && user.reminders_checked_at && now - new Date(user.reminders_checked_at) < CHECK_EVERY_MS) return 0;
  await db.exec("UPDATE users SET reminders_checked_at=$1 WHERE id=$2", [now.toISOString(), user.id]);

  const today = clock.today(), tomorrow = clock.shift(today, 1), oldest = clock.shift(today, -OVERDUE_DAYS);
  const classIds = (await studentClasses(db, user.id)).filter(c => c.available).map(c => c.id);
  const found = []; // { type, id, stage, title, body, priority, classId }

  if (classIds.length) {
    const p = [user.id, oldest, tomorrow];
    const homework = await db.many(`SELECT h.id,h.title,h.due_date,h.class_id FROM homework h LEFT JOIN homework_submissions s ON s.homework_id=h.id AND s.student_id=$1
      WHERE s.id IS NULL AND h.due_date IS NOT NULL AND h.due_date>=$2 AND h.due_date<=$3 AND h.class_id IN (${inList(p, classIds)})`, p);
    for (const h of homework) found.push({ type: "homework", id: h.id, stage: stageFor(h.due_date, today, tomorrow), title: h.title, due: h.due_date, label: "Homework", classId: h.class_id });
    const tp = [today, tomorrow];
    const tests = await db.many(`SELECT id,title,test_date,class_id FROM tests WHERE test_date>=$1 AND test_date<=$2 AND class_id IN (${inList(tp, classIds)})`, tp);
    for (const t of tests) found.push({ type: "test", id: t.id, stage: stageFor(t.test_date, today, tomorrow), title: t.title, due: t.test_date, label: "Test", classId: t.class_id });
  }
  const plans = await db.many("SELECT id,kind,title,end_date FROM student_plan_items WHERE student_id=$1 AND done_at IS NULL AND end_date>=$2 AND end_date<=$3", [user.id, oldest, tomorrow]);
  for (const x of plans) found.push({ type: "plan", id: x.id, stage: stageFor(x.end_date, today, tomorrow), title: x.title, due: x.end_date, label: `Your ${KIND_WORD[x.kind] || "task"}`, classId: null });
  const exams = await db.many("SELECT id,title,exam_date FROM student_exams WHERE student_id=$1 AND exam_date>=$2 AND exam_date<=$3", [user.id, today, tomorrow]);
  for (const x of exams) found.push({ type: "exam", id: x.id, stage: stageFor(x.exam_date, today, tomorrow), title: x.title, due: x.exam_date, label: "Exam", classId: null });

  // Most urgent first: overdue, then today, then tomorrow.
  const rank = { overdue: 0, today: 1, tomorrow: 2 };
  let sent = 0;
  for (const f of found.filter(x => x.stage).sort((a, b) => rank[a.stage] - rank[b.stage])) {
    if (sent >= MAX_PER_RUN) break;
    // Only the first run for this item and stage inserts a row, so a reminder is never repeated.
    const fresh = await db.exec("INSERT INTO reminders_sent(user_id,item_type,item_id,stage,sent_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,item_type,item_id,stage) DO NOTHING", [user.id, f.type, f.id, f.stage, now.toISOString()]);
    if (!fresh) continue;
    const title = f.type === "test" || f.type === "exam" ? `${f.label} ${f.stage === "today" ? "today" : "tomorrow"}: ${f.title}` : `${f.label} ${WHEN[f.stage]}: ${f.title}`;
    await notify(db, clock, [user.id], { type: "reminder", title, body: f.stage === "overdue" ? `It was due ${f.due}. Open it to finish or submit.` : `Date: ${f.due}`, priority: f.stage === "overdue" ? "important" : "normal", classId: f.classId, refType: f.type, refId: f.id });
    sent++;
  }
  return sent;
}

// Never lets a reminder problem break the request that triggered it.
export async function ensureReminders(ctx, user) {
  try { return await sendRemindersFor(ctx, user); } catch (error) { console.error("Reminders failed:", error.message); return 0; }
}
