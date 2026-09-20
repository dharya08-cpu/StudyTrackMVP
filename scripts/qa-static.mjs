import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const server=fs.readFileSync(path.join(root,'server/server.js'),'utf8');
const client=fs.readFileSync(path.join(root,'client/src/main.jsx'),'utf8');
const pkg=fs.readFileSync(path.join(root,'package.json'),'utf8');
const ignore=fs.readFileSync(path.join(root,'.gitignore'),'utf8');
const checks=[
 ['attendance schema',/CREATE TABLE IF NOT EXISTS attendance/],
 ['syllabus schema',/CREATE TABLE IF NOT EXISTS syllabus_chapters/],
 ['previous week',/function previousWeekStart/],
 ['student activity ID isolation',/filter\(x=>x\.student_id===s\.id\)/],
 ['production JWT guard',/JWT_SECRET must be configured in production/],
 ['production DB guard',/DB_PATH must be configured in production/],
 ['fresh client build',/npm --prefix client run build/],
 ['single service start',/npm --prefix server start/],
 ['stale dist ignored',/client\/dist\//],
 ['login rate limit',/loginRateLimit/],
 ['error handler',/Internal server error/],
 ['graceful shutdown',/SIGTERM/],
 ['study duration limit',/Number\(minutes\)>1440/],
 ['Asia/Kolkata default',/Asia\/Kolkata/],
 ['teacher active-today class scoped',/COUNT\(DISTINCT s\.student_id\).*u\.class_code=\?/],
 ['teacher scores class scoped',/m\.student_id=\? AND t\.class_id=/],
 ['results test created_at available',/t\.test_date,t\.created_at/],
];
let failed=0;
for (const [name,re] of checks) { const ok=re.test(server+'\n'+client+'\n'+pkg+'\n'+ignore); console.log(`${ok?'PASS':'FAIL'}: ${name}`); if(!ok) failed++; }
for (const [re,name] of [[/date\(h\.due_date\)<date\('now'\)/,'UTC homework date logic'],[/student===s\.name/,'name-based activity isolation'],[/prompt\(/,'browser prompt workflow']]) { const bad=re.test(server+'\n'+client); console.log(`${bad?'FAIL':'PASS'}: no ${name}`); if(bad) failed++; }
process.exitCode=failed?1:0;
