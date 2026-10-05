// Dependency-free source checks. Run with: npm run qa
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const server = read('server/server.js');
const clientDir = path.join(root, 'client/src');
const client = fs.readdirSync(clientDir).filter(f => /\.(jsx?|css)$/.test(f)).map(f => fs.readFileSync(path.join(clientDir, f), 'utf8')).join('\n');
const pkg = read('package.json');
const ignore = read('.gitignore');
const envExample = read('server/.env.example');
const all = [server, client, pkg, ignore, envExample].join('\n');

const checks = [
  // V2 foundations
  ['attendance schema', /CREATE TABLE IF NOT EXISTS attendance/],
  ['syllabus schema', /CREATE TABLE IF NOT EXISTS syllabus_chapters/],
  ['previous week', /function previousWeekStart/],
  ['student activity ID isolation', /filter\(x=>x\.student_id===s\.id\)/],
  ['production JWT guard', /JWT_SECRET must be configured in production/],
  ['production DB guard', /DB_PATH must be configured in production/],
  ['fresh client build', /npm --prefix client run build/],
  ['single service start', /npm --prefix server start/],
  ['stale dist ignored', /client\/dist\//],
  ['error handler', /Internal server error/],
  ['graceful shutdown', /SIGTERM/],
  ['study duration limit', /Number\(minutes\)>1440/],
  ['Asia/Kolkata default', /Asia\/Kolkata/],
  ['teacher active-today class scoped', /COUNT\(DISTINCT s\.student_id\).*u\.class_code=\?/],
  ['teacher scores class scoped', /m\.student_id=\? AND t\.class_id=/],
  ['results test created_at available', /t\.test_date,t\.created_at/],
  // V3: auth and rate limiting
  ['login rate limit', /loginLimiter\.guard/],
  ['per-account login limit', /accountLimiter/],
  ['proxy-aware client IP', /trust proxy/],
  ['teacher self sign-up', /\/api\/auth\/teacher-register/],
  ['Termux teacher creation removed', /^(?![\s\S]*\/api\/admin\/create-teacher)[\s\S]*$/],
  // V3: class joining
  ['student join request', /\/api\/student\/join-request/],
  ['join approve route', /join-requests\/:id\/approve/],
  ['deny route with block mode', /mode === "block"/],
  ['block needs confirmation', /CONFIRM_REQUIRED/],
  ['one pending request per student', /idx_join_requests_one_pending/],
  ['selected class header', /x-class-id/],
  ['room selects its own class before loading', /setActiveClass\(classInfo\.id\)/],
  // V3: institutes and owner control
  ['institute approval flow', /status IN \('pending','active','rejected','suspended','banned'\)/],
  ['admin token is separate', /ADMIN_AUDIENCE/],
  ['admin key length guard', /ADMIN_KEY must be at least 12 characters/],
  ['independent mode', /control_mode/],
  ['read-only enforcement', /READ_ONLY/],
  ['storage limit enforcement', /STORAGE_LIMIT/],
  ['db is source of truth for bans', /SELECT id,name,email,role,class_code,institute_id,institute_role,banned FROM users WHERE id=\?/],
  ['admin panel route', /pathname === "\/admin"/],
  ['institute info tooltip', /InfoTip/],
  ['ADMIN_KEY documented', /ADMIN_KEY=/],
];
let failed = 0;
for (const [name, re] of checks) {
  const ok = re.test(all);
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed++;
}
for (const [re, name] of [
  [/date\(h\.due_date\)<date\('now'\)/, 'UTC homework date logic'],
  [/student===s\.name/, 'name-based activity isolation'],
  [/\bprompt\(/, 'browser prompt workflow'],
  [/\balert\(/, 'browser alert workflow'],
  [/localStorage\.clear\(/, 'blanket localStorage clearing'],
]) {
  const bad = re.test(server + '\n' + client);
  console.log(`${bad ? 'FAIL' : 'PASS'}: no ${name}`);
  if (bad) failed++;
}
// Route protection. Each route's middleware chain is the text between its path and the first "=>".
const routes = [...server.matchAll(/app\.(get|post|put|patch|delete)\(\s*"(\/api\/[^"]*)"\s*,([\s\S]*?)=>/g)].map(m => ({ method: m[1], route: m[2], chain: m[3] }));
const expectAtLeast = 60;
console.log(`${routes.length >= expectAtLeast ? 'PASS' : 'FAIL'}: route scanner inspected ${routes.length} routes (needs ${expectAtLeast}+ so the checks below are not vacuous)`);
if (routes.length < expectAtLeast) failed++;
const publicRoutes = new Set(['/api/health', '/api/auth/login', '/api/auth/register', '/api/auth/teacher-register', '/api/auth/teacher-join-institute', '/api/auth/institute-request', '/api/admin/login']);
const open = routes.filter(r => !publicRoutes.has(r.route) && !/\b(auth|adminAuth)\b/.test(r.chain));
console.log(`${open.length ? 'FAIL' : 'PASS'}: every non-public API route uses auth or adminAuth${open.length ? ' -> ' + open.map(r => `${r.method} ${r.route}`).join(', ') : ''}`);
if (open.length) failed++;
const adminWrong = routes.filter(r => r.route.startsWith('/api/admin/') && r.route !== '/api/admin/login' && !/\badminAuth\b/.test(r.chain));
console.log(`${adminWrong.length ? 'FAIL' : 'PASS'}: every /api/admin route except login uses adminAuth${adminWrong.length ? ' -> ' + adminWrong.map(r => r.route).join(', ') : ''}`);
if (adminWrong.length) failed++;
const userUsingAdmin = routes.filter(r => !r.route.startsWith('/api/admin/') && /\badminAuth\b/.test(r.chain));
console.log(`${userUsingAdmin.length ? 'FAIL' : 'PASS'}: adminAuth is only used on /api/admin routes`);
if (userUsingAdmin.length) failed++;
const teacherNoRole = routes.filter(r => /^\/api\/teacher\//.test(r.route) && !/role\("teacher"\)/.test(r.chain));
console.log(`${teacherNoRole.length ? 'FAIL' : 'PASS'}: every /api/teacher route requires the teacher role${teacherNoRole.length ? ' -> ' + teacherNoRole.map(r => r.route).join(', ') : ''}`);
if (teacherNoRole.length) failed++;
const studentNoRole = routes.filter(r => /^\/api\/student\//.test(r.route) && !/role\("student"\)/.test(r.chain));
console.log(`${studentNoRole.length ? 'FAIL' : 'PASS'}: every /api/student route requires the student role${studentNoRole.length ? ' -> ' + studentNoRole.map(r => r.route).join(', ') : ''}`);
if (studentNoRole.length) failed++;
process.exitCode = failed ? 1 : 0;
