import React, { useEffect, useState } from "react";
import { api, json, setActiveClass } from "./api.js";
import { Stat, Card, List, ErrorBox, Loading, MiniBars, Trend, Modal, CopyChip, FileUploadButton, DownloadFileButton, FILE_HINT, localDateInput, minutesToHours, trend } from "./ui.jsx";

// ---- Analytics, attendance and syllabus screens carried over from V3 (unchanged behaviour) ----
function TeacherOverview({data,setTab,setSelected}){
 const avg=(()=>{const rows=data.studentSummary.filter(s=>Number(s.average_percentage)>0);return rows.length?(rows.reduce((a,s)=>a+Number(s.average_percentage),0)/rows.length).toFixed(1):"0.0"})();
 return <>{data.students.length===0&&<section className="panel"><div className="empty">No students have joined yet. Share your class code <b>{data.class.code}</b> with them. Their requests appear under Menu, Students, Student Joining Request.</div></section>}<div className="grid four"><Stat label="Students" value={data.metrics.students||0}/><Stat label="Active today" value={data.metrics.active_today||0} sub={`${data.metrics.inactive_today||0} inactive`}/><Stat label="Study today" value={`${data.metrics.today_hours||0}h`}/><Stat label="Study this week" value={`${data.metrics.week_hours||0}h`}/></div><div className="grid four"><Stat label="Average test" value={`${avg}%`}/><Stat label="Homework" value={data.homework.length}/><Stat label="Pending reviews" value={data.metrics.pending_reviews||0}/><Stat label="Open homework" value={data.metrics.open_homework||0}/></div><section className="panel"><div className="panel-head"><div><h2>Quick student status</h2><p className="muted">Study activity, performance and homework in one view.</p></div><button className="secondary" onClick={()=>setTab("students")}>View all</button></div><div className="table-wrap"><table><thead><tr><th>Student</th><th>Today</th><th>This week</th><th>Test avg</th><th>Homework</th><th>Status</th></tr></thead><tbody>{data.studentSummary.map(s=><tr key={s.id} onClick={()=>{setSelected(s.id);setTab("students")}}><td><b>{s.name}</b><small>{s.email}</small></td><td>{s.today_hours}h</td><td>{s.week_hours}h</td><td>{s.average_percentage}%</td><td>{s.homework_submitted}/{s.homework_total}</td><td><span className={`status-chip ${s.status}`}>{s.status==="on-track"?"On track":s.status==="needs-attention"?"Needs attention":"At risk"}</span><br/><Trend value={s.study_trend}/></td></tr>)}</tbody></table></div></section><section className="panel"><div className="panel-head"><h2>Recent activity</h2><button className="secondary" onClick={()=>setTab("study activity")}>Study activity</button></div><ActivityList items={data.activity}/></section></>
}

function ActivityList({items}){return <List items={items} empty="No recent activity." render={x=><div className="activity"><div className={`activity-dot ${x.type}`}/><div><b>{x.student}</b> <span>{x.type==="study"?`logged ${x.detail} minutes of ${x.title}`:x.type==="homework"?`${x.detail} homework: ${x.title}`:x.type==="test"?`recorded ${x.detail}% in ${x.title}`:x.type==="attendance"?`was marked ${x.detail}`:`${x.title} syllabus: ${x.detail}`}</span><small>{x.created_at}</small></div></div>}/>}

function TeacherStudyActivity({data,selected,setSelected}){const [student,setStudent]=useState(null),[loading,setLoading]=useState(false),[error,setError]=useState(""),[filters,setFilters]=useState({from:"",to:"",subject:"",category:""});const load=async id=>{setSelected(id);setLoading(true);setError("");try{const q=new URLSearchParams(Object.entries(filters).filter(([,v])=>v));setStudent(await api(`/teacher/student/${id}/study${q.toString()?`?${q}`:""}`))}catch(e){setError(e.message)}finally{setLoading(false)}};useEffect(()=>{if(selected)load(selected)},[filters]);return <><div className="panel"><div className="panel-head"><div><h2>Study activity</h2><p className="muted">Daily, weekly, subject and study-type breakdowns.</p></div></div><div className="student-pills">{data.students.map(s=><button className={selected===s.id?"active":""} onClick={()=>load(s.id)} key={s.id}>{s.name}</button>)}</div><div className="form-grid filter-grid"><input type="date" value={filters.from} onChange={e=>setFilters({...filters,from:e.target.value})}/><input type="date" value={filters.to} onChange={e=>setFilters({...filters,to:e.target.value})}/><input placeholder="Exact subject filter" value={filters.subject} onChange={e=>setFilters({...filters,subject:e.target.value})}/><select value={filters.category} onChange={e=>setFilters({...filters,category:e.target.value})}><option value="">All study types</option><option value="self-study">Self-study</option><option value="tuition">Tuition</option><option value="outside">Outside</option></select></div><button className="secondary" onClick={()=>setFilters({from:"",to:"",subject:"",category:""})}>Clear filters</button></div>{error&&<ErrorBox error={error}/>} {loading&&<Loading/>}{student&&<section className="panel"><h2>{student.student.name}</h2><div className="grid four"><Stat label="This week" value={`${minutesToHours(student.this_week_minutes)}h`}/><Stat label="Previous week" value={`${minutesToHours(student.previous_week_minutes)}h`}/><Stat label="Change" value={student.change_percentage==null?"New":`${student.change_percentage>0?"+":""}${student.change_percentage}%`}/><Stat label="Filtered logs" value={student.logs.length}/></div><p><Trend value={student.trend}/></p><div className="dashboard-grid"><div><h3>Subject-wise</h3><MiniBars items={student.subjects}/></div><div><h3>Study type</h3><MiniBars items={student.categories} labelKey="category"/></div></div><div className="panel inner"><h3>Daily activity</h3><MiniBars items={student.daily} labelKey="study_date"/></div><div className="panel inner"><h3>Recent study logs</h3><List items={student.logs.slice(0,20)} render={x=><div className="item"><div><b>{x.subject}</b><small>{x.study_date} • {x.category}</small></div><strong>{x.minutes} min</strong></div>}/></div></section>}</>}

function StudentAnalytics({id}){const [a,setA]=useState(null),[error,setError]=useState("");useEffect(()=>{setA(null);setError("");api(`/teacher/student/${id}/analytics`).then(setA).catch(e=>setError(e.message))},[id]);if(error)return <ErrorBox error={error}/>;if(!a)return <Loading/>;return <div className="analytics"><h2>{a.student.name}</h2><div className="grid four"><Stat label="Test average" value={`${a.averagePercentage}%`}/><Stat label="Latest test" value={a.latestPercentage==null?"—":`${a.latestPercentage}%`}/><Stat label="Study this week" value={`${a.weekStudyHours}h`} sub={<Trend value={a.studyTrend}/>}/><Stat label="Attendance" value={`${a.attendancePercentage}%`}/></div><div className="grid three"><Stat label="Syllabus" value={`${a.syllabusPercentage}%`}/><Stat label="Study total" value={`${a.studyHours}h`}/><Stat label="Performance" value={<Trend value={a.performanceTrend}/>}/></div><section className="panel inner"><div className="panel-head"><div><h3>Study time + test performance</h3><p className="muted">Weekly history shown together; this does not imply causation.</p></div></div><div className="table-wrap"><table><thead><tr><th>Week</th><th>Study</th><th>Test %</th></tr></thead><tbody>{a.weeklyComparison.length?a.weeklyComparison.map(w=><tr key={w.week_start}><td>{w.week_start}</td><td>{minutesToHours(w.study_minutes)}h</td><td>{w.test_percentage==null?"—":`${w.test_percentage}%`}</td></tr>):<tr><td colSpan="3">No combined history yet.</td></tr>}</tbody></table></div></section><div className="panel inner"><h3>Test history</h3><List items={[...a.scores].reverse()} empty="No test results yet." render={s=><div className="score-row"><span><b>{s.title}</b><small>{s.subject} • {s.test_date||"No date"}</small></span><b>{s.marks}/{s.max_marks}</b><strong>{s.percentage}%</strong></div>}/></div></div>}

function RemoveStudentButton({student,onRemoved}){
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const remove=async()=>{setBusy(true);setError("");try{await api(`/teacher/students/${student.id}`,{method:"DELETE"});setOpen(false);onRemoved()}catch(e){setError(e.message)}finally{setBusy(false)}};
  return <>
    <button className="danger-outline" onClick={()=>setOpen(true)}>Remove from class</button>
    {open&&<Modal title={`Remove ${student.name}?`} onClose={()=>setOpen(false)}>
      <p>{student.name} will lose access to this class. Their account stays, and they can send a new join request later. Their past records stay saved.</p>
      <ErrorBox error={error}/>
      <div className="modal-actions"><button className="secondary" onClick={()=>setOpen(false)}>Keep student</button><button className="danger-solid" disabled={busy} onClick={remove}>{busy?"Removing…":"Remove student"}</button></div>
    </Modal>}
  </>
}

function TeacherStudents({data,selected,setSelected,reload}){
  const current=data.students.find(s=>s.id===selected);
  return <section className="panel"><h2>Students</h2>
    {data.students.length===0?<div className="empty">No students yet. Approved students appear here.</div>:<div className="student-grid">{data.students.map(s=><button className="student-card" key={s.id} onClick={()=>setSelected(s.id)}><b>{s.name}</b><small>{s.email}</small><div className="student-mini">{data.studentSummary.find(x=>x.id===s.id)?.week_hours||0}h this week</div></button>)}</div>}
    {current&&<><div className="panel-head student-actions"><span className="muted">Selected: <b>{current.name}</b></span><RemoveStudentButton student={current} onRemoved={()=>{setSelected(null);reload()}}/></div><StudentAnalytics id={selected}/></>}
  </section>
}

function TeacherResults({data}){const [results,setResults]=useState(null),[student,setStudent]=useState(null),[error,setError]=useState(""),[filters,setFilters]=useState({subject:"",from:"",to:""});const load=async()=>{setError("");try{const q=new URLSearchParams(Object.entries(filters).filter(([,v])=>v));setResults(await api(`/teacher/results${q.toString()?`?${q}`:""}`))}catch(e){setError(e.message)}};useEffect(()=>{load()},[filters]);if(error&&!results)return <section className="panel"><ErrorBox error={error}/><button className="secondary" onClick={load}>Try again</button></section>;if(!results)return <Loading/>;return <><section className="panel"><div className="panel-head"><div><h2>Student results</h2><p className="muted">Class-wide performance with individual score history.</p></div></div><div className="form-grid filter-grid"><input placeholder="Exact subject filter" value={filters.subject} onChange={e=>setFilters({...filters,subject:e.target.value})}/><input type="date" value={filters.from} onChange={e=>setFilters({...filters,from:e.target.value})}/><input type="date" value={filters.to} onChange={e=>setFilters({...filters,to:e.target.value})}/><button className="secondary" onClick={()=>setFilters({subject:"",from:"",to:""})}>Clear filters</button></div><div className="table-wrap"><table><thead><tr><th>Student</th><th>Tests</th><th>Average</th><th>Latest</th><th>Highest</th><th>Trend</th></tr></thead><tbody>{results.students.map(r=><tr key={r.student.id} onClick={()=>setStudent(r)}><td><b>{r.student.name}</b><small>{r.student.email}</small></td><td>{r.test_count}</td><td>{r.average_percentage}%</td><td>{r.latest_percentage==null?"—":`${r.latest_percentage}%`}</td><td>{r.highest_percentage==null?"—":`${r.highest_percentage}%`}</td><td><Trend value={r.trend}/></td></tr>)}</tbody></table></div></section>{student&&<section className="panel"><div className="panel-head"><div><h2>{student.student.name}</h2><p className="muted">Average {student.average_percentage}% • Lowest {student.lowest_percentage==null?"—":`${student.lowest_percentage}%`}</p></div><button className="secondary" onClick={()=>setStudent(null)}>Close</button></div><List items={student.scores} empty="No results yet." render={s=><div className="score-row"><span><b>{s.title}</b><small>{s.subject} • {s.test_date||"No date"}</small></span><b>{s.marks}/{s.max_marks}</b><strong>{s.percentage}%</strong></div>}/></section>}</>}

function TeacherAttendance(){const [date,setDate]=useState(localDateInput()),[data,setData]=useState(null),[records,setRecords]=useState({}),[msg,setMsg]=useState(""),[error,setError]=useState("");const load=()=>{setError("");api(`/teacher/attendance?date=${date}`).then(d=>{setData(d);setRecords(Object.fromEntries(d.students.filter(x=>x.status).map(x=>[x.student.id,x.status]))) }).catch(e=>setError(e.message))};useEffect(()=>{load()},[date]);if(error)return <section className="panel"><ErrorBox error={error}/><button className="secondary" onClick={load}>Try again</button></section>;if(!data)return <Loading/>;const save=async()=>{setError("");try{await api("/teacher/attendance",{method:"POST",body:JSON.stringify({date,records:Object.entries(records).map(([studentId,status])=>({studentId:Number(studentId),status}))})});setMsg("Attendance saved.");load()}catch(e){setError(e.message)}};return <section className="panel"><div className="panel-head"><div><h2>Attendance register</h2><p className="muted">Mark daily attendance. A blank record is different from an absence.</p></div><input className="date-input" type="date" value={date} onChange={e=>setDate(e.target.value)}/></div>{data.students.length===0?<div className="empty">No students are currently enrolled in this class.</div>:<List items={data.students} render={x=><div className="item"><b>{x.student.name}</b><div className="attendance-toggle"><button className={records[x.student.id]==="present"?"active":""} onClick={()=>setRecords({...records,[x.student.id]:"present"})}>Present</button><button className={records[x.student.id]==="absent"?"danger active":"danger"} onClick={()=>setRecords({...records,[x.student.id]:"absent"})}>Absent</button></div></div>}/>}<button className="primary" onClick={save} disabled={!data.students.length}>Save attendance</button>{msg&&<p className="success">{msg}</p>}{error&&<ErrorBox error={error}/>}</section>}

function TeacherSyllabus(){const [data,setData]=useState(null),[form,setForm]=useState({subject:"",chapter:"",status:"not-started"}),[error,setError]=useState(""),[saving,setSaving]=useState(false),[msg,setMsg]=useState("");const load=()=>{setError("");api("/teacher/syllabus").then(setData).catch(e=>setError(e.message))};useEffect(()=>{load()},[]);if(error&&!data)return <section className="panel"><ErrorBox error={error}/><button className="secondary" onClick={load}>Try again</button></section>;if(!data)return <Loading/>;const save=async e=>{e.preventDefault();setError("");setMsg("");setSaving(true);try{await api("/teacher/syllabus",{method:"POST",body:JSON.stringify(form)});setForm({subject:"",chapter:"",status:"not-started"});setMsg("Chapter saved.");await load()}catch(e){setError(e.message)}finally{setSaving(false)}};return <><section className="panel"><h2>Manage syllabus</h2><form className="form-grid" onSubmit={save}><input placeholder="Subject" value={form.subject} onChange={e=>setForm({...form,subject:e.target.value})} required/><input placeholder="Chapter" value={form.chapter} onChange={e=>setForm({...form,chapter:e.target.value})} required/><select value={form.status} onChange={e=>setForm({...form,status:e.target.value})}><option value="not-started">Not started</option><option value="in-progress">In progress</option><option value="completed">Completed</option></select><button className="primary" disabled={saving}>{saving?"Saving…":"Save chapter"}</button></form>{msg&&<p className="success">{msg}</p>}{error&&<ErrorBox error={error}/>}</section><section className="panel"><h2>Current syllabus</h2><List items={data.chapters} empty="No syllabus chapters yet." render={c=><div className="item"><div><b>{c.subject}</b><small>{c.chapter}</small></div><span className={`badge ${c.status}`}>{c.status}</span></div>}/></section></>}

const MAX_UPLOAD_MB = 15;
const ALLOWED_EXT = ["pdf", "jpg", "jpeg", "png", "docx"];
// Quick client-side check for a friendly message; the server re-checks the real file content.
function checkFile(file) {
  if (!file) return "";
  if (!ALLOWED_EXT.includes(file.name.split(".").pop().toLowerCase())) return "Only PDF, JPG, PNG and DOCX files can be uploaded.";
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return `File must be ${MAX_UPLOAD_MB} MB or smaller.`;
  return "";
}

// Homework: create (text, due date, optional file, one or several classes), then track submissions and review.
function TeacherHomework({ data, ctx, reload }) {
  const classes = ctx.classes.filter(c => !c.suspended);
  const blank = { title: "", description: "", dueDate: "" };
  const [form, setForm] = useState(blank), [file, setFile] = useState(null), [targets, setTargets] = useState([data.class.id]);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState(null), [subs, setSubs] = useState(null), [review, setReview] = useState(null), [feedback, setFeedback] = useState("");
  const [msg, setMsg] = useState(""), [error, setError] = useState(""), [loading, setLoading] = useState(false), [uploading, setUploading] = useState(null), [fileKey, setFileKey] = useState(0);
  useEffect(() => { setTargets([data.class.id]); }, [data.class.id]);

  const toggle = id => setTargets(t => (t.includes(id) ? t.filter(x => x !== id) : [...t, id]));
  const create = async e => {
    e.preventDefault(); setError(""); setMsg("");
    const problem = checkFile(file); if (problem) { setError(problem); return; }
    if (!targets.length) { setError("Choose at least one class."); return; }
    setCreating(true);
    try {
      const body = new FormData();
      body.append("title", form.title); body.append("description", form.description); body.append("dueDate", form.dueDate);
      body.append("classIds", JSON.stringify(targets));
      if (file) body.append("file", file);
      const r = await api("/teacher/homework", { method: "POST", body });
      setMsg(`Homework posted to ${r.created.length} ${r.created.length === 1 ? "class" : "classes"}${r.fileName ? ` with ${r.fileName}` : ""}. Students were notified.`);
      setForm(blank); setFile(null); setFileKey(k => k + 1); setTargets([data.class.id]); await reload();
    } catch (err) { setError(err.message); } finally { setCreating(false); }
  };
  const open = async id => { setSelected(id); setError(""); setLoading(true); try { setSubs(await api(`/teacher/homework/${id}/submissions`)); } catch (e) { setError(e.message); } finally { setLoading(false); } };
  const attach = async (id, f) => {
    const problem = checkFile(f); if (problem) { setError(problem); return; }
    setUploading(id); setError("");
    const body = new FormData(); body.append("file", f);
    try { await api(`/teacher/homework/${id}/attach`, { method: "POST", body }); setMsg("Homework file attached."); await reload(); } catch (e) { setError(e.message); } finally { setUploading(null); }
  };
  const remove = async h => { if (!window.confirm(`Delete "${h.title}" and all its submissions?`)) return; setError(""); try { await api(`/teacher/homework/${h.id}`, { method: "DELETE" }); setSubs(null); setSelected(null); setMsg("Homework deleted."); await reload(); } catch (e) { setError(e.message); } };
  const doReview = async () => { if (!review) return; setError(""); try { await api(`/teacher/homework/${selected}/review`, { method: "POST", body: json({ studentId: review.student.id, feedback }) }); setMsg("Submission reviewed."); setReview(null); setFeedback(""); await open(selected); await reload(); } catch (e) { setError(e.message); } };

  return (
    <>
      <section className="panel">
        <div className="panel-head"><div><h2>Create homework</h2><p className="muted">Write instructions, set a due date and attach a file if you like. Students are notified.</p></div></div>
        <form onSubmit={create}>
          <div className="form-grid">
            <input placeholder="Homework title" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} maxLength={200} required />
            <label className="field">Due date (optional)<input type="date" value={form.dueDate} onChange={e => setForm({ ...form, dueDate: e.target.value })} /></label>
            <textarea placeholder="Instructions / description (optional)" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} maxLength={5000} />
          </div>
          <label className="field">Attachment (optional)<input key={fileKey} type="file" accept=".pdf,.jpg,.jpeg,.png,.docx" onChange={e => { setFile(e.target.files?.[0] || null); setError(""); }} /><span className="hint-inline">{FILE_HINT}</span></label>
          {classes.length > 1 && (
            <fieldset className="audience"><legend>Post to</legend><div className="check-grid">{classes.map(c => <label key={c.id} className="check"><input type="checkbox" checked={targets.includes(c.id)} onChange={() => toggle(c.id)} /> {c.name}</label>)}</div></fieldset>
          )}
          <ErrorBox error={error} />{msg && <p className="success" role="status">{msg}</p>}
          <button className="primary" disabled={creating}>{creating ? "Posting…" : "Post homework"}</button>
        </form>
      </section>
      <section className="panel">
        <div className="panel-head"><div><h2>Homework</h2><p className="muted">Track class submissions and review individual students.</p></div></div>
        <List items={data.homework} empty="No homework yet. Create your first one above." render={h => (
          <div className="item clickable" onClick={() => open(h.id)}>
            <div><b>{h.title}</b><small>Due: {h.due_date || "No date"}</small>{h.has_file && <small>File: {h.file_name}</small>}</div>
            <div className="status-group" onClick={e => e.stopPropagation()}>
              <span>{h.submitted_count || 0}/{data.students.length} submitted</span><span>{h.reviewed_count || 0} reviewed</span><span>{h.late_count || 0} late</span>
              <FileUploadButton onChange={f => attach(h.id, f)} disabled={uploading === h.id} label={h.has_file ? "Replace file" : "Attach file"} />
              <button className="danger-outline small-btn" onClick={() => remove(h)}>Delete</button>
            </div>
          </div>
        )} />
      </section>
      {loading && <Loading />}
      {subs && <section className="panel"><div className="panel-head"><div><h2>{subs.homework.title}: submissions</h2><p className="muted">Every student is listed so pending work is visible too.</p></div></div>
        <List items={subs.submissions.map(s => ({ ...s, id: s.student.id }))} render={s => (
          <div className="item"><div><b>{s.student.name}</b><small>{s.submitted_at ? `Submitted ${s.submitted_at}` : "Not submitted"}</small>{s.note && <small>Note: {s.note}</small>}{s.feedback && <small>Feedback: {s.feedback}</small>}</div>
            <div className="status-group"><span className={`badge ${s.status}`}>{s.status}</span>{s.status !== "pending" && s.status !== "reviewed" && <button className="secondary" onClick={e => { e.stopPropagation(); setReview(s); setFeedback(s.feedback || ""); }}>Review</button>}</div></div>
        )} /></section>}
      {review && <Modal title={`Review ${review.student.name}`} onClose={() => setReview(null)}><p className="muted">{subs?.homework.title}</p><textarea placeholder="Feedback (optional)" value={feedback} onChange={e => setFeedback(e.target.value)} maxLength={5000} /><button className="primary" onClick={doReview}>Mark reviewed</button></Modal>}
    </>
  );
}

function TeacherTests({ data, reload }) {
  const blank = { title: "", subject: "", maxMarks: "", solution: "", testDate: "" };
  const [test, setTest] = useState(blank), [file, setFile] = useState(null), [fileKey, setFileKey] = useState(0);
  const [mark, setMark] = useState({ testId: "", studentId: "", marks: "", remark: "" });
  const [msg, setMsg] = useState(""), [error, setError] = useState(""), [uploading, setUploading] = useState(null), [busy, setBusy] = useState(false);
  const addTest = async e => {
    e.preventDefault(); setError(""); setMsg("");
    const problem = checkFile(file); if (problem) { setError(problem); return; }
    setBusy(true);
    try {
      const body = new FormData();
      Object.entries(test).forEach(([k, v]) => body.append(k, v));
      if (file) body.append("file", file);
      await api("/teacher/tests", { method: "POST", body });
      setTest(blank); setFile(null); setFileKey(k => k + 1); setMsg("Test published. Students were notified."); await reload();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const addMark = async e => { e.preventDefault(); setError(""); try { const r = await api("/teacher/marks", { method: "POST", body: json(mark) }); setMsg(`Saved result: ${r.percentage}%.`); setMark({ testId: "", studentId: "", marks: "", remark: "" }); await reload(); } catch (err) { setError(err.message); } };
  const attach = async (id, f) => {
    const problem = checkFile(f); if (problem) { setError(problem); return; }
    setUploading(id); setError("");
    const body = new FormData(); body.append("file", f);
    try { await api(`/teacher/tests/${id}/attach`, { method: "POST", body }); setMsg("Test file attached."); await reload(); } catch (e) { setError(e.message); } finally { setUploading(null); }
  };
  return (
    <>
      <section className="panel"><div className="panel-head"><div><h2>Create test</h2><p className="muted">Percentages are calculated automatically from marks.</p></div></div>
        <ErrorBox error={error} />{msg && <p className="success" role="status">{msg}</p>}
        <form onSubmit={addTest}>
          <div className="form-grid">
            <input placeholder="Test title" value={test.title} onChange={e => setTest({ ...test, title: e.target.value })} maxLength={200} required />
            <input placeholder="Subject" value={test.subject} onChange={e => setTest({ ...test, subject: e.target.value })} maxLength={100} required />
            <input type="number" min="1" step="1" placeholder="Max marks" value={test.maxMarks} onChange={e => setTest({ ...test, maxMarks: e.target.value })} required />
            <input type="date" value={test.testDate} onChange={e => setTest({ ...test, testDate: e.target.value })} aria-label="Test date" />
            <textarea placeholder="Solution / analysis" value={test.solution} onChange={e => setTest({ ...test, solution: e.target.value })} maxLength={10000} />
          </div>
          <label className="field">Question paper or solution file (optional)<input key={fileKey} type="file" accept=".pdf,.jpg,.jpeg,.png,.docx" onChange={e => { setFile(e.target.files?.[0] || null); setError(""); }} /><span className="hint-inline">{FILE_HINT}</span></label>
          <button className="primary" disabled={busy}>{busy ? "Publishing…" : "Publish test"}</button>
        </form></section>
      <section className="panel"><h2>Enter marks</h2>
        <form className="form-grid" onSubmit={addMark}>
          <select value={mark.testId} onChange={e => setMark({ ...mark, testId: e.target.value })} required><option value="">Select test</option>{data.tests.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select>
          <select value={mark.studentId} onChange={e => setMark({ ...mark, studentId: e.target.value })} required><option value="">Select student</option>{data.students.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <input type="number" min="0" step="0.5" max={data.tests.find(t => String(t.id) === String(mark.testId))?.max_marks || undefined} placeholder="Marks" value={mark.marks} onChange={e => setMark({ ...mark, marks: e.target.value })} required />
          <input placeholder="Remark" value={mark.remark} onChange={e => setMark({ ...mark, remark: e.target.value })} maxLength={1000} />
          <button className="primary">Save marks</button>
        </form></section>
      <section className="panel"><h2>Test history</h2>
        <List items={data.tests} render={t => (
          <div className="item"><div><b>{t.title}</b><small>{t.subject} • {t.max_marks} marks • {t.test_date || "No date"}</small>{t.has_file && <small>File: {t.file_name}</small>}</div>
            <div className="status-group"><strong>{t.average_percentage == null ? "—" : `${t.average_percentage}%`}</strong><small>{t.result_count || 0} results</small><FileUploadButton onChange={f => attach(t.id, f)} disabled={uploading === t.id} label={t.has_file ? "Replace file" : "Attach file"} /></div></div>
        )} /></section>
    </>
  );
}

export function TeacherRoom({ classInfo, ctx, pending = 0, goRequests, goTab = null, onTab }) {
  const [tab, setTab] = useState(goTab || "overview"), [data, setData] = useState(null), [selected, setSelected] = useState(null), [error, setError] = useState("");
  const load = () => api("/teacher/overview").then(d => { setError(""); setData(d); }).catch(e => setError(e.message));
  // Child effects run before the parent shell's effects, so the room selects its own class before its first request.
  useEffect(() => { setActiveClass(classInfo.id); load(); }, []);
  useEffect(() => { onTab?.(tab); }, [tab]);
  if (!data) return error ? <section className="panel"><ErrorBox error={error} /><button className="secondary" onClick={load}>Try again</button></section> : <Loading />;
  const nav = ["overview", "study activity", "homework", "tests", "results", "attendance", "syllabus", "students"];
  return (
    <>
      <div className="page-title">
        <h1>{classInfo.name}</h1>
        <p className="muted class-line">Class code <CopyChip value={classInfo.code} label="Class code" /> <span>{data.students.length} {data.students.length === 1 ? "student" : "students"}</span></p>
      </div>
      {pending > 0 && goRequests && <button className="notice-bar" onClick={goRequests}>{pending} {pending === 1 ? "student is" : "students are"} waiting to join your classes. Review requests</button>}
      <div className="tabs" role="tablist">{nav.map(n => <button key={n} role="tab" aria-selected={tab === n} className={tab === n ? "tab active" : "tab"} onClick={() => setTab(n)}>{n}</button>)}</div>
      {error && <ErrorBox error={error} />}
      {tab === "overview" && <TeacherOverview data={data} setTab={setTab} setSelected={setSelected} />}
      {tab === "study activity" && <TeacherStudyActivity data={data} selected={selected} setSelected={setSelected} />}
      {tab === "homework" && <TeacherHomework data={data} ctx={ctx} reload={load} />}
      {tab === "tests" && <TeacherTests data={data} reload={load} />}
      {tab === "results" && <TeacherResults data={data} />}
      {tab === "attendance" && <TeacherAttendance />}
      {tab === "syllabus" && <TeacherSyllabus />}
      {tab === "students" && <TeacherStudents data={data} selected={selected} setSelected={setSelected} reload={load} />}
    </>
  );
}
