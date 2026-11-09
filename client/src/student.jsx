import React, { useCallback, useEffect, useState } from "react";
import { api, json } from "./api.js";
import { Stat, List, ErrorBox, Loading, MiniBars, Trend, localDateInput, minutesToHours, trend } from "./ui.jsx";
import { Layout } from "./layout.jsx";
import { Drawer, DrawerItem, DrawerLabel, DrawerSub, DrawerDivider } from "./menu.jsx";
import { AttachmentList, AttachManager, MultiFilePicker } from "./attachments.jsx";
import { useUnread, NotificationCenter } from "./notifications.jsx";
import { StudentAnnouncements } from "./announcements.jsx";
import { CalendarView } from "./calendar.jsx";
import { MyCalendarManager, PLAN_KINDS, dueInfo, fmtRange } from "./my-calendar.jsx";
import { ParentLinkPage } from "./parent.jsx";
import { GoalsCard, StudentPlanner } from "./planner.jsx";
import { StudentClasses } from "./student-classes.jsx";
import { SecurityPage } from "./security.jsx";

// Everything lives in the Menu now. `my-calendar` is the "Edit my calendar" page under Calendar.
const TITLES = {
  study: ["Study log", "Log what you studied and see where your time goes."],
  homework: ["Homework", "Instructions, files and your submissions."],
  tests: ["Tests", "Scores, trends and the papers your teachers shared."],
  attendance: ["Attendance", "How often you were present."],
  syllabus: ["Syllabus", "Chapter progress for each subject."],
  planner: ["Planner", "A weekly plan and what to study today."],
  calendar: null, "my-calendar": null,
  announcements: null, // these pages draw their own heading

  classes: ["My classes", "Join a class with a code from your teacher."],
  parent: null,
  notifications: null,
  security: null,
};
const SCOPED = ["overview", "study", "homework", "tests", "attendance", "syllabus"]; // the calendar has its own class filter

export function StudentApp({ user, logout, onProfile, onSignedOut, flash = "" }) {
  const [tab, setTab] = useState("overview");
  const [menuOpen, setMenuOpen] = useState(false), [calOpen, setCalOpen] = useState(true);
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

  const goTab = t => { setTab(t); setMenuOpen(false); window.scrollTo?.(0, 0); if (t === "notifications") refreshUnread(); };
  if (!data) return error ? <Layout user={user} logout={logout}><ErrorBox error={error} /><button className="primary" onClick={load}>Try again</button></Layout> : <Loading />;

  const addLog = async e => { e.preventDefault(); setError(""); try { await api("/student/study-log", { method: "POST", body: json(log) }); setLog({ ...log, subject: "", minutes: "", note: "" }); load(); loadGoals(); } catch (err) { setError(err.message); } };
  const delLog = async id => { try { await api(`/student/study-log/${id}`, { method: "DELETE" }); load(); loadGoals(); } catch (e) { setError(e.message); } };
  const week = minutesToHours(data.stats.week_minutes), total = minutesToHours(data.stats.total_study_minutes);
  const paused = data.classes.filter(c => !c.available);
  const multi = data.classes.length > 1;
  const openHomework = data.homework.filter(h => !h.submitted_at).length;
  const heading = tab === "overview" ? [`Welcome back, ${user.name.split(" ")[0]}`, "Understand your study, tests and progress."] : TITLES[tab];

  const item = (id, icon, label, extra = {}) => <DrawerItem icon={icon} active={tab === id} onClick={() => goTab(id)} {...extra}>{label}</DrawerItem>;
  const menu = menuOpen && (
    <Drawer label="Student menu" name={user.name} email={user.email} onClose={() => setMenuOpen(false)}>
      <DrawerLabel>My study</DrawerLabel>
      {item("overview", "🏠", "Overview")}
      {item("study", "📖", "Study log")}
      {item("homework", "📝", "Homework", { badge: openHomework })}
      {item("tests", "🧪", "Tests")}
      {item("attendance", "✅", "Attendance")}
      {item("syllabus", "📑", "Syllabus")}
      <DrawerLabel>Plan</DrawerLabel>
      {item("planner", "🧭", "Planner")}
      <DrawerItem icon="📅" expanded={calOpen} active={tab === "calendar" || tab === "my-calendar"} onClick={() => setCalOpen(o => !o)}>Calendar</DrawerItem>
      {calOpen && <DrawerSub>
        <DrawerItem sub active={tab === "calendar"} onClick={() => goTab("calendar")}>View calendar</DrawerItem>
        <DrawerItem sub active={tab === "my-calendar"} onClick={() => goTab("my-calendar")}>Edit my calendar</DrawerItem>
      </DrawerSub>}
      <DrawerLabel>Classes</DrawerLabel>
      {item("announcements", "📢", "Announcements")}
      {item("classes", "🎒", "My classes")}
      {item("parent", "👪", "Parent view")}
      <DrawerDivider />
      {item("notifications", "🔔", "Notifications", { badge: unread })}
      {item("security", "🔒", "Security & privacy")}
    </Drawer>
  );

  return (
    <Layout user={user} title={heading?.[0]} subtitle={heading?.[1]} logout={logout} onMenu={() => setMenuOpen(true)} menuBadge={unread} unread={unread} onBell={() => goTab("notifications")}>
      {data.classes.length === 0 && tab !== "classes" && <button className="notice-bar" onClick={() => goTab("classes")}>You haven't joined a class yet. Enter a class code to join one. You can still log study time, set goals and plan your week.</button>}
      {paused.map(c => <div className="banner" key={c.id} role="status"><b>{c.name}</b>: {c.unavailable_reason}</div>)}
      {multi && SCOPED.includes(tab) && (
        <div className="class-chips" role="group" aria-label="Choose class">
          <button className={scope === "" ? "active" : ""} onClick={() => setScope("")}>All classes</button>
          {data.classes.filter(c => c.available).map(c => <button key={c.id} className={String(scope) === String(c.id) ? "active" : ""} onClick={() => setScope(String(c.id))}>{c.name}</button>)}
        </div>
      )}
      {flash && <div className="notice" role="status">{flash}</div>}
      <ErrorBox error={error} />{sectionError && <ErrorBox error={sectionError} />}
      {tab === "overview" && <><GoalsCard goals={goals} onChanged={loadGoals} /><MineSoon go={goTab} /><Overview data={data} week={week} total={total} setTab={goTab} /></>}
      {tab === "study" && <Study data={data} log={log} setLog={setLog} addLog={addLog} delLog={delLog} />}
      {tab === "homework" && <Homework data={data} note={note} setNote={setNote} reload={load} multi={multi} />}
      {tab === "tests" && <Tests data={data} multi={multi} />}
      {tab === "attendance" && <Attendance data={attendance} />}
      {tab === "syllabus" && <Syllabus data={syllabus} multi={multi} />}
      {tab === "planner" && <StudentPlanner />}
      {tab === "calendar" && <CalendarView classes={data.classes.filter(c => c.available)} personal />}
      {tab === "my-calendar" && <MyCalendarManager />}
      {tab === "parent" && <ParentLinkPage user={user} />}
      {tab === "announcements" && <StudentAnnouncements />}
      {tab === "classes" && <StudentClasses onChanged={() => { load(); refreshUnread(); }} />}
      {tab === "notifications" && <NotificationCenter onChanged={refreshUnread} />}
      {tab === "security" && <SecurityPage user={user} onSignedOut={onSignedOut} onProfile={onProfile} />}
      {menu}
    </Layout>
  );
}

// The next few things the student planned for themselves, on the home screen.
function MineSoon({ go }) {
  const [data, setData] = useState(null);
  useEffect(() => { api("/student/plan-items?status=open").then(setData).catch(() => setData({ items: [], today: "" })); }, []);
  if (!data || !data.items.length) return null;
  const items = data.items.slice(0, 3);
  return (
    <section className="panel">
      <div className="panel-head"><div><h2>Coming up on my calendar</h2><p className="muted">Your own goals and revision plans, soonest first.</p></div><button className="secondary" onClick={() => go("my-calendar")}>Edit my calendar</button></div>
      <List items={items} render={i => { const due = dueInfo(i, data.today); return <div className={`item cal-item ${i.kind}`}><div><b>{PLAN_KINDS[i.kind].icon} {i.title}</b><small>{i.subject ? `${i.subject} • ` : ""}{fmtRange(i.start_date, i.end_date)}</small></div><span className={`due-chip ${due.tone}`}>{due.text}</span></div>; }} />
    </section>
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
function Homework({ data, note, setNote, reload, multi }) {
  return (
    <section className="panel"><h2>Assigned to you</h2>
      <List items={data.homework} empty="No homework yet." render={h => (
        <div className="item col">
          <div>
            <b>{h.title}</b>{multi && <span className="class-tag">{h.class_name}</span>}
            {h.description && <p className="pre">{h.description}</p>}
            <small>Due: {h.due_date || "No date"}</small>
            <div className="status-group"><span className={`badge ${h.status || "pending"}`}>{h.status || "pending"}</span>{h.feedback && <small>Feedback: {h.feedback}</small>}</div>
            {h.attachments.length > 0 && <><div className="files-head"><b>Files from your teacher ({h.attachments.length})</b></div><AttachmentList items={h.attachments} /></>}
          </div>
          <HomeworkWork h={h} note={note} setNote={setNote} reload={reload} />
        </div>
      )} /></section>
  );
}

// "Your work": a note and files (PDF, photo, Word). Submit first; then files can be added or removed until the teacher reviews it.
function HomeworkWork({ h, note, setNote, reload }) {
  const [files, setFiles] = useState([]), [busy, setBusy] = useState(null), [error, setError] = useState(""), [message, setMessage] = useState("");
  const reviewed = h.status === "reviewed", submitted = Boolean(h.submitted_at);
  const text = note[h.id] ?? h.submission_note ?? "";
  const send = async () => {
    setError(""); setMessage(""); setBusy("Submitting…");
    try {
      await api(`/student/homework/${h.id}/submit`, { method: "POST", body: json({ note: text }) });
      const failed = [];
      for (let i = 0; i < files.length; i++) {
        setBusy(`Uploading ${i + 1} of ${files.length}…`);
        const body = new FormData(); body.append("file", files[i]);
        try { await api(`/student/homework/${h.id}/files`, { method: "POST", body }); } catch (e) { failed.push(`${files[i].name}: ${e.message}`); }
      }
      setFiles([]);
      if (failed.length) setError(`Your homework was submitted, but some files did not upload. ${failed.join(" ")} You can add them again below.`);
      else setMessage(files.length ? "Submitted with your files." : "Submitted.");
      await reload();
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  };
  if (reviewed) return (h.my_files?.length > 0 ? <div><AttachManager readOnly attachments={h.my_files} viewBase="submission-files" title="Your files" /><small className="muted">Reviewed by your teacher, so it can't be changed.</small></div> : null);
  return (
    <div className="work-box">
      <b className="work-title">{submitted ? "Your submission" : "Hand in your work"}</b>
      <div className="submit-box"><input placeholder="Submission note (optional)" aria-label="Submission note" value={text} onChange={e => setNote({ ...note, [h.id]: e.target.value })} maxLength={5000} />
        {submitted && <button className="secondary small-btn" disabled={Boolean(busy)} onClick={send}>{busy || "Update note"}</button>}</div>
      {submitted
        ? <AttachManager attachments={h.my_files || []} uploadPath={`/student/homework/${h.id}/files`} removeBase="/student/submission-files" viewBase="submission-files" max={5} title="Your files" onChanged={reload} onMessage={setMessage} />
        : <>
          <MultiFilePicker files={files} onChange={setFiles} onError={setError} label="Attach your work (optional): PDF, photo or Word file" />
          <div><button className="primary" disabled={Boolean(busy)} onClick={send}>{busy || (files.length ? `Submit with ${files.length} ${files.length === 1 ? "file" : "files"}` : "Submit")}</button></div>
        </>}
      {error && <p className="error-text" role="alert">{error}</p>}{message && <p className="success-text" role="status">{message}</p>}
    </div>
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
          <div className="test-card"><div className="score-row"><span><b>{t.title}</b>{multi && <span className="class-tag">{t.class_name}</span>}<small>{t.subject} • {t.test_date || "No date"}</small></span><b>{t.marks == null ? "—" : `${t.marks}/${t.max_marks}`}</b><strong>{t.percentage == null ? "—" : `${t.percentage}%`}</strong></div>{t.attachments.length > 0 && <div className="test-files"><div className="files-head"><b>Files ({t.attachments.length})</b></div><AttachmentList items={t.attachments} /></div>}</div>
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
