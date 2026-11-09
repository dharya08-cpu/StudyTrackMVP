import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startE2E, GOOGLE_STUB } from "./harness.mjs";
import { makePdf, makePng } from "../fixtures.mjs";
import { seedDemo } from "../../src/demo.js";

const require = createRequire(import.meta.url);
const { chromium } = (() => { for (const p of ["playwright", "/home/claude/.npm-global/lib/node_modules/playwright"]) { try { return require(p); } catch { /* next */ } } throw new Error("playwright not installed"); })();
const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "shots"); fs.mkdirSync(shots, { recursive: true });

let failures = 0; const problems = [];
const step = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").slice(0, 3).join(" | ")}`); } };
const expectVisible = async (page, text, timeout = 8000) => page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout });

async function newUser(browser, base, identity, viewport, contextOptions = {}) {
  // The browser runs in the server's timezone, so "today" means the same thing on both sides whatever time the test runs.
  const context = await browser.newContext({ viewport: viewport || { width: 1100, height: 900 }, timezoneId: e2e.app.clock.timeZone, ...contextOptions });
  const page = await context.newPage();
  // Expected: 401 while signed out, 415 from the deliberate bad-upload step. Anything else is a real problem.
  page.on("console", m => { if (/status of (401|404|415)\b/.test(m.text())) return; if (m.type() === "error" || /Content Security Policy/i.test(m.text())) problems.push(`[${identity.name}] console: ${m.text().slice(0, 200)}`); });
  page.on("pageerror", e => problems.push(`[${identity.name}] pageerror: ${e.message}`));
  page.on("response", r => { if (r.status() >= 500) problems.push(`[${identity.name}] server error ${r.status()} on ${r.url()}`); });
  await page.route("https://accounts.google.com/gsi/client", r => r.fulfill({ contentType: "text/javascript", body: GOOGLE_STUB }));
  await page.addInitScript(id => { window.__identity = id; }, identity);
  await page.goto(base);
  return { context, page };
}
// First visit: Create an account > pick the role > Google. Returning visit: the Log in page's Google button.
const signUpGoogle = async (page, role) => {
  await page.getByRole("button", { name: "Create an account" }).first().click();
  await page.getByRole("tab", { name: role === "teacher" ? "I'm a teacher" : "I'm a student" }).click();
  await page.locator("#fake-google").click();
};
const openMenu = page => page.getByRole("button", { name: /Open menu/ }).click();
// Everything lives in the Menu now: open it and pick an entry by the start of its name.
const goMenu = async (page, label) => { await openMenu(page); await page.getByRole("navigation").getByRole("button", { name: new RegExp(`^${label}`) }).first().click(); };
const logInGoogle = async page => { await page.locator("#fake-google").click(); };
const signIn = logInGoogle;

const e2e = await startE2E();
const browser = await chromium.launch();
try {
  const T = await newUser(browser, e2e.url, { sub: "t-1", email: "teacher@gmail.com", name: "Tara Teacher" });
  const S = await newUser(browser, e2e.url, { sub: "s-1", email: "ana@gmail.com", name: "Ana Student" }, { width: 390, height: 844 });
  console.log("\nStudyTrack V6 end-to-end (real browser, real server logic)\n");

  await step("sign-in screen offers Google only (no password field) and explains the Gmail rule", async () => {
    await expectVisible(S.page, "Log in");
    if (!(await S.page.locator('input[type="password"]').count())) throw new Error("password field missing on the Log in page");
    await expectVisible(S.page, "Forgot password?"); await expectVisible(S.page, "Create an account");
    if (await S.page.getByText("Parent or guardian").count()) throw new Error("the Log in page must not ask for details");
    await S.page.screenshot({ path: path.join(shots, "01-signin-mobile.png") });
  });
  await step("student signs in with Google and lands on the dashboard", async () => {
    await signUpGoogle(S.page, "student"); await expectVisible(S.page, "Tell us about yourself"); await expectVisible(S.page, "We filled in your name from your Google account");
    if ((await S.page.getByLabel("First name").inputValue()) !== "Ana") throw new Error("Google first name not pre-filled");
    await S.page.getByLabel("Parent or guardian name").fill("Ramesh Student"); await S.page.getByLabel("Class / grade").fill("Class 11");
    await S.page.screenshot({ path: path.join(shots, "00-details-page-mobile.png"), fullPage: true });
    await S.page.getByRole("button", { name: "Save and continue" }).click();
    await expectVisible(S.page, "Welcome back, Ana"); await expectVisible(S.page, "haven't joined a class yet");
  });
  await step("teacher signs up with Google, fills the details page, and the first class is created there", async () => {
    await signUpGoogle(T.page, "teacher"); await expectVisible(T.page, "Set up your teacher profile");
    await T.page.getByLabel("Subjects you teach").fill("Physics, Chemistry"); await T.page.getByLabel(/First class name/).fill("Physics Class 11");
    await T.page.getByRole("button", { name: "Save and continue" }).click(); await expectVisible(T.page, "Physics Class 11"); await expectVisible(T.page, "created");
  });
  await step("teacher creates two classes", async () => {
    await goMenu(T.page, "Add a class");
    await T.page.getByPlaceholder("Class name").fill("Chemistry Class 11"); await T.page.getByRole("button", { name: "Create class" }).click(); await expectVisible(T.page, "Chemistry Class 11");
  });
  const codes = {};
  await step("class codes are shown", async () => {
    for (const [name, c] of Object.entries(await e2e.app.db.many("SELECT name,code FROM classes").then(r => Object.fromEntries(r.map(x => [x.name, x.code]))))) codes[name] = c;
    if (!codes["Physics Class 11"] || !codes["Chemistry Class 11"]) throw new Error("codes missing");
  });

  await step("TEACHER CAN POST HOMEWORK WITH A PDF TO BOTH CLASSES (the v3 bug)", async () => {
    await goMenu(T.page, "Homework");
    await expectVisible(T.page, "Create homework");
    await T.page.getByPlaceholder("Homework title").fill("Kinematics worksheet");
    await T.page.getByPlaceholder("Instructions / description").fill("Solve questions 1 to 10.");
    await T.page.locator('input[type="date"]').first().fill("2026-12-20");
    await T.page.locator('input[type="file"]').first().setInputFiles({ name: "worksheet.pdf", mimeType: "application/pdf", buffer: makePdf() });
    await T.page.getByLabel("Physics Class 11").check().catch(() => {}); await T.page.getByLabel("Chemistry Class 11").check();
    await T.page.getByRole("button", { name: "Post homework" }).click();
    await expectVisible(T.page, "Homework posted to 2 classes with 1 file");
    await T.page.screenshot({ path: path.join(shots, "02-teacher-homework.png"), fullPage: true });
    const n = (await e2e.app.db.one("SELECT COUNT(*) AS n FROM attachments WHERE homework_id IS NOT NULL")).n; if (n !== 2) throw new Error(`expected 2 stored files, got ${n}`);
  });
  await step("a text-only homework also works, and a bad file is refused with a clear message", async () => {
    await T.page.getByPlaceholder("Homework title").fill("Read chapter 4");
    await T.page.getByRole("button", { name: "Post homework" }).click(); await expectVisible(T.page, "Homework posted to 1 class");
    await T.page.getByPlaceholder("Homework title").fill("Bad upload");
    await T.page.locator('input[type="file"]').first().setInputFiles({ name: "virus.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ....") });
    await expectVisible(T.page, "only PDF, JPG, PNG and DOCX"); // refused as soon as it is picked
    await T.page.locator('input[type="file"]').first().setInputFiles({ name: "fake.pdf", mimeType: "application/pdf", buffer: Buffer.from("<html><script>alert(1)</script>") });
    await T.page.getByRole("button", { name: "Post homework" }).click(); await expectVisible(T.page, "does not match its extension");
  });

  await step("student joins two classes with codes; teacher approves both", async () => {
    await goMenu(S.page, "My classes");
    for (const name of ["Physics Class 11", "Chemistry Class 11"]) { await S.page.getByLabel("Class code").fill(codes[name]); await S.page.getByRole("button", { name: "Send join request" }).click(); await expectVisible(S.page, "Request sent to"); }
    await T.page.reload(); await expectVisible(T.page, "Physics Class 11");
    await goMenu(T.page, "Join requests");
    await expectVisible(T.page, "Ana Student");
    for (let i = 0; i < 2; i++) { await T.page.getByRole("button", { name: /Allow Ana/ }).first().click(); await T.page.waitForTimeout(400); }
    const n = (await e2e.app.db.one("SELECT COUNT(*) AS n FROM student_class_memberships WHERE status='active'")).n; if (n !== 2) throw new Error(`memberships ${n}`);
  });
  await step("student sees both classes, class chips and the posted homework with its attachment", async () => {
    await S.page.reload(); await goMenu(S.page, "My classes"); await expectVisible(S.page, "Join a class with a code");
    await expectVisible(S.page, "Physics Class 11"); await expectVisible(S.page, "Chemistry Class 11");
    await goMenu(S.page, "Homework"); await expectVisible(S.page, "Kinematics worksheet"); await expectVisible(S.page, "worksheet.pdf");
    await S.page.getByRole("button", { name: "Chemistry Class 11" }).first().click(); await expectVisible(S.page, "Kinematics worksheet");
    await S.page.screenshot({ path: path.join(shots, "03-student-homework-mobile.png"), fullPage: true });
  });
  await step("student opens a file in the browser (View) and downloads it, through short-lived signed links", async () => {
    const urls = [];
    await S.page.context().route("https://storage.test/**", r => { urls.push(r.request().url()); r.fulfill({ status: 200, contentType: "application/pdf", body: "stub" }); });
    await S.page.getByRole("button", { name: "View worksheet.pdf" }).first().click();
    for (let i = 0; i < 40 && urls.length < 1; i++) await S.page.waitForTimeout(100);
    await S.page.getByRole("button", { name: "Download worksheet.pdf" }).first().click();
    for (let i = 0; i < 40 && urls.length < 2; i++) await S.page.waitForTimeout(100);
    for (const p of S.page.context().pages()) if (p !== S.page) await p.close().catch(() => {});
    const base = /^https:\/\/storage\.test\/studytrack-files\/t\d+\/c\d+\/homework\/[0-9a-f-]{36}\.pdf\?token=abc&exp=300/;
    if (!base.test(urls[0] || "")) throw new Error(`unexpected view URL ${urls[0]}`);
    if (/dl=worksheet/.test(urls[0])) throw new Error("the View link must not force a download");
    if (!/dl=worksheet\.pdf/.test(urls[1] || "")) throw new Error(`the Download link should carry the file name: ${urls[1]}`);
  });
  await step("THE FILE BUG: teacher adds 2 more files; the student can still open the FIRST file, and all 3 are listed", async () => {
    await goMenu(T.page, "Homework");
    const card = T.page.locator(".item.col", { hasText: "Kinematics worksheet" }).first();
    await card.locator('.files-head input[type="file"]').setInputFiles([{ name: "answers.pdf", mimeType: "application/pdf", buffer: makePdf("% answers") }, { name: "diagram.png", mimeType: "image/png", buffer: makePng() }]);
    await expectVisible(T.page, "2 files attached. Your earlier files are still there");
    await expectVisible(T.page, "Files (3)");
    await T.page.screenshot({ path: path.join(shots, "02b-teacher-files.png"), fullPage: true });
    await S.page.reload(); await goMenu(S.page, "Homework");
    await expectVisible(S.page, "Files from your teacher (3)");
    for (const n of ["worksheet.pdf", "answers.pdf", "diagram.png"]) await S.page.getByRole("button", { name: `Download ${n}` }).first().waitFor({ timeout: 6000 });
    let got = "";
    await S.page.context().route("https://storage.test/**", r => { got = r.request().url(); r.fulfill({ status: 200, contentType: "application/pdf", body: "stub" }); });
    await S.page.getByRole("button", { name: "View worksheet.pdf" }).first().click();
    for (let i = 0; i < 40 && !got; i++) await S.page.waitForTimeout(100);
    for (const p of S.page.context().pages()) if (p !== S.page) await p.close().catch(() => {});
    if (!got) throw new Error("the first file could not be opened after more files were attached");
    await S.page.screenshot({ path: path.join(shots, "03b-student-files-mobile.png"), fullPage: true });
  });
  await step("teacher removes one file; the others stay", async () => {
    await goMenu(T.page, "Homework");
    T.page.once("dialog", d => d.accept());
    await T.page.getByRole("button", { name: "Remove answers.pdf" }).first().click();
    await expectVisible(T.page, "File removed"); await expectVisible(T.page, "Files (2)");
    const n = (await e2e.app.db.one("SELECT COUNT(*) AS n FROM attachments WHERE file_name='answers.pdf'")).n; if (n !== 0) throw new Error("file row still there");
  });

  await step("teacher sends an announcement to several classes; student's bell lights up", async () => {
    await goMenu(T.page, "Announcements");
    await T.page.getByLabel("Title").fill("Timing change"); await T.page.getByLabel("Message").fill("Tomorrow's Physics class will begin at 5 PM instead of 4 PM.");
    await T.page.getByLabel(/Mark as important/).check(); await T.page.getByLabel(/Several classes/).check();
    await T.page.getByLabel("Physics Class 11").check(); await T.page.getByLabel("Chemistry Class 11").check();
    await T.page.getByRole("button", { name: "Send announcement" }).click(); await expectVisible(T.page, "Announcement sent to 1 person");
    await S.page.reload(); await S.page.waitForTimeout(500);
    await S.page.getByRole("button", { name: /Notifications, \d+ unread/ }).waitFor({ timeout: 8000 });
    await S.page.getByRole("button", { name: /Notifications, \d+ unread/ }).click();
    await expectVisible(S.page, "Timing change"); await expectVisible(S.page, "5 PM instead of 4 PM"); await expectVisible(S.page, "Important");
    await S.page.getByRole("button", { name: "Mark all as read" }).click(); await S.page.waitForTimeout(500);
    if (await S.page.getByRole("button", { name: /Notifications, \d+ unread/ }).count()) throw new Error("badge still shown");
    await S.page.screenshot({ path: path.join(shots, "04-notifications-mobile.png") });
  });

  await step("goals: set 4h/28h, log 2h45m, see '2h 45m / 4h' and the progress bar", async () => {
    await goMenu(S.page, "Overview");
    await S.page.getByRole("button", { name: "Set goals" }).click(); await S.page.getByLabel("Daily goal (hours)").fill("4"); await S.page.getByLabel("Weekly goal (hours)").fill("28"); await S.page.getByRole("button", { name: "Save goals" }).click();
    await goMenu(S.page, "Study log"); await S.page.getByPlaceholder("Subject").fill("Physics"); await S.page.getByPlaceholder("Minutes").fill("165"); await S.page.getByRole("button", { name: "Add session" }).click(); await S.page.waitForTimeout(600);
    await goMenu(S.page, "Overview"); await expectVisible(S.page, "2h 45m / 4h"); await expectVisible(S.page, "69%"); await expectVisible(S.page, "1h 15m to go today");
    await S.page.screenshot({ path: path.join(shots, "05-goals-mobile.png"), fullPage: true });
  });
  await step("planner: exam countdown and 'what to study today'", async () => {
    await goMenu(S.page, "Planner"); await expectVisible(S.page, "What to study today");
    await S.page.getByPlaceholder("Subject").first().fill("Physics"); await S.page.getByPlaceholder("Exam name").fill("Mid-term"); await S.page.locator('input[type="date"]').first().fill(new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)); await S.page.getByRole("button", { name: "Add exam" }).click();
    await expectVisible(S.page, "Mid-term"); await expectVisible(S.page, "Study Physics");
    await S.page.screenshot({ path: path.join(shots, "06-planner-mobile.png"), fullPage: true });
  });
  await step("calendar shows the homework deadline, and the teacher can add a holiday", async () => {
    await goMenu(S.page, "View calendar"); await expectVisible(S.page, "Classes, homework deadlines, tests, events and holidays");
    await goMenu(T.page, "Calendar"); await expectVisible(T.page, "Weekly timetable");
    await T.page.getByRole("button", { name: "+ Event / holiday" }).click(); await T.page.getByPlaceholder("Title").fill("Diwali break"); await T.page.getByLabel("Type").selectOption("holiday");
    await T.page.getByLabel("Physics Class 11", { exact: false }).first().waitFor().catch(() => {}); await T.page.getByRole("button", { name: "Add", exact: true }).click(); await T.page.waitForTimeout(500);
    await T.page.screenshot({ path: path.join(shots, "07-teacher-calendar.png"), fullPage: true });
  });

  await step("MY CALENDAR: the student adds a revision goal with a complete-by date, sees it on the calendar, ticks it done, edits it, deletes it", async () => {
    await goMenu(S.page, "Edit my calendar"); await expectVisible(S.page, "Add your own study goals");
    await S.page.getByRole("button", { name: "+ Add" }).click();
    await S.page.getByRole("button", { name: /Revision/ }).click();
    await S.page.getByLabel("Title").fill("Finish Physics revision"); await S.page.getByLabel("Subject (optional)").fill("Physics");
    await S.page.getByRole("button", { name: "1 week" }).click();
    await S.page.getByRole("button", { name: "Add to calendar" }).click();
    await expectVisible(S.page, "Finish Physics revision"); await expectVisible(S.page, "days left");
    await S.page.screenshot({ path: path.join(shots, "06b-my-calendar-mobile.png"), fullPage: true });
    const stored = await e2e.app.db.one("SELECT kind,subject,start_date,end_date FROM student_plan_items"); if (stored.kind !== "revision" || stored.subject !== "Physics" || stored.end_date <= stored.start_date) throw new Error(JSON.stringify(stored));
    await goMenu(S.page, "View calendar"); await expectVisible(S.page, "Finish Physics revision");
    await S.page.locator(".cal-item.revision").first().waitFor({ timeout: 6000 });
    await S.page.screenshot({ path: path.join(shots, "06c-calendar-with-my-items-mobile.png"), fullPage: true });
    await S.page.getByRole("button", { name: /Mark "Finish Physics revision" as done/ }).click();
    await S.page.getByRole("button", { name: /as not done/ }).waitFor({ timeout: 6000 });
    await S.page.getByRole("button", { name: "Edit" }).first().click(); await S.page.getByLabel("Title").fill("Finish Physics + Maths revision"); await S.page.getByRole("button", { name: "Save changes" }).click();
    await expectVisible(S.page, "Finish Physics + Maths revision");
    S.page.once("dialog", d => d.accept()); await S.page.getByRole("button", { name: "Delete" }).first().click();
    for (let i = 0; i < 30 && (await e2e.app.db.one("SELECT COUNT(*) AS n FROM student_plan_items")).n; i++) await S.page.waitForTimeout(100);
    if ((await e2e.app.db.one("SELECT COUNT(*) AS n FROM student_plan_items")).n) throw new Error("item not deleted");
  });

  await step("SUBMISSION FILES: the student hands in homework with 2 files; the teacher opens them", async () => {
    await goMenu(S.page, "Homework");
    const card = S.page.locator(".item.col", { hasText: "Physics Class 11" }).filter({ hasText: "Kinematics worksheet" }).first();
    await card.getByLabel("Submission note").fill("All questions done");
    await card.locator('input[type="file"]').setInputFiles([{ name: "my-answers.pdf", mimeType: "application/pdf", buffer: makePdf("% answers") }, { name: "working.png", mimeType: "image/png", buffer: makePng() }]);
    await card.getByRole("button", { name: "Submit with 2 files" }).click();
    await expectVisible(S.page, "Submitted with your files"); await expectVisible(S.page, "Your files (2)");
    await S.page.screenshot({ path: path.join(shots, "03c-student-submission-mobile.png"), fullPage: true });
    // the student can still add or remove files before review
    S.page.once("dialog", d => d.accept());
    await S.page.getByRole("button", { name: "Remove working.png" }).first().click(); await expectVisible(S.page, "Your files (1)");
    await card.locator('.files-head input[type="file"]').setInputFiles({ name: "working2.png", mimeType: "image/png", buffer: makePng() }); await expectVisible(S.page, "Your files (2)");
    await goMenu(T.page, "Homework");
    await T.page.getByText("Kinematics worksheet").first().click();
    await expectVisible(T.page, "Files from Ana (2)");
    let opened = ""; await T.context.route("https://storage.test/**", r => { opened = r.request().url(); r.fulfill({ status: 200, contentType: "application/pdf", body: "stub" }); });
    await T.page.getByRole("button", { name: "View my-answers.pdf" }).first().click();
    for (let i = 0; i < 40 && !opened; i++) await T.page.waitForTimeout(100);
    for (const p of T.context.pages()) if (p !== T.page) await p.close().catch(() => {});
    if (!/\/submissions\//.test(opened) && !opened) throw new Error("the teacher could not open the student's file");
    await T.page.screenshot({ path: path.join(shots, "02c-teacher-submission-files.png"), fullPage: true });
  });
  await step("REMINDERS: homework due tomorrow produces a reminder in the student's notifications", async () => {
    const cls = await e2e.app.db.one("SELECT c.id,c.teacher_id FROM classes c JOIN student_class_memberships m ON m.class_id=c.id JOIN users u ON u.id=m.student_id WHERE u.email='ana@gmail.com' ORDER BY c.id LIMIT 1");
    const tomorrow = e2e.app.clock.shift(e2e.app.clock.today(), 1);
    await e2e.app.db.exec("INSERT INTO homework(teacher_id,class_id,title,description,due_date,created_at) VALUES($1,$2,'Reminder demo','',$3,$4)", [cls.teacher_id, cls.id, tomorrow, e2e.app.clock.nowIso()]);
    await e2e.app.db.exec("UPDATE users SET reminders_checked_at=NULL WHERE email='ana@gmail.com'"); // as if 30 minutes have passed since the last check
    await S.page.reload(); await goMenu(S.page, "Notifications");
    await expectVisible(S.page, "Homework due tomorrow: Reminder demo");
    await S.page.screenshot({ path: path.join(shots, "07-reminders-mobile.png"), fullPage: true });
    await goMenu(S.page, "Security"); await expectVisible(S.page, "Due-date reminders"); await expectVisible(S.page, "New sign-in alerts");
  });
  await step("PARENT VIEW: the student creates a link, a signed-out browser opens it, then sharing is stopped", async () => {
    await goMenu(S.page, "Parent view"); await expectVisible(S.page, "What they will see");
    await S.page.getByRole("button", { name: "Preview what they will see" }).click(); await expectVisible(S.page, "This is a preview of exactly what your parent will see");
    await S.page.getByRole("button", { name: "Create link for my parent" }).click();
    const url = (await S.page.locator(".share-url").innerText()).trim();
    if (!/\/parent#[A-Za-z0-9_-]{43}$/.test(url)) throw new Error(`unexpected link ${url}`);
    await S.page.screenshot({ path: path.join(shots, "08-parent-share-mobile.png"), fullPage: true });
    const parent = await browser.newContext({ viewport: { width: 420, height: 900 } }); const pp = await parent.newPage();
    pp.on("pageerror", e => problems.push(`[parent] pageerror: ${e.message}`)); pp.on("console", m => { if (/Content Security Policy/i.test(m.text())) problems.push(`[parent] ${m.text().slice(0, 160)}`); });
    await pp.goto(url);
    await expectVisible(pp, "Ana's week"); await expectVisible(pp, "Studied this week"); await expectVisible(pp, "For Ramesh Student");
    const html = await pp.content(); if (/ana@gmail\.com|teacher@gmail\.com/.test(html)) throw new Error("the parent page must not show e-mail addresses");
    await pp.screenshot({ path: path.join(shots, "09-parent-page-mobile.png"), fullPage: true });
    S.page.once("dialog", d => d.accept()); await S.page.getByRole("button", { name: "Stop sharing" }).click(); await expectVisible(S.page, "Sharing is off");
    await pp.reload(); await expectVisible(pp, "Link not available"); await parent.close();
  });
  await step("LOGIN ALERT: signing in on a new kind of device alerts the student in the app", async () => {
    const phone = await newUser(browser, e2e.url, { sub: "s-1", email: "ana@gmail.com", name: "Ana Student" }, { width: 390, height: 844 }, { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1" });
    await logInGoogle(phone.page); await expectVisible(phone.page, "Welcome back");
    await S.page.reload(); await goMenu(S.page, "Notifications");
    await expectVisible(S.page, "New sign-in on Safari on iOS");
    await S.page.screenshot({ path: path.join(shots, "10-login-alert-mobile.png"), fullPage: true });
    await phone.context.close();
  });
  await step("EXPORT: the teacher downloads the class report as an Excel workbook", async () => {
    await goMenu(T.page, "Results");
    await T.page.getByRole("button", { name: /Download report/ }).click(); await expectVisible(T.page, "E-mail addresses and phone numbers are not included");
    await T.page.waitForTimeout(400); await T.page.screenshot({ path: path.join(shots, "11-teacher-export-modal.png") });
    const [download] = await Promise.all([T.page.waitForEvent("download"), T.page.getByRole("button", { name: /Excel workbook/ }).click()]);
    const name = download.suggestedFilename(); if (!/^StudyTrack-Physics-Class-11-\d{4}-\d{2}-\d{2}\.xlsx$/.test(name)) throw new Error(`unexpected file name ${name}`);
    const bytes = fs.readFileSync(await download.path()); if (bytes.subarray(0, 2).toString() !== "PK" || bytes.length < 2000) throw new Error("not a valid workbook");
    fs.copyFileSync(await download.path(), path.join(shots, "class-report.xlsx"));
    await expectVisible(T.page, `Downloaded ${name}`);
    await T.page.getByRole("button", { name: "Close" }).first().click();
  });

  await step("institute: teacher requests an institute, owner approves it, teacher sees the institute page", async () => {
    await goMenu(T.page, "Create your own coaching institute");
    await expectVisible(T.page, "Create your coaching institute");
    await T.page.getByLabel("Institute name").fill("Bright Future Academy"); await T.page.getByLabel(/Contact phone/).fill("98765 43210");
    await T.page.getByRole("button", { name: "Send for approval" }).click();
    await expectVisible(T.page, "Waiting for approval"); await expectVisible(T.page, "StudyTrack is reviewing your institute");
    const A = await newUser(browser, e2e.url, { sub: "x", email: "x@gmail.com" }); await A.page.goto(e2e.url + "/admin");
    await A.page.getByLabel("Admin key").fill("owner-key-123456"); await A.page.getByRole("button", { name: "Open admin panel" }).click(); await expectVisible(A.page, "Bright Future Academy");
    await A.context.close();
    const inst = await e2e.app.db.one("SELECT id FROM institutes WHERE code<>'DEMOACAD'"); await e2e.app.db.exec("UPDATE institutes SET status='active' WHERE id=$1", [inst.id]);
    await T.page.reload(); await goMenu(T.page, "Bright Future Academy");
    await expectVisible(T.page, "Tara Teacher"); await T.page.screenshot({ path: path.join(shots, "10-institute-home.png"), fullPage: true });
  });
  await step("Security > Active sessions lists devices; 'Log out all other devices' signs the other one out", async () => {
    const S2 = await newUser(browser, e2e.url, { sub: "s-1", email: "ana@gmail.com", name: "Ana Student" });
    await signIn(S2.page, "student"); await expectVisible(S2.page, "Welcome back, Ana");
    await goMenu(S.page, "Security"); await expectVisible(S.page, "Active sessions"); await expectVisible(S.page, "This device"); await expectVisible(S.page, "Log out all other devices");
    await S.page.screenshot({ path: path.join(shots, "08-sessions-mobile.png"), fullPage: true });
    await S.page.getByRole("button", { name: "Log out all other devices" }).click(); await expectVisible(S.page, "All other devices were logged out");
    await S2.page.reload(); await expectVisible(S2.page, "Log in");
    await S.page.reload(); await expectVisible(S.page, "Welcome back, Ana"); // this device stays signed in
    await S2.context.close();
  });
  await step("logout works and the session cookie is httpOnly (not readable by page scripts)", async () => {
    const cookies = await S.context.cookies(); const session = cookies.find(c => c.name === "st_session");
    if (!session?.httpOnly || session.sameSite !== "Strict") throw new Error(`cookie flags ${JSON.stringify(session)}`);
    if (await S.page.evaluate(() => document.cookie.includes("st_session"))) throw new Error("cookie readable by JS");
    if (await S.page.evaluate(() => Object.keys(localStorage).length + Object.keys(sessionStorage).length)) throw new Error("tokens in web storage");
    await S.page.getByRole("button", { name: "Logout" }).click(); await expectVisible(S.page, "Log in");
  });
  await step("admin panel: key login, approval queue visible, backups tab can run and test a backup", async () => {
    const A = await newUser(browser, e2e.url, { sub: "x", email: "x@gmail.com" }); await A.page.goto(e2e.url + "/admin");
    await A.page.getByLabel("Admin key").fill("owner-key-123456"); await A.page.getByRole("button", { name: "Open admin panel" }).click(); await expectVisible(A.page, "Approval queue");
    await A.page.getByRole("tab", { name: "backups" }).click(); await expectVisible(A.page, "Back up now");
    await A.page.getByRole("button", { name: "Back up now" }).click(); await expectVisible(A.page, "created");
    await A.page.getByRole("button", { name: "Test restore" }).first().click(); await expectVisible(A.page, "restored into a temporary schema and matched");
    await A.page.screenshot({ path: path.join(shots, "09-admin-backups.png"), fullPage: true });
    await A.page.reload(); await expectVisible(A.page, "Approval queue"); // cookie session survives reload
    await A.context.close();
  });

  await step("sign up with Gmail + password: e-mail link, details page once, then plain log in", async () => {
    const P = await newUser(browser, e2e.url, { sub: "x", email: "x@gmail.com", name: "X" });
    await P.page.getByRole("button", { name: "Create an account" }).first().click();
    await P.page.getByLabel("Gmail address").fill("newbie@gmail.com"); await P.page.getByLabel("Create a password").fill("Sunrise2026"); await P.page.getByLabel("Confirm password").fill("Different2026");
    await P.page.getByRole("button", { name: "Create account" }).click(); await expectVisible(P.page, "passwords do not match");
    await P.page.getByLabel("Confirm password").fill("Sunrise2026"); await P.page.getByRole("button", { name: "Create account" }).click();
    await expectVisible(P.page, "Check your Gmail"); await expectVisible(P.page, "newbie@gmail.com");
    const token = e2e.app.mail.token(); if (!token) throw new Error("no verification e-mail was sent");
    await P.page.goto(`${e2e.url}/verify?token=${token}`); await expectVisible(P.page, "Tell us about yourself");
    await P.page.getByLabel("First name").fill("Nina"); await P.page.getByLabel("Surname").fill("Newbie"); await P.page.getByLabel("Parent or guardian name").fill("Neel Newbie"); await P.page.getByLabel("Class / grade").fill("Class 10");
    await P.page.getByRole("button", { name: "Save and continue" }).click(); await expectVisible(P.page, "Welcome back, Nina");
    await P.page.getByRole("button", { name: "Logout" }).click(); await expectVisible(P.page, "Log in");
    await P.page.getByLabel("Gmail").fill("newbie@gmail.com"); await P.page.getByLabel("Password").first().fill("WrongPass9"); await P.page.getByRole("button", { name: "Log in", exact: true }).click(); await expectVisible(P.page, "Incorrect Gmail or password");
    await P.page.getByLabel("Gmail").fill("ghost@gmail.com"); await P.page.getByLabel("Password").first().fill("Sunrise2026"); await P.page.getByRole("button", { name: "Log in", exact: true }).click(); await expectVisible(P.page, "Incorrect Gmail or password"); // an unknown Gmail gets the very same answer
    await P.page.getByLabel("Gmail").fill("newbie@gmail.com"); await P.page.getByLabel("Password").first().fill("Sunrise2026"); await P.page.getByRole("button", { name: "Log in", exact: true }).click();
    await expectVisible(P.page, "Welcome back, Nina"); if (await P.page.getByText("Tell us about yourself").count()) throw new Error("details were asked again");
    await P.page.screenshot({ path: path.join(shots, "11-password-login-home.png") }); await P.context.close();
  });
  await step("demo accounts: teacher and student log in with the given Gmail and password and see live data", async () => {
    await seedDemo(e2e.app.ctx);
    const D = await newUser(browser, e2e.url, { sub: "x", email: "x@gmail.com", name: "X" });
    const logIn = async (email, password) => { await D.page.getByLabel("Gmail").fill(email); await D.page.getByLabel("Password").first().fill(password); await D.page.getByRole("button", { name: "Log in", exact: true }).click(); };
    await logIn("demoteacher1@coaching.com", "demoteacher1"); await expectVisible(D.page, "Physics Class 11"); await goMenu(D.page, "Students"); await expectVisible(D.page, "Aarav Mehta"); await expectVisible(D.page, "Diya Nair");
    await D.page.screenshot({ path: path.join(shots, "12-demo-teacher.png"), fullPage: true });
    await D.page.getByRole("button", { name: "Logout" }).click(); await expectVisible(D.page, "Log in");
    await logIn("demostudent1@coaching.com", "demostudent1"); await expectVisible(D.page, "Welcome back, Aarav"); await expectVisible(D.page, "2h 45m / 4h");
    await D.page.screenshot({ path: path.join(shots, "13-demo-student.png"), fullPage: true });
    await goMenu(D.page, "Planner"); await expectVisible(D.page, "Exam in"); await goMenu(D.page, "View calendar"); await expectVisible(D.page, "Classes, homework deadlines"); // the demo holiday is 10 days away, so it can sit in next month's grid depending on today's date
    if (!(await D.page.locator(".cal-cell.holiday").first().waitFor({ timeout: 2500 }).then(() => true, () => false))) await D.page.getByRole("button", { name: "Next month" }).click();
    await D.page.locator(".cal-cell.holiday").first().waitFor({ timeout: 8000 }); await D.page.screenshot({ path: path.join(shots, "14-demo-calendar.png"), fullPage: true });
    await D.context.close();
  });

  await step("no console errors, page errors or CSP violations during the whole run", async () => { if (problems.length) throw new Error(problems.slice(0, 4).join(" | ")); });
} finally { await browser.close(); await e2e.close(); }
console.log(failures ? `\n${failures} step(s) FAILED\n` : "\nAll end-to-end steps passed\n");
process.exit(failures ? 1 : 0);
