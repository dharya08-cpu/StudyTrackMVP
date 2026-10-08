import React, { useCallback, useEffect, useState } from "react";
import { api, json } from "./api.js";
import { Stat, List, ErrorBox, Loading, MiniBars, Trend, DownloadFileButton, localDateInput, minutesToHours, trend } from "./ui.jsx";
import { Layout } from "./layout.jsx";
import { useUnread, NotificationCenter } from "./notifications.jsx";
import { StudentAnnouncements } from "./announcements.jsx";
import { CalendarView } from "./calendar.jsx";
import { GoalsCard, StudentPlanner } from "./planner.jsx";
import { StudentClasses } from "./student-classes.jsx";
import { SecurityPage } from "./security.jsx";

const TABS = ["overview", "study", "homework", "tests", "attendance", "syllabus", "planner", "calendar", "announcements", "classes", "notifications", "security"];

export function StudentApp({ user, logout, onProfile, onSignedOut }) {
  const [tab, setTab] = useState("overview");
  const [scope, setScope] = useState("");           // "" = all classes, otherwise one class id
  const [data, setData] = useState(null), [goals, setGoals] = useState(null);
  const [attendance, setAttendance] = useState(null), [syllabus, setSyllabus] = useState(null);
  const [log, setLog] = useState({ category: "self-study", subject: "", minutes: "", studyDate: localDateInput(), note: "" });
  const [note, setNote] = useState({});
  const [error, setError] = useState(""), [sectionError, setSectionError] = useState("");
  const [unread, refreshUnread] = useUnread();
  const qs = scope ? `?classId=${scope}` : "";

  const load = useCallback(() => api(`/student/dashboard${qs}`).then(d => { setData(d); setError(""); }).catch(e => { if (e.status === 404 && scope) setScope(""); else setError(e.message); }), [qs, scope]);
  const loadGoals = useCallback(() => api("/student/goals").then(setGoals).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadGoals(); }, [loadGoals]);
  useEffect(() => {
    setSectionError("");
    if (tab === "attendance") api(`/student/attendance${qs}`).then(setAttendance).catch(e => setSectionError(e.message));
    if (tab === "syllabus") api(`/student/syllabus${qs}`).then(setSyllabus).catch(e => setSectionError(e.message));
  }, [tab, qs]);

  const goTab = t => { setTab(t); if (t === "notifications") refreshUnread(); };
  if (!data) return error ? <Layout user={user} title="Student dashboard" logout={logout}><ErrorBox error={error} /><button className="primary" onClick={load}>Try again</button></Layout> : <Loading />;

  const submit = async id => { try { await api(`/student/homework/${id}/submit`, { method: "POST", body: json({ note: note[id] || "" }) }); load(); } catch (e) { setError(e.message); } };
  const addLog = async e => { e.preventDefault(); setError(""); try { await api("/student/study-log", { method: "POST", body: json(log) }); setLog({ ...log, subject: "", minutes: "", note: "" }); load(); loadGoals(); } catch (err) { setError(err.message); } };
  const delLog = async id => { try { await api(`/student/study-log/${id}`, { method: "DELETE" }); load(); loadGoals(); } catch (e) { setError(e.message); } };
  const week = minutesToHours(data.stats.week_minutes), total = minutesToHours(data.stats.total_study_minutes);
  const paused = data.classes.filter(c => !c.available);
  const multi = data.classes.length > 1;

  return (
    <Layout user={user} title={`Welcome back, ${user.name.split(" ")[0]}`} logout={logout} nav={TABS} tab={tab} setTab={goTab} unread={unread} onBell={() => goTab("notifications")}>
      {data.classes.length === 0 && tab !== "classes" && <button className="notice-bar" onClick={() => goTab("classes")}>You haven't joined a class yet. Enter a class code to join one. You can still log study time, set goals and plan your week.</button>}
      {paused.map(c => <div className="banner" key={c.id} role="status"><b>{c.name}</b>: {c.unavailable_reason}</div>)}
      {multi && ["overview", "study", "homework", "tests", "attendance", "syllabus", "calendar"].includes(tab) && (
        <div className="class-chips" role="group" aria-label="Choose class">
          <button className={scope === "" ? "active" : ""} onClick={() => setScope("")}>All classes</button>
          {data.classes.filter(c => c.available).map(c => <button key={c.id} className={String(scope) === String(c.id) ? "active" : ""} onClick={() => setScope(String(c.id))}>{c.name}</button>)}
        </div>
      )}
      <ErrorBox error={error} />{sectionError && <ErrorBox error={sectionError} />}
      {tab === "overview" && <><GoalsCard goals={goals} onChanged={loadGoals} /><Overview data={data} week={week} total={total} setTab={goTab} /></>}
      {tab === "study" && <Study data={data} log={log} setLog={setLog} addLog={addLog} delLog={delLog} />}
      {tab === "homework" && <Homework data={data} note={note} setNote={setNote} submit={submit} multi={multi} />}
      {tab === "tests" && <Tests data={data} multi={multi} />}
      {tab === "attendance" && <Attendance data={attendance} />}
      {tab === "syllabus" && <Syllabus data={syllabus} multi={multi} />}
      {tab === "planner" && <StudentPlanner />}
      {tab === "calendar" && <CalendarView classes={data.classes.filter(c => c.available)} />}
      {tab === "announcements" && <StudentAnnouncements />}
      {tab === "classes" && <StudentClasses onChanged={() => { load(); refreshUnread(); }} />}
      {tab === "notifications" && <NotificationCenter onChanged={refreshUnread} />}
      {tab === "security" && <SecurityPage user={user} onSignedOut={onSignedOut} onProfile={onProfile} />}
    </Layout>
  );
}

function Overview({ data, week, total, setTab }) {
  const submitted = data.homework.filter(x => x.submitted_at).length;
  return (
    <>
      <div className="grid four"><Stat label="This week" value={`${week}h`} sub={<Trend value={data.stats.study_trend} />} /><Stat label="Study total" value={`${total}h`} /><Stat label="Test average" value={`${Number(data.stats.average_percentage || 0).toFixed(1)}%`} /><Stat label="Attendance" value={`${data.stats.attendance_percentage || 0}%`} /></div>
      <div className="grid four"><Stat label="Syllabus" value={`${data.stats.syllabus_percentage || 0}%`} /><Stat label="Tests taken" value={data.stats.tests_taken || 0} /><Stat label="Homework" value={`${submitted}/${data.homework.length}`} /><Stat label="Classes" value={data.classes.length} /></div>
      <div className="dashboard-grid">
        <section className="panel"><div className="panel-head"><h2>Study by subject</h2><button className="secondary" onClick={() => setTab("study")}>Open study</button></div><MiniBars items={data.subjects} /></section>
        <section className="panel"><div className="panel-head"><h2>Study type</h2><button className="secondary" onClick={() => setTab("planner")}>Plan my week</button></div><MiniBars items={data.categories} labelKey="category" /></section>
      </div>
      <section className="panel"><div className="panel-head"><h2>Recent activity</h2><button className="secondary" onClick={() => setTab("homework")}>Homework</button></div>
        <List items={data.logs.slice(0, 8)} render={x => <div className="activity"><div className="activity-dot study" /><div><b>{x.subject}</b><span> {x.category} • {x.minutes} minutes</span><small>{x.study_date}</small></div></div>} /></section>
    </>
  );
}
function Study({ data, log, setLog, addLog, delLog }) {
  return (
    <>
      <section className="panel"><h2>Log study time</h2>
        <form className="form-grid" onSubmit={addLog}>
          <select value={log.category} onChange={e => setLog({ ...log, category: e.target.value })} aria-label="Study type"><option value="self-study">Self-study</option><option value="tuition">Tuition</option><option value="outside">Outside</option></select>
          <input placeholder="Subject" value={log.subject} onChange={e => setLog({ ...log, subject: e.target.value })} maxLength={100} required />
          <input type="number" min="1" max="1440" placeholder="Minutes" value={log.minutes} onChange={e => setLog({ ...log, minutes: e.target.value })} required />
          <input type="date" value={log.studyDate} max={localDateInput()} onChange={e => setLog({ ...log, studyDate: e.target.value })} />
          <input placeholder="Note (optional)" value={log.note} onChange={e => setLog({ ...log, note: e.target.value })} maxLength={2000} />
          <button className="primary">Add session</button>
        </form></section>
      <section className="panel"><div className="panel-head"><h2>Study summary</h2><span className="pill">{minutesToHours(data.stats.week_minutes)}h this week</span></div><MiniBars items={data.subjects} /></section>
      <section className="panel"><h2>Recent study</h2><List items={data.logs} render={x => <div className="item"><div><b>{x.subject}</b><small>{x.study_date} • {x.category}</small></div><div className="status-group"><strong>{x.minutes} min</strong><button className="link" aria-label="Delete study log" onClick={() => delLog(x.id)}>✕</button></div></div>} /></section>
    </>
  );
}
function Homework({ data, note, setNote, submit, multi }) {
  return (
    <section className="panel"><h2>Homework</h2>
      <List items={data.homework} empty="No homework yet." render={h => (
        <div className="item">
          <div>
            <b>{h.title}</b>{multi && <span className="class-tag">{h.class_name}</span>}
            {h.description && <p className="pre">{h.description}</p>}
            <small>Due: {h.due_date || "No date"}</small>{h.has_file && <small>Attachment: {h.file_name}</small>}
            <div className="status-group"><span className={`badge ${h.status || "pending"}`}>{h.status || "pending"}</span>{h.feedback && <small>Feedback: {h.feedback}</small>}{h.has_file && <DownloadFileButton type="homework" id={h.id} />}</div>
          </div>
          {h.status !== "reviewed" && <div className="submit-box"><input placeholder="Submission note" value={note[h.id] ?? h.submission_note ?? ""} onChange={e => setNote({ ...note, [h.id]: e.target.value })} maxLength={5000} /><button className="primary small-btn" onClick={() => submit(h.id)}>{h.submitted_at ? "Update" : "Submit"}</button></div>}
        </div>
      )} /></section>
  );
}
function Tests({ data, multi }) {
  const scores = data.tests.filter(t => t.marks != null);
  const trendValue = scores.length > 1 ? trend(scores[0].percentage, scores[1].percentage) : "stable";
  return (
    <>
      <section className="panel"><div className="grid three"><Stat label="Average" value={`${Number(data.stats.average_percentage || 0).toFixed(1)}%`} /><Stat label="Latest" value={scores[0] ? `${scores[0].percentage}%` : "—"} /><Stat label="Trend" value={<Trend value={trendValue} />} /></div></section>
      <section className="panel"><h2>Score history</h2>
        <List items={data.tests} render={t => (
          <div className="score-row"><span><b>{t.title}</b>{multi && <span className="class-tag">{t.class_name}</span>}<small>{t.subject} • {t.test_date || "No date"}</small>{t.has_file && <small>Attachment: {t.file_name}</small>}{t.has_file && <DownloadFileButton type="tests" id={t.id} />}</span><b>{t.marks == null ? "—" : `${t.marks}/${t.max_marks}`}</b><strong>{t.percentage == null ? "—" : `${t.percentage}%`}</strong></div>
        )} /></section>
    </>
  );
}
function Attendance({ data }) {
  if (!data) return <Loading />;
  return (
    <>
      <div className="grid four"><Stat label="Attendance" value={`${data.percentage}%`} /><Stat label="Present" value={data.present} /><Stat label="Absent" value={data.absent} /><Stat label="Current streak" value={`${data.currentStreak} days`} /><Stat label="Longest streak" value={`${data.longestStreak} days`} /></div>
      <section className="panel"><h2>Attendance history</h2><List items={data.records.map((x, i) => ({ ...x, id: `${x.attendance_date}-${x.class_id}-${i}` }))} render={x => <div className="item"><b>{x.attendance_date}</b><span className={`badge ${x.status}`}>{x.status}</span></div>} /></section>
    </>
  );
}
function Syllabus({ data, multi }) {
  if (!data) return <Loading />;
  if (!data.subjects.length) return <section className="panel"><div className="empty">Your teachers haven't added a syllabus yet.</div></section>;
  return <>{data.subjects.map(s => (
    <section className="panel" key={`${s.class_id}-${s.subject}`}>
      <div className="panel-head"><div><h2>{s.subject}{multi && <span className="class-tag">{s.class_name}</span>}</h2><p className="muted">{s.completed}/{s.total} chapters completed</p></div><b>{s.percentage}%</b></div>
      <div className="progress"><i style={{ width: `${s.percentage}%` }} /></div>
      <List items={s.chapters} render={c => <div className="item"><div><b>{c.chapter}</b></div><span className={`badge ${c.status}`}>{c.status}</span></div>} />
    </section>
  ))}</>;
}
