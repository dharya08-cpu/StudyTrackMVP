import test from "node:test";
import assert from "node:assert/strict";
import { createClock, trend } from "../src/dates.js";
import { buildSuggestions, scoreSubject } from "../src/planner.js";
import { goalProgress, validateGoals } from "../src/goals.js";
import { buildCalendar } from "../src/calendar.js";
import { v, cleanText, safeFilename, HttpError } from "../src/validate.js";
import { maskIp, parseCookies, serializeCookie, csrfTokenFor, safeEqual, buildCsp } from "../src/security.js";
import { createLimiter } from "../src/ratelimit.js";
import { parseUserAgent } from "../src/sessions.js";
import { loadConfig } from "../src/config.js";
import { weekTrend } from "../src/weektrend.js";
import { createTestDb } from "./helpers.mjs";

const clock = createClock("Asia/Kolkata", () => new Date("2026-10-07T08:00:00Z")); // Wednesday

test("clock: weekday, week start, shifting and time-zone day boundaries", () => {
  assert.equal(clock.today(), "2026-10-07");
  assert.equal(clock.weekday("2026-10-07"), 3);
  assert.equal(clock.weekday("2026-10-11"), 7);
  assert.equal(clock.startOfWeek("2026-10-11"), "2026-10-05");
  assert.deepEqual(clock.weekDates("2026-10-07")[0], "2026-10-05");
  assert.equal(clock.shift("2026-12-31", 1), "2027-01-01");
  assert.equal(clock.daysBetween("2026-10-07", "2026-10-17"), 10);
  const late = createClock("Asia/Kolkata", () => new Date("2026-10-07T19:00:00Z")); // 00:30 next day in India
  assert.equal(late.today(), "2026-10-08");
  assert.equal(trend(110, 100), "improving"); assert.equal(trend(80, 100), "declining"); assert.equal(trend(100, 100), "stable"); assert.equal(trend(5, 0), "new");
});

test("validators reject bad types, ranges and dates", () => {
  assert.equal(v.str("  hi  ", "x"), "hi");
  assert.throws(() => v.str({ $ne: 1 }, "x"), HttpError);
  assert.throws(() => v.str(["a"], "x"), HttpError);
  assert.throws(() => v.str("a".repeat(201), "x"), HttpError);
  assert.throws(() => v.str("   ", "x"), HttpError);
  assert.equal(v.int("12", "n", { min: 1, max: 20 }), 12);
  for (const bad of ["1.5", 1.5, "abc", NaN, Infinity, 99, null]) assert.throws(() => v.int(bad, "n", { min: 1, max: 20 }));
  assert.equal(v.date("2026-02-28"), "2026-02-28");
  for (const bad of ["2026-02-30", "2026-13-01", "26-01-01", "2026-1-1", "", null, "1999-01-01", "2026-01-01T00:00"]) assert.throws(() => v.date(bad), HttpError);
  assert.equal(v.time("16:30"), "16:30"); assert.throws(() => v.time("24:00")); assert.throws(() => v.time("9:00"));
  assert.equal(v.id("5"), 5); for (const bad of ["0", "-1", "1e3", "5; DROP TABLE users", 0, 3.2, [], {}]) assert.throws(() => v.id(bad));
  assert.deepEqual(v.idList([1, "2", 2], "x"), [1, 2]); assert.throws(() => v.idList([], "x")); assert.throws(() => v.idList("1,2", "x"));
  assert.equal(v.code("ab12cd", "c"), "AB12CD"); assert.throws(() => v.code("a b", "c")); assert.throws(() => v.code("abc", "c"));
  assert.throws(() => v.oneOf("__proto__", "x", ["a"]));
});
test("text sanitising strips control, zero-width and bidi characters", () => {
  assert.equal(cleanText("he\u0000l\u200Blo\u202E", { max: 20 }), "hello");
  assert.equal(cleanText("a\nb", { max: 20 }), "a b");
  assert.equal(cleanText("a\nb", { max: 20, multiline: true }), "a\nb");
  assert.equal(cleanText("<script>alert(1)</script>", { max: 50 }), "<script>alert(1)</script>"); // stored as inert text; React renders it escaped, CSP blocks inline script
  assert.equal(safeFilename("../../a b/c<d>.PDF"), "c-d-.pdf".replace("c-d-", "c-d"));
});
test("cookies, masked IPs, CSRF tokens and constant-time compare", () => {
  assert.deepEqual(parseCookies("a=1; b=hello%20world; bad=%E0%A4%A; a=2"), { a: "1", b: "hello world" });
  const c = serializeCookie("st", "v", { maxAgeSeconds: 60, secure: true, sameSite: "Strict" });
  assert.match(c, /HttpOnly/); assert.match(c, /Secure/); assert.match(c, /SameSite=Strict/); assert.match(c, /Max-Age=60/);
  assert.equal(maskIp("49.36.12.200"), "49.36.•.•"); assert.equal(maskIp("::ffff:10.1.2.3"), "10.1.•.•"); assert.match(maskIp("2401:4900:1c2f::1"), /^2401:4900/); assert.equal(maskIp(""), "");
  assert.equal(csrfTokenFor("s", "id1"), csrfTokenFor("s", "id1")); assert.notEqual(csrfTokenFor("s", "id1"), csrfTokenFor("s", "id2")); assert.notEqual(csrfTokenFor("s", "id1"), csrfTokenFor("t", "id1"));
  assert.ok(safeEqual("abc", "abc")); assert.ok(!safeEqual("abc", "abd")); assert.ok(!safeEqual("abc", "abcd"));
  const csp = buildCsp({ isProd: true });
  for (const part of ["default-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "upgrade-insecure-requests", "https://accounts.google.com/gsi/client"]) assert.ok(csp.includes(part), part);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp) && !/script-src[^;]*unsafe-eval/.test(csp));
});
test("rate limiter counts, blocks, resets and caps memory", () => {
  let t = 0; const lim = createLimiter({ max: 3, windowMs: 1000, countEveryRequest: true, now: () => t });
  const res = { set() {} }, req = { ip: "1.1.1.1" }; let outcome;
  const hit = () => lim.guard(req, res, e => { outcome = e || "ok"; });
  hit(); hit(); hit(); assert.equal(outcome, "ok");
  hit(); assert.equal(outcome.status, 429);
  t = 1500; hit(); assert.equal(outcome, "ok");
  const fl = createLimiter({ max: 2, windowMs: 1000, now: () => t });
  fl.fail(req); fl.fail(req); fl.guard(req, res, e => { outcome = e || "ok"; }); assert.equal(outcome.status, 429);
  fl.clear(req); fl.guard(req, res, e => { outcome = e || "ok"; }); assert.equal(outcome, "ok");
  lim.stop(); fl.stop();
});
test("user-agent parsing", () => {
  assert.deepEqual(parseUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36"), { deviceType: "mobile", os: "Android", browser: "Chrome" });
  assert.deepEqual(parseUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0"), { deviceType: "desktop", os: "Windows", browser: "Edge" });
  assert.equal(parseUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Mobile Safari/604").browser, "Safari");
  assert.equal(parseUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0").browser, "Firefox");
  assert.equal(parseUserAgent("").deviceType, "unknown");
});
test("config: production refuses weak or missing settings", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /DATABASE_URL[\s\S]*SESSION_SECRET[\s\S]*ADMIN_KEY[\s\S]*GOOGLE_CLIENT_ID/);
  assert.throws(() => loadConfig({ NODE_ENV: "production", DATABASE_URL: "x", SESSION_SECRET: "short", ADMIN_KEY: "k".repeat(12), GOOGLE_CLIENT_ID: "g", APP_URL: "http://insecure.example.com", SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k" }), /SESSION_SECRET|https/);
  const ok = loadConfig({ NODE_ENV: "production", DATABASE_URL: "postgres://x", SESSION_SECRET: "s".repeat(40), ADMIN_KEY: "k".repeat(12), GOOGLE_CLIENT_ID: "g", APP_URL: "https://app.example.com", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" });
  assert.equal(ok.isProd, true); assert.deepEqual(ok.appOrigins, ["https://app.example.com"]); assert.equal(ok.databaseSsl, "require");
});

// ---- Goals ----
test("goal progress: today bar, weekly ticks, streak and no-goal state", () => {
  const week = clock.weekDates("2026-10-07"); // Mon 5 .. Sun 11, today = Wed 7
  const mins = { "2026-10-05": 240, "2026-10-06": 250, "2026-10-07": 165, "2026-10-04": 300, "2026-10-03": 260 };
  const p = goalProgress({ goal: { daily_minutes: 240, weekly_minutes: 1680 }, minutesByDate: mins, today: "2026-10-07", weekDates: week, shift: clock.shift });
  assert.deepEqual(p.days.map(d => d.status), ["met", "met", "today", "upcoming", "upcoming", "upcoming", "upcoming"]);
  assert.equal(p.daily.minutes, 165); assert.equal(p.daily.percent, 69); assert.equal(p.daily.remaining, 75);
  assert.equal(p.weekly.minutes, 655); assert.equal(p.streak, 4); // Oct 3,4,5,6 met; today not yet met
  const met = goalProgress({ goal: { daily_minutes: 100, weekly_minutes: 700 }, minutesByDate: { ...mins, "2026-10-07": 100 }, today: "2026-10-07", weekDates: week, shift: clock.shift });
  assert.equal(met.days[2].status, "met"); assert.equal(met.streak, 5);
  const gap = goalProgress({ goal: { daily_minutes: 240, weekly_minutes: 1680 }, minutesByDate: { "2026-10-05": 10, "2026-10-06": 300 }, today: "2026-10-07", weekDates: week, shift: clock.shift });
  assert.equal(gap.days[0].status, "missed"); assert.equal(gap.streak, 1);
  const none = goalProgress({ goal: null, minutesByDate: mins, today: "2026-10-07", weekDates: week, shift: clock.shift });
  assert.equal(none.goal, null); assert.equal(none.streak, 0); assert.equal(none.daily.percent, 0); assert.equal(none.days[0].status, "none");
  const over = goalProgress({ goal: { daily_minutes: 60, weekly_minutes: 420 }, minutesByDate: { "2026-10-07": 600 }, today: "2026-10-07", weekDates: week, shift: clock.shift });
  assert.equal(over.daily.percent, 100); assert.equal(over.daily.remaining, 0);
});
test("goal validation", () => {
  assert.equal(validateGoals(240, 1680), null);
  for (const [d, w] of [[5, 100], [1000, 5000], [240, 100], [240, 7000], [2.5, 100], ["240", 1680]]) assert.ok(validateGoals(d, w), `${d}/${w}`);
});

// ---- Planner ----
const subj = (o) => ({ subject: "X", minutesToday: 0, daysSinceStudied: 0, studiedBefore: true, avgPercentage: null, syllabusPct: null, nextExamDays: null, plannedToday: false, ...o });
test("planner: an exam in 3 days outranks a neglected subject; reasons are explained", () => {
  const out = buildSuggestions({ subjects: [subj({ subject: "Physics", nextExamDays: 3, daysSinceStudied: 1 }), subj({ subject: "Maths", daysSinceStudied: 6 }), subj({ subject: "Chem", daysSinceStudied: 0 })], goal: { dailyMinutes: 240, todayMinutes: 60 } });
  assert.equal(out.items[0].subject, "Physics");
  assert.ok(out.items[0].reasons.includes("Exam in 3 days"));
  assert.equal(out.items.find(i => i.subject === "Maths").reasons[0], "Not studied for 6 days");
  assert.equal(out.remainingMinutes, 180);
  const total = out.items.reduce((s, i) => s + i.minutes, 0);
  assert.ok(total >= 150 && total <= 210, `allocated ${total}`);
  assert.ok(out.items.every(i => i.minutes >= 15 && i.minutes <= 120 && i.minutes % 5 === 0));
});
test("planner: weak scores, syllabus left, plan slot, done-today penalty, homework item, goal reached, empty data", () => {
  assert.ok(scoreSubject(subj({ avgPercentage: 40 })).score > scoreSubject(subj({ avgPercentage: 90 })).score);
  assert.ok(scoreSubject(subj({ syllabusPct: 10 })).score > scoreSubject(subj({ syllabusPct: 100 })).score);
  assert.ok(scoreSubject(subj({ plannedToday: true })).score >= 15);
  assert.ok(scoreSubject(subj({ nextExamDays: 2, minutesToday: 60 })).score < scoreSubject(subj({ nextExamDays: 2 })).score);
  assert.equal(scoreSubject(subj({ nextExamDays: -1 })).score, 0);
  assert.equal(scoreSubject(subj({ nextExamDays: 0 })).reasons[0], "Exam today");
  assert.equal(scoreSubject(subj({ nextExamDays: 1 })).reasons[0], "Exam tomorrow");
  const hw = buildSuggestions({ subjects: [subj({ subject: "Bio", daysSinceStudied: 2 })], homework: { dueSoon: 2, overdue: 1 }, goal: { dailyMinutes: null, todayMinutes: 0 } });
  assert.equal(hw.items[0].type, "homework"); assert.equal(hw.items[0].title, "Finish 2 pending homework"); assert.deepEqual(hw.items[0].reasons, ["1 overdue"]);
  const done = buildSuggestions({ subjects: [subj({ subject: "Bio", daysSinceStudied: 4 })], goal: { dailyMinutes: 120, todayMinutes: 150 } });
  assert.equal(done.goalReached, true); assert.match(done.hint, /already reached/); assert.ok(done.items[0].minutes <= 30);
  const empty = buildSuggestions({ subjects: [], goal: { dailyMinutes: 120, todayMinutes: 0 } });
  assert.deepEqual(empty.items, []); assert.match(empty.hint, /Log a study session/);
  const never = scoreSubject(subj({ daysSinceStudied: null, studiedBefore: false }));
  assert.deepEqual(never.reasons, ["Not studied yet"]);
});

// ---- Calendar ----
test("calendar merges classes, homework, tests, events, holidays and exams; holidays flag classes", () => {
  const classes = [{ id: 1, name: "Physics 11", institute_id: 9 }, { id: 2, name: "Chem 11", institute_id: 9 }];
  const cal = buildCalendar({
    from: "2026-10-05", to: "2026-10-11", clock, classes,
    schedule: [{ id: 1, class_id: 1, weekday: 3, start_time: "17:00", end_time: "18:00", subject: "Physics", room: "R1" }, { id: 2, class_id: 2, weekday: 4, start_time: "16:00", end_time: "17:00", subject: "Chem", room: "" }],
    homework: [{ id: 5, class_id: 1, title: "HW1", due_date: "2026-10-08" }, { id: 6, class_id: 1, title: "Old", due_date: "2026-09-01" }],
    tests: [{ id: 7, class_id: 2, title: "Unit test", subject: "Chem", test_date: "2026-10-09" }],
    events: [
      { id: 1, kind: "holiday", title: "Diwali", description: "", start_date: "2026-10-08", end_date: "2026-10-09", start_time: null, end_time: null, institute_id: 9, class_ids: [] },
      { id: 2, kind: "event", title: "Quiz night", description: "", start_date: "2026-10-10", end_date: "2026-10-10", start_time: "18:00", end_time: null, institute_id: null, class_ids: [1] },
      { id: 3, kind: "event", title: "Other class", description: "", start_date: "2026-10-10", end_date: "2026-10-10", start_time: null, end_time: null, institute_id: null, class_ids: [99] },
    ],
    exams: [{ id: 1, subject: "Maths", title: "Board exam", exam_date: "2026-10-11" }],
  });
  const kinds = cal.map(e => e.kind);
  assert.deepEqual(kinds.sort(), ["class", "class", "event", "exam", "holiday", "holiday", "homework", "test"].sort());
  assert.equal(cal.find(e => e.title === "HW1").date, "2026-10-08");
  assert.ok(!cal.some(e => e.title === "Old" || e.title === "Other class"));
  assert.equal(cal.find(e => e.kind === "class" && e.title === "Chem").on_holiday, true);   // Thu Oct 8? weekday 4 = Thu 2026-10-08 -> holiday
  assert.equal(cal.find(e => e.kind === "class" && e.title === "Physics").on_holiday, false); // Wed Oct 7 not a holiday
  assert.equal(cal.filter(e => e.kind === "holiday").length, 2);
  assert.deepEqual(cal.map(e => e.date), [...cal.map(e => e.date)].sort());
});

test("weekly trend compares COMPLETED days with the same days last week (not a part-week with a whole week)", async () => {
  const db = await createTestDb(); await db.script("CREATE TABLE study_logs (student_id INTEGER, minutes INTEGER, study_date DATE)");
  const log = (date, minutes) => db.exec("INSERT INTO study_logs(student_id,minutes,study_date) VALUES(1,$1,$2)", [minutes, date]);
  for (const d of ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]) await log(d, 300); // last week: 300/day
  await log("2026-10-05", 360); await log("2026-10-06", 360); await log("2026-10-07", 40); // this week Mon-Tue strong, Wednesday only just started
  const wed = createClock("Asia/Kolkata", () => new Date("2026-10-07T08:00:00Z")); const r = await weekTrend(db, wed, 1);
  assert.deepEqual([r.current, r.previous, r.days, r.trend], [720, 600, 2, "improving"], "today's partial day is ignored");
  const mon = createClock("Asia/Kolkata", () => new Date("2026-10-05T08:00:00Z")); assert.equal((await weekTrend(db, mon, 1)).trend, "stable", "nothing is complete on a Monday");
  const sun = createClock("Asia/Kolkata", () => new Date("2026-10-11T08:00:00Z")); assert.equal((await weekTrend(db, sun, 1)).days, 6);
  assert.equal((await weekTrend(db, wed, 99)).trend, "stable", "no data, no trend");
});
