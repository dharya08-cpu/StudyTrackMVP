import test from "node:test";
import assert from "node:assert/strict";
import { createTestApp, Browser } from "./helpers.mjs";

const mkStudent = async (app, n) => { const b = new Browser(app); const r = await b.signIn({ sub: `s${n}`, email: `s${n}@gmail.com`, name: `Student ${n}`, role: "student" }); b.id = r.body.user.id; return b; };
const log = (s, subject, minutes, studyDate = "2026-10-07") => s.post("/api/student/study-log", { category: "self-study", subject, minutes, studyDate });

test("goals: set, today's progress, weekly ticks, streak, validation, remove", async () => {
  const app = await createTestApp(); const s = await mkStudent(app, 1);
  assert.equal((await s.get("/api/student/goals")).body.goal, null);
  assert.equal((await s.put("/api/student/goals", { dailyMinutes: 240, weeklyMinutes: 1680 })).status, 200);
  for (const [d, w] of [[5, 100], [240, 100], [1000, 5000], ["x", 1], [240, 99999]]) assert.equal((await s.put("/api/student/goals", { dailyMinutes: d, weeklyMinutes: w })).status, 400, `${d}/${w}`);
  await log(s, "Physics", 240, "2026-10-05"); await log(s, "Chemistry", 250, "2026-10-06"); await log(s, "Maths", 100, "2026-10-07"); await log(s, "Maths", 65, "2026-10-07");
  const g = (await s.get("/api/student/goals")).body;
  assert.equal(g.daily.minutes, 165); assert.equal(g.daily.percent, 69); assert.equal(g.weekly.minutes, 655);
  assert.deepEqual(g.days.map(d => d.status), ["met", "met", "today", "upcoming", "upcoming", "upcoming", "upcoming"]); assert.equal(g.streak, 2);
  await log(s, "Maths", 80, "2026-10-07");
  const done = (await s.get("/api/student/goals")).body; assert.equal(done.days[2].status, "met"); assert.equal(done.daily.percent, 100); assert.equal(done.streak, 3);
  app.setTime("2026-10-09T08:00:00.000Z");
  const later = (await s.get("/api/student/goals")).body; assert.deepEqual(later.days.map(d => d.status).slice(0, 5), ["met", "met", "met", "missed", "today"]);
  assert.equal((await s.put("/api/student/goals", { dailyMinutes: 60, weeklyMinutes: 420 })).body.goal.daily_minutes, 60, "update");
  assert.equal((await app.db.one("SELECT COUNT(*) AS n FROM student_goals")).n, 1);
  assert.equal((await s.delete("/api/student/goals")).body.goal, null);
  const other = await mkStudent(app, 2); assert.equal((await other.get("/api/student/goals")).body.goal, null, "goals are private");
});

test("planner: timetable, exam countdowns and 'what to study today' react to real data", async () => {
  const app = await createTestApp(); const s = await mkStudent(app, 1);
  const empty = (await s.get("/api/student/planner")).body; assert.equal(empty.suggestions.items.length, 0); assert.match(empty.suggestions.hint, /Log a study session/); assert.equal(empty.timetable.length, 7);
  assert.equal(empty.timetable.find(d => d.is_today).weekday, 3);
  await s.put("/api/student/goals", { dailyMinutes: 240, weeklyMinutes: 1680 });
  assert.equal((await s.post("/api/student/plan-slots", { weekday: 3, startTime: "18:00", endTime: "19:30", subject: "Physics", note: "Numericals" })).status, 201);
  assert.equal((await s.post("/api/student/plan-slots", { weekday: 3, startTime: "07:00", endTime: "08:00", subject: "Chemistry" })).status, 201);
  for (const bad of [{ weekday: 0, startTime: "18:00", endTime: "19:00", subject: "x" }, { weekday: 3, startTime: "19:00", endTime: "18:00", subject: "x" }, { weekday: 3, startTime: "7:00", endTime: "8:00", subject: "x" }, { weekday: 3, startTime: "18:00", endTime: "19:00", subject: "" }]) assert.equal((await s.post("/api/student/plan-slots", bad)).status, 400);
  assert.equal((await s.post("/api/student/exams", { subject: "Physics", title: "Mid-term", examDate: "2026-10-10" })).status, 201);
  assert.equal((await s.post("/api/student/exams", { subject: "Maths", title: "Unit test", examDate: "2026-11-20" })).status, 201);
  assert.equal((await s.post("/api/student/exams", { subject: "Maths", title: "Past", examDate: "2026-10-01" })).status, 400, "past exams rejected");
  await log(s, "Maths", 60, "2026-10-01"); await log(s, "Biology", 30, "2026-10-06");
  const p = (await s.get("/api/student/planner")).body;
  assert.deepEqual(p.exams.map(e => [e.title, e.days_left]), [["Mid-term", 3], ["Unit test", 44]]);
  assert.equal(p.suggestions.items[0].subject, "Physics"); assert.ok(p.suggestions.items[0].reasons.includes("Exam in 3 days"));
  assert.ok(p.suggestions.items[0].reasons.includes("In your plan for today"));
  const names = p.suggestions.items.map(i => i.subject); assert.ok(names.includes("Maths"), names.join()); assert.ok(p.suggestions.items.find(i => i.subject === "Maths").reasons.some(r => /Not studied for 6 days/.test(r)));
  assert.equal(p.suggestions.remainingMinutes, 240);
  const today = p.timetable.find(d => d.is_today); assert.deepEqual(today.items.map(i => i.subject), ["Chemistry", "Physics"]); assert.equal(today.items[1].source, "plan");
  await log(s, "Physics", 120);
  const after = (await s.get("/api/student/planner")).body; assert.equal(after.suggestions.remainingMinutes, 120);
  assert.ok(after.suggestions.items.find(i => i.subject === "Physics").score < p.suggestions.items.find(i => i.subject === "Physics").score, "studying a subject today lowers its priority");
  // case-insensitive subject matching: "physics" log counts for the "Physics" exam
  await log(s, "physics", 10, "2026-10-06"); assert.equal((await s.get("/api/student/planner")).body.suggestions.items.filter(i => i.subject.toLowerCase() === "physics").length, 1);
  const id = (await app.db.one("SELECT id FROM student_exams WHERE title='Mid-term'")).id, slot = (await app.db.one("SELECT id FROM study_plan_slots LIMIT 1")).id;
  const thief = await mkStudent(app, 2);
  assert.equal((await thief.delete(`/api/student/exams/${id}`)).status, 404); assert.equal((await thief.delete(`/api/student/plan-slots/${slot}`)).status, 404);
  assert.equal((await s.delete(`/api/student/exams/${id}`)).status, 200); assert.equal((await s.delete(`/api/student/plan-slots/${slot}`)).status, 200);
  assert.equal((await thief.get("/api/student/planner")).body.exams.length, 0);
});

test("planner uses class data: upcoming tests become countdowns, weak scores and syllabus raise priority, pending homework is suggested", async () => {
  const app = await createTestApp();
  const t = new Browser(app); const tr = await t.signIn({ sub: "t1", email: "t1@gmail.com", role: "teacher", name: "T" }); const cls = (await t.post("/api/teacher/classes", { name: "Phy" })).body;
  const s = await mkStudent(app, 1); await app.db.exec("INSERT INTO student_class_memberships(student_id,class_id,status,joined_at) VALUES($1,$2,'active',$3)", [s.id, cls.id, app.clock.nowIso()]);
  const past = (await t.post("/api/teacher/tests", { title: "Quiz 1", subject: "Chemistry", maxMarks: 50, testDate: "2026-10-01" })).body.id;
  await t.post("/api/teacher/marks", { testId: past, studentId: s.id, marks: 15 });
  await t.post("/api/teacher/tests", { title: "Final", subject: "Chemistry", maxMarks: 100, testDate: "2026-10-12" });
  for (const [ch, st] of [["A", "completed"], ["B", "not-started"], ["C", "not-started"], ["D", "not-started"]]) await t.post("/api/teacher/syllabus", { subject: "Chemistry", chapter: ch, status: st });
  await t.post("/api/teacher/homework", { title: "Overdue", dueDate: "2026-10-06" }); await t.post("/api/teacher/homework", { title: "Tomorrow", dueDate: "2026-10-08" }); await t.post("/api/teacher/homework", { title: "Far", dueDate: "2026-11-30" });
  const p = (await s.get("/api/student/planner")).body;
  assert.deepEqual(p.exams.map(e => [e.title, e.source, e.days_left]), [["Final", "test", 5]]);
  const chem = p.suggestions.items.find(i => i.subject === "Chemistry"); assert.ok(chem); assert.ok(chem.reasons.includes("Exam in 5 days") || chem.reasons.some(r => /Exam in 5/.test(r)));
  const hw = p.suggestions.items.find(i => i.type === "homework"); assert.ok(hw); assert.equal(hw.title, "Finish 2 pending homework"); assert.deepEqual(hw.reasons, ["1 overdue"]);
  await s.post(`/api/student/homework/${(await app.db.one("SELECT id FROM homework WHERE title='Overdue'")).id}/submit`, { note: "done" });
  assert.equal((await s.get("/api/student/planner")).body.suggestions.items.find(i => i.type === "homework").title, "Finish 1 pending homework");
  assert.ok(tr);
});
