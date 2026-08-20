import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API = import.meta.env.VITE_API_URL || "/api";

async function api(path, options={}) {
  const token = localStorage.getItem("studytrack_token");
  const res = await fetch(API + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function App() {
  const [user, setUser] = useState(null);
  const [role, setRole] = useState("student");
  const [mode, setMode] = useState("login");

  useEffect(() => {
    const token = localStorage.getItem("studytrack_token");
    if (token) api("/me").then(x => setUser(x.user)).catch(() => localStorage.removeItem("studytrack_token"));
  }, []);

  if (!user) {
    return <Auth role={role} setRole={setRole} mode={mode} setMode={setMode} onLogin={setUser} />;
  }

  return user.role === "teacher"
    ? <TeacherApp user={user} logout={() => { localStorage.clear(); setUser(null); }} />
    : <StudentApp user={user} logout={() => { localStorage.clear(); setUser(null); }} />;
}

function Auth({ role, setRole, mode, setMode, onLogin }) {
  const [form, setForm] = useState({ name:"", email:"", password:"", classCode:"" });
  const [error, setError] = useState("");
  const submit = async e => {
    e.preventDefault(); setError("");
    try {
      const path = mode === "register" ? "/auth/register" : "/auth/login";
      const body = mode === "register"
        ? form
        : { email:form.email, password:form.password, role };
      const data = await api(path, { method:"POST", body:JSON.stringify(body) });
      localStorage.setItem("studytrack_token", data.token);
      onLogin(data.user);
    } catch (e) { setError(e.message); }
  };

  return <main className="auth">
    <div className="auth-card">
      <div className="brand">Study<span>Track</span></div>
      <p className="muted">Your coaching + self-study progress companion.</p>

      <div className="role-switch">
        <button className={role==="student" ? "active":""} onClick={()=>{setRole("student");setMode("login")}}>Student</button>
        <button className={role==="teacher" ? "active":""} onClick={()=>{setRole("teacher");setMode("login")}}>Teacher</button>
      </div>

      <h1>{mode==="login" ? `Login as ${role}` : "Student registration"}</h1>

      <form onSubmit={submit}>
        {mode==="register" && <input placeholder="Full name" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} />}
        <input type="email" placeholder="Email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})} required />
        <input type="password" placeholder="Password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})} required />
        {mode==="register" && <input placeholder="Class code (e.g. DEMO01)" value={form.classCode} onChange={e=>setForm({...form,classCode:e.target.value})} required />}
        {error && <div className="error">{error}</div>}
        <button className="primary" type="submit">{mode==="login" ? "Login" : "Create student account"}</button>
      </form>

      {role==="student" && <button className="link" onClick={()=>setMode(mode==="login"?"register":"login")}>
        {mode==="login" ? "New student? Register with class code" : "Already have an account? Login"}
      </button>}

      <div className="demo">
        <b>Demo</b><br/>
        Teacher: teacher@coaching.com / teacher123<br/>
        Student: student@coaching.com / student123
      </div>
    </div>
  </main>;
}

function Layout({ user, title, children, logout }) {
  return <div className="app">
    <header>
      <div className="brand small">Study<span>Track</span></div>
      <div className="userbar"><span>{user.name}</span><span className="pill">{user.role}</span><button onClick={logout}>Logout</button></div>
    </header>
    <main className="container">
      <div className="page-title"><h1>{title}</h1><p className="muted">Track progress. Stay accountable. Improve.</p></div>
      {children}
    </main>
  </div>;
}

function TeacherApp({user,logout}) {
  const [data,setData] = useState(null);
  const [selected,setSelected] = useState(null);
  const [tab,setTab] = useState("overview");
  const [home,setHome] = useState({title:"",description:"",dueDate:""});
  const [test,setTest] = useState({title:"",subject:"",maxMarks:"",solution:"",testDate:""});
  const [mark,setMark] = useState({testId:"",studentId:"",marks:"",remark:""});
  const load=()=>api("/teacher/overview").then(setData).catch(e=>alert(e.message));
  useEffect(load,[]);

  if (!data) return <div className="loading">Loading StudyTrack…</div>;

  const addHomework=async e=>{
    e.preventDefault();
    await api("/teacher/homework",{method:"POST",body:JSON.stringify(home)});
    setHome({title:"",description:"",dueDate:""}); load();
  };
  const addTest=async e=>{
    e.preventDefault();
    await api("/teacher/tests",{method:"POST",body:JSON.stringify(test)});
    setTest({title:"",subject:"",maxMarks:"",solution:"",testDate:""}); load();
  };
  const addMark=async e=>{
    e.preventDefault();
    await api("/teacher/marks",{method:"POST",body:JSON.stringify(mark)});
    setMark({testId:"",studentId:"",marks:"",remark:""}); alert("Marks saved");
  };

  return <Layout user={user} title="Teacher dashboard" logout={logout}>
    <div className="tabs">
      {["overview","homework","tests","students"].map(x=><button className={tab===x?"tab active":"tab"} onClick={()=>setTab(x)} key={x}>{x}</button>)}
    </div>

    {tab==="overview" && <div className="grid four">
      <Stat label="Students" value={data.students.length}/>
      <Stat label="Homework" value={data.homework.length}/>
      <Stat label="Tests" value={data.tests.length}/>
      <Stat label="Class code" value={data.class?.code || "—"}/>
    </div>}

    {tab==="homework" && <section className="panel">
      <h2>Create homework</h2>
      <form className="form-grid" onSubmit={addHomework}>
        <input placeholder="Title" value={home.title} onChange={e=>setHome({...home,title:e.target.value})} required/>
        <input type="date" value={home.dueDate} onChange={e=>setHome({...home,dueDate:e.target.value})}/>
        <textarea placeholder="Description / instructions" value={home.description} onChange={e=>setHome({...home,description:e.target.value})}/>
        <button className="primary">Publish homework</button>
      </form>
      <h2>Published</h2>
      <List items={data.homework} render={h=><Card title={h.title} meta={`Due: ${h.due_date||"No date"}`} body={h.description}/>}/>
    </section>}

    {tab==="tests" && <section className="panel">
      <h2>Create test</h2>
      <form className="form-grid" onSubmit={addTest}>
        <input placeholder="Test title" value={test.title} onChange={e=>setTest({...test,title:e.target.value})} required/>
        <input placeholder="Subject" value={test.subject} onChange={e=>setTest({...test,subject:e.target.value})} required/>
        <input type="number" placeholder="Max marks" value={test.maxMarks} onChange={e=>setTest({...test,maxMarks:e.target.value})} required/>
        <input type="date" value={test.testDate} onChange={e=>setTest({...test,testDate:e.target.value})}/>
        <textarea placeholder="Solution / analysis" value={test.solution} onChange={e=>setTest({...test,solution:e.target.value})}/>
        <button className="primary">Publish test</button>
      </form>
      <h2>Enter marks</h2>
      <form className="form-grid" onSubmit={addMark}>
        <select value={mark.testId} onChange={e=>setMark({...mark,testId:e.target.value})} required>
          <option value="">Select test</option>{data.tests.map(t=><option value={t.id} key={t.id}>{t.title}</option>)}
        </select>
        <select value={mark.studentId} onChange={e=>setMark({...mark,studentId:e.target.value})} required>
          <option value="">Select student</option>{data.students.map(s=><option value={s.id} key={s.id}>{s.name}</option>)}
        </select>
        <input type="number" placeholder="Marks" value={mark.marks} onChange={e=>setMark({...mark,marks:e.target.value})} required/>
        <input placeholder="Remark" value={mark.remark} onChange={e=>setMark({...mark,remark:e.target.value})}/>
        <button className="primary">Save marks</button>
      </form>
      <List items={data.tests} render={t=><Card title={t.title} meta={`${t.subject} • ${t.max_marks} marks • ${t.test_date||"No date"}`} body={t.solution||"No solution published yet."}/>}/>
    </section>}

    {tab==="students" && <section className="panel">
      <h2>Students</h2>
      <div className="student-grid">{data.students.map(s=><button className="student-card" key={s.id} onClick={()=>setSelected(s.id)}>{s.name}<small>{s.email}</small></button>)}</div>
      {selected && <StudentAnalytics id={selected}/>}
    </section>}
  </Layout>
}

function StudentAnalytics({id}) {
  const [a,setA]=useState(null);
  useEffect(()=>api(`/teacher/student/${id}/analytics`).then(setA),[id]);
  if(!a) return <p>Loading analytics…</p>;
  return <div className="analytics">
    <h3>{a.student.name}</h3>
    <div className="grid three">
      <Stat label="Average" value={`${a.averagePercentage}%`}/>
      <Stat label="Improvement" value={`${a.improvementPercentage >= 0 ? "+" : ""}${a.improvementPercentage}%`}/>
      <Stat label="Score records" value={a.scores.length}/>
    </div>
    <h4>Score trend</h4>
    {a.scores.length===0 ? <p className="muted">No marks yet.</p> : a.scores.map((s,i)=><div className="score-row" key={i}><span>{s.title}</span><b>{s.marks}/{s.max_marks}</b><span>{s.remark}</span></div>)}
  </div>
}

function StudentApp({user,logout}) {
  const [data,setData]=useState(null);
  const [log,setLog]=useState({category:"self-study",subject:"",minutes:"",studyDate:new Date().toISOString().slice(0,10),note:""});
  const [note,setNote]=useState({});
  const load=()=>api("/student/dashboard").then(setData);
  useEffect(load,[]);

  if(!data) return <div className="loading">Loading StudyTrack…</div>;

  const total=Math.round((data.stats.total_study_minutes||0)/60*10)/10;
  const submit=async(id)=>{
    await api(`/student/homework/${id}/submit`,{method:"POST",body:JSON.stringify({note:note[id]||""})});
    load();
  };
  const addLog=async e=>{
    e.preventDefault();
    await api("/student/study-log",{method:"POST",body:JSON.stringify(log)});
    setLog({...log,subject:"",minutes:"",note:""}); load();
  };

  return <Layout user={user} title={`Welcome back, ${user.name.split(" ")[0]}`} logout={logout}>
    <div className="grid four">
      <Stat label="Average score" value={`${Number(data.stats.average_percentage||0).toFixed(1)}%`}/>
      <Stat label="Tests" value={data.stats.tests_taken||0}/>
      <Stat label="Study hours" value={total}/>
      <Stat label="Class code" value={user.class_code||"—"}/>
    </div>

    <div className="dashboard-grid">
      <section className="panel">
        <h2>Homework</h2>
        <List items={data.homework} render={h=><div className="item">
          <div><b>{h.title}</b><p>{h.description}</p><small>Due: {h.due_date||"No date"}</small></div>
          <div className="submit-box">
            <input placeholder="Submission note" value={note[h.id]||h.submission_note||""} onChange={e=>setNote({...note,[h.id]:e.target.value})}/>
            <button className="primary small-btn" onClick={()=>submit(h.id)}>{h.submitted_at?"Update":"Submit"}</button>
          </div>
        </div>}/>
      </section>

      <section className="panel">
        <h2>Tests & solutions</h2>
        <List items={data.tests} render={t=><Card title={t.title} meta={`${t.subject} • ${t.marks ?? "—"}/${t.max_marks}`} body={t.remark ? `${t.remark} | Solution: ${t.solution||"Not published"}` : `Solution: ${t.solution||"Not published"}`}/>}/>
      </section>
    </div>

    <section className="panel">
      <h2>Log study time</h2>
      <form className="form-grid four-cols" onSubmit={addLog}>
        <select value={log.category} onChange={e=>setLog({...log,category:e.target.value})}>
          <option value="self-study">Self-study</option><option value="tuition">Tuition</option><option value="outside">Outside</option>
        </select>
        <input placeholder="Subject" value={log.subject} onChange={e=>setLog({...log,subject:e.target.value})} required/>
        <input type="number" min="1" placeholder="Minutes" value={log.minutes} onChange={e=>setLog({...log,minutes:e.target.value})} required/>
        <input type="date" value={log.studyDate} onChange={e=>setLog({...log,studyDate:e.target.value})}/>
        <input placeholder="Note (optional)" value={log.note} onChange={e=>setLog({...log,note:e.target.value})}/>
        <button className="primary">Add session</button>
      </form>
    </section>

    <section className="panel">
      <h2>Recent study</h2>
      <List items={data.logs.slice(0,10)} render={x=><div className="score-row"><span>{x.study_date}</span><b>{x.subject}</b><span>{x.category} • {x.minutes} min</span></div>}/>
    </section>
  </Layout>
}

function Stat({label,value}) { return <div className="stat"><span>{label}</span><strong>{value}</strong></div> }
function Card({title,meta,body}) { return <div className="card"><b>{title}</b><small>{meta}</small><p>{body}</p></div> }
function List({items,render}) { return items.length ? <div className="list">{items.map((x,i)=><React.Fragment key={x.id||i}>{render(x)}</React.Fragment>)}</div> : <p className="muted">Nothing here yet.</p> }

createRoot(document.getElementById("root")).render(<App />);
