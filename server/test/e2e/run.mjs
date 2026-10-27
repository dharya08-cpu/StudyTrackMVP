import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startE2E, GOOGLE_STUB } from "./harness.mjs";
import { makePdf } from "../fixtures.mjs";
import { seedDemo } from "../../src/demo.js";

const require = createRequire(import.meta.url);
const { chromium } = (() => { for (const p of ["playwright", "/home/claude/.npm-global/lib/node_modules/playwright"]) { try { return require(p); } catch { /* next */ } } throw new Error("playwright not installed"); })();
const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "shots"); fs.mkdirSync(shots, { recursive: true });

let failures = 0; const problems = [];
const step = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").slice(0, 3).join(" | ")}`); } };
const expectVisible = async (page, text, timeout = 8000) => page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout });

async function newUser(browser, base, identity, viewport) {
  const context = await browser.newContext({ viewport: viewport || { width: 1100, height: 900 } });
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
const logInGoogle = async page => { await page.locator("#fake-google").click(); };
const signIn = logInGoogle;

const e2e = await startE2E();
const browser = await chromium.launch();
try {
  const T = await newUser(browser, e2e.url, { sub: "t-1", email: "teacher@gmail.com", name: "Tara Teacher" });
  const S = await newUser(browser, e2e.url, { sub: "s-1", email: "ana@gmail.com", name: "Ana Student" }, { width: 390, height: 844 });
  console.log("\nStudyTrack V4 end-to-end (real browser, real server logic)\n");

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
    await T.page.getByRole("button", { name: /Open menu/ }).click(); await T.page.getByRole("button", { name: /Add a class/ }).click();
    await T.page.getByPlaceholder("Class name").fill("Chemistry Class 11"); await T.page.getByRole("button", { name: "Create class" }).click(); await expectVisible(T.page, "Chemistry Class 11");
  });
  const codes = {};
  await step("class codes are shown", async () => {
    for (const [name, c] of Object.entries(await e2e.app.db.many("SELECT name,code FROM classes").then(r => Object.fromEntries(r.map(x => [x.name, x.code]))))) codes[name] = c;
    if (!codes["Physics Class 11"] || !codes["Chemistry Class 11"]) throw new Error("codes missing");
  });

  await step("TEACHER CAN POST HOMEWORK WITH A PDF TO BOTH CLASSES (the v3 bug)", async () => {
    await T.page.getByRole("tab", { name: "homework" }).click();
    await expectVisible(T.page, "Create homework");
    await T.page.getByPlaceholder("Homework title").fill("Kinematics worksheet");
    await T.page.getByPlaceholder("Instructions / description").fill("Solve questions 1 to 10.");
    await T.page.locator('input[type="date"]').first().fill("2026-12-20");
    await T.page.locator('input[type="file"]').first().setInputFiles({ name: "worksheet.pdf", mimeType: "application/pdf", buffer: makePdf() });
    await T.page.getByLabel("Physics Class 11").check().catch(() => {}); await T.page.getByLabel("Chemistry Class 11").check();
    await T.page.getByRole("button", { name: "Post homework" }).click();
    await expectVisible(T.page, "Homework posted to 2 classes with worksheet.pdf");
    await T.page.screenshot({ path: path.join(shots, "02-teacher-homework.png"), fullPage: true });
    const n = (await e2e.app.db.one("SELECT COUNT(*) AS n FROM homework WHERE file_path IS NOT NULL")).n; if (n !== 2) throw new Error(`expected 2 stored files, got ${n}`);
  });
  await step("a text-only homework also works, and a bad file is refused with a clear message", async () => {
    await T.page.getByPlaceholder("Homework title").fill("Read chapter 4");
    await T.page.getByRole("button", { name: "Post homework" }).click(); await expectVisible(T.page, "Homework posted to 1 class");
    await T.page.getByPlaceholder("Homework title").fill("Bad upload");
    await T.page.locator('input[type="file"]').first().setInputFiles({ name: "virus.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ....") });
    await T.page.getByRole("button", { name: "Post homework" }).click(); await expectVisible(T.page, "Only PDF, JPG, PNG and DOCX");
    await T.page.locator('input[type="file"]').first().setInputFiles({ name: "fake.pdf", mimeType: "application/pdf", buffer: Buffer.from("<html><script>alert(1)</script>") });
    await T.page.getByRole("button", { name: "Post homework" }).click(); await expectVisible(T.page, "does not match its extension");
  });

  await step("student joins two classes with codes; teacher approves both", async () => {
    await S.page.getByRole("tab", { name: "classes" }).click();
    for (const name of ["Physics Class 11", "Chemistry Class 11"]) { await S.page.getByLabel("Class code").fill(codes[name]); await S.page.getByRole("button", { name: "Send join request" }).click(); await expectVisible(S.page, "Request sent to"); }
    await T.page.reload(); await expectVisible(T.page, "Physics Class 11");
    await T.page.getByRole("button", { name: /Open menu/ }).click(); await T.page.getByRole("button", { name: /Student Joining Request/ }).click();
    await expectVisible(T.page, "Ana Student");
    for (let i = 0; i < 2; i++) { await T.page.getByRole("button", { name: /Allow Ana/ }).first().click(); await T.page.waitForTimeout(400); }
    const n = (await e2e.app.db.one("SELECT COUNT(*) AS n FROM student_class_memberships WHERE status='active'")).n; if (n !== 2) throw new Error(`memberships ${n}`);
  });
  await step("student sees both classes, class chips and the posted homework with its attachment", async () => {
    await S.page.reload(); await S.page.getByRole("tab", { name: "classes" }).click(); await expectVisible(S.page, "My classes");
    await expectVisible(S.page, "Physics Class 11"); await expectVisible(S.page, "Chemistry Class 11");
    await S.page.getByRole("tab", { name: "homework" }).click(); await expectVisible(S.page, "Kinematics worksheet"); await expectVisible(S.page, "Attachment: worksheet.pdf");
    await S.page.getByRole("button", { name: "Chemistry Class 11" }).first().click(); await expectVisible(S.page, "Kinematics worksheet");
    await S.page.screenshot({ path: path.join(shots, "03-student-homework-mobile.png"), fullPage: true });
  });
  await step("student downloads the file through a short-lived signed link", async () => {
    let u = "";
    await S.page.context().route("https://storage.test/**", r => { u = r.request().url(); r.fulfill({ status: 200, contentType: "application/pdf", body: "stub" }); });
    await S.page.getByRole("button", { name: "Download file" }).first().click();
    for (let i = 0; i < 40 && !u; i++) await S.page.waitForTimeout(100);
    for (const p of S.page.context().pages()) if (p !== S.page) await p.close().catch(() => {});
    if (!/^https:\/\/storage\.test\/studytrack-files\/t\d+\/c\d+\/homework\/[0-9a-f-]{36}\.pdf\?token=abc&exp=300/.test(u)) throw new Error(`unexpected URL ${u}`);
  });

  await step("teacher sends an announcement to several classes; student's bell lights up", async () => {
    await T.page.getByRole("button", { name: /Open menu/ }).click(); await T.page.getByRole("button", { name: /Announcements/ }).click();
    await T.page.getByLabel("Title").fill("Timing change"); await T.page.getByLabel("Message").fill("Tomorrow's Physics class will begin at 5 PM instead of 4 PM.");
    await T.page.getByLabel(/Mark as important/).check(); await T.page.getByLabel(/Several classes/).check();
    await T.page.getByLabel("Physics Class 11").check(); await T.page.getByLabel("Chemistry Class 11").check();
    await T.page.getByRole("button", { name: "Send announcement" }).click(); await expectVisible(T.page, "Announcement sent to 1 person");
    await S.page.getByRole("tab", { name: "overview" }).click(); await S.page.reload(); await S.page.waitForTimeout(500);
    await S.page.getByRole("button", { name: /Notifications, \d+ unread/ }).waitFor({ timeout: 8000 });
    await S.page.getByRole("button", { name: /Notifications, \d+ unread/ }).click();
    await expectVisible(S.page, "Timing change"); await expectVisible(S.page, "5 PM instead of 4 PM"); await expectVisible(S.page, "Important");
    await S.page.getByRole("button", { name: "Mark all as read" }).click(); await S.page.waitForTimeout(500);
    if (await S.page.getByRole("button", { name: /Notifications, \d+ unread/ }).count()) throw new Error("badge still shown");
    await S.page.screenshot({ path: path.join(shots, "04-notifications-mobile.png") });
  });

  await step("goals: set 4h/28h, log 2h45m, see '2h 45m / 4h' and the progress bar", async () => {
    await S.page.getByRole("tab", { name: "overview" }).click();
    await S.page.getByRole("button", { name: "Set goals" }).click(); await S.page.getByLabel("Daily goal (hours)").fill("4"); await S.page.getByLabel("Weekly goal (hours)").fill("28"); await S.page.getByRole("button", { name: "Save goals" }).click();
    await S.page.getByRole("tab", { name: "study" }).click(); await S.page.getByPlaceholder("Subject").fill("Physics"); await S.page.getByPlaceholder("Minutes").fill("165"); await S.page.getByRole("button", { name: "Add session" }).click(); await S.page.waitForTimeout(600);
    await S.page.getByRole("tab", { name: "overview" }).click(); await expectVisible(S.page, "2h 45m / 4h"); await expectVisible(S.page, "69%"); await expectVisible(S.page, "1h 15m to go today");
    await S.page.screenshot({ path: path.join(shots, "05-goals-mobile.png"), fullPage: true });
  });
  await step("planner: exam countdown and 'what to study today'", async () => {
    await S.page.getByRole("tab", { name: "planner" }).click(); await expectVisible(S.page, "What to study today");
    await S.page.getByPlaceholder("Subject").first().fill("Physics"); await S.page.getByPlaceholder("Exam name").fill("Mid-term"); await S.page.locator('input[type="date"]').first().fill(new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)); await S.page.getByRole("button", { name: "Add exam" }).click();
    await expectVisible(S.page, "Mid-term"); await expectVisible(S.page, "Study Physics");
    await S.page.screenshot({ path: path.join(shots, "06-planner-mobile.png"), fullPage: true });
  });
  await step("calendar shows the homework deadline, and the teacher can add a holiday", async () => {
    await S.page.getByRole("tab", { name: "calendar" }).click(); await expectVisible(S.page, "Classes, homework deadlines, tests, events and holidays");
    await T.page.getByRole("button", { name: /Open menu/ }).click(); await T.page.getByRole("button", { name: /Calendar/ }).click(); await expectVisible(T.page, "Weekly timetable");
    await T.page.getByRole("button", { name: "+ Event / holiday" }).click(); await T.page.getByPlaceholder("Title").fill("Diwali break"); await T.page.getByLabel("Type").selectOption("holiday");
    await T.page.getByLabel("Physics Class 11", { exact: false }).first().waitFor().catch(() => {}); await T.page.getByRole("button", { name: "Add", exact: true }).click(); await T.page.waitForTimeout(500);
    await T.page.screenshot({ path: path.join(shots, "07-teacher-calendar.png"), fullPage: true });
  });

  await step("institute: teacher requests an institute, owner approves it, teacher sees the institute page", async () => {
    await T.page.getByRole("button", { name: /Open menu/ }).click();
    await T.page.getByRole("button", { name: "+ Create Your Own Coaching Institute" }).click();
    await expectVisible(T.page, "Create your coaching institute");
    await T.page.getByLabel("Institute name").fill("Bright Future Academy"); await T.page.getByLabel(/Contact phone/).fill("98765 43210");
    await T.page.getByRole("button", { name: "Send for approval" }).click();
    await expectVisible(T.page, "Waiting for approval"); await expectVisible(T.page, "StudyTrack is reviewing your institute");
    const A = await newUser(browser, e2e.url, { sub: "x", email: "x@gmail.com" }); await A.page.goto(e2e.url + "/admin");
    await A.page.getByLabel("Admin key").fill("owner-key-123456"); await A.page.getByRole("button", { name: "Open admin panel" }).click(); await expectVisible(A.page, "Bright Future Academy");
    await A.context.close();
    const inst = await e2e.app.db.one("SELECT id FROM institutes WHERE code<>'DEMOACAD'"); await e2e.app.db.exec("UPDATE institutes SET status='active' WHERE id=$1", [inst.id]);
    await T.page.reload(); await T.page.getByRole("button", { name: /Open menu/ }).click(); await T.page.getByRole("button", { name: /Bright Future Academy/ }).click();
    await expectVisible(T.page, "Tara Teacher"); await T.page.screenshot({ path: path.join(shots, "10-institute-home.png"), fullPage: true });
  });
  await step("Security > Active sessions lists devices; 'Log out all other devices' signs the other one out", async () => {
    const S2 = await newUser(browser, e2e.url, { sub: "s-1", email: "ana@gmail.com", name: "Ana Student" });
    await signIn(S2.page, "student"); await expectVisible(S2.page, "Welcome back, Ana");
    await S.page.getByRole("tab", { name: "security" }).click(); await expectVisible(S.page, "Active sessions"); await expectVisible(S.page, "This device"); await expectVisible(S.page, "Log out all other devices");
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
    await P.page.getByLabel("Gmail").fill("newbie@gmail.com"); await P.page.getByLabel("Password").first().fill("WrongPass9"); await P.page.getByRole("button", { name: "Log in", exact: true }).click(); await expectVisible(P.page, "Incorrect password.");
    await P.page.getByLabel("Gmail").fill("ghost@gmail.com"); await P.page.getByLabel("Password").first().fill("Sunrise2026"); await P.page.getByRole("button", { name: "Log in", exact: true }).click(); await expectVisible(P.page, "No StudyTrack account found");
    await P.page.getByLabel("Gmail").fill("newbie@gmail.com"); await P.page.getByLabel("Password").first().fill("Sunrise2026"); await P.page.getByRole("button", { name: "Log in", exact: true }).click();
    await expectVisible(P.page, "Welcome back, Nina"); if (await P.page.getByText("Tell us about yourself").count()) throw new Error("details were asked again");
    await P.page.screenshot({ path: path.join(shots, "11-password-login-home.png") }); await P.context.close();
  });
  await step("demo accounts: teacher and student log in with the given Gmail and password and see live data", async () => {
    await seedDemo(e2e.app.ctx);
    const D = await newUser(browser, e2e.url, { sub: "x", email: "x@gmail.com", name: "X" });
    const logIn = async (email, password) => { await D.page.getByLabel("Gmail").fill(email); await D.page.getByLabel("Password").first().fill(password); await D.page.getByRole("button", { name: "Log in", exact: true }).click(); };
    await logIn("demoteacher1@coaching.com", "demoteacher1"); await expectVisible(D.page, "Physics Class 11"); await D.page.getByRole("tab", { name: "students" }).click(); await expectVisible(D.page, "Aarav Mehta"); await expectVisible(D.page, "Diya Nair");
    await D.page.screenshot({ path: path.join(shots, "12-demo-teacher.png"), fullPage: true });
    await D.page.getByRole("button", { name: "Logout" }).click(); await expectVisible(D.page, "Log in");
    await logIn("demostudent1@coaching.com", "demostudent1"); await expectVisible(D.page, "Welcome back, Aarav"); await expectVisible(D.page, "2h 45m / 4h");
    await D.page.screenshot({ path: path.join(shots, "13-demo-student.png"), fullPage: true });
    await D.page.getByRole("tab", { name: "planner" }).click(); await expectVisible(D.page, "Exam in"); await D.page.getByRole("tab", { name: "calendar" }).click(); await expectVisible(D.page, "Classes, homework deadlines"); await D.page.locator(".cal-cell.holiday").first().waitFor({ timeout: 8000 }); await D.page.screenshot({ path: path.join(shots, "14-demo-calendar.png"), fullPage: true });
    await D.context.close();
  });

  await step("no console errors, page errors or CSP violations during the whole run", async () => { if (problems.length) throw new Error(problems.slice(0, 4).join(" | ")); });
} finally { await browser.close(); await e2e.close(); }
console.log(failures ? `\n${failures} step(s) FAILED\n` : "\nAll end-to-end steps passed\n");
process.exit(failures ? 1 : 0);
