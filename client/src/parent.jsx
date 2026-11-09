import React, { useCallback, useEffect, useState } from "react";
import { api, json } from "./api.js";
import { Stat, List, ErrorBox, Loading, fmtMinutes } from "./ui.jsx";

// Parent view. A student can share a read-only weekly summary through a secret link. The secret is in the link's
// #fragment, so it is never sent to the server in the address, logged, or passed on in a Referer header.

const DAY = d => new Date(`${d}T12:00:00Z`).toLocaleDateString([], { weekday: "short", timeZone: "UTC" });
const fmt = d => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString([], { day: "numeric", month: "short", timeZone: "UTC" }) : "No date");
const KIND = { homework: ["📝", "Homework due"], test: ["🧪", "Test"], exam: ["🎓", "Exam"] };
const when = iso => (iso ? new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "Not opened yet");

// The summary itself: used by the parent's page and by the student's preview.
export function ParentSummary({ summary: s }) {
  const study = s.study, diff = study.week_minutes - study.last_week_minutes;
  return (
    <>
      <div className="grid four">
        <Stat label="Studied this week" value={fmtMinutes(study.week_minutes)} sub={study.goal.weekly_minutes ? `Goal ${fmtMinutes(study.goal.weekly_minutes)} (${study.weekly_percent}%)` : "No weekly goal set"} />
        <Stat label="Study streak" value={`${study.streak} ${study.streak === 1 ? "day" : "days"}`} sub="Days in a row meeting the daily goal" />
        <Stat label="Test average" value={s.tests.average == null ? "—" : `${s.tests.average}%`} sub={s.tests.recent.length ? `${s.tests.recent.length} recent ${s.tests.recent.length === 1 ? "test" : "tests"}` : "No marks yet"} />
        <Stat label="Attendance" value={s.attendance.percentage == null ? "—" : `${s.attendance.percentage}%`} sub={`Last ${s.attendance.days} days`} />
      </div>

      <section className="panel">
        <div className="panel-head"><div><h2>Study this week</h2><p className="muted">{diff === 0 ? "The same as last week." : diff > 0 ? `${fmtMinutes(diff)} more than last week.` : `${fmtMinutes(-diff)} less than last week.`}</p></div></div>
        <div className="week-ticks" role="list" aria-label="Study each day this week">
          {study.days.map(d => <span role="listitem" key={d.date} className={`tick${d.status === "met" ? " done" : ""}`}>{DAY(d.date)} {d.minutes ? fmtMinutes(d.minutes) : "–"}{d.status === "met" ? " ✓" : ""}</span>)}
        </div>
        {study.subjects.length > 0 && <div className="bars" style={{ marginTop: 14 }}>{study.subjects.map(x => <div className="bar-row" key={x.subject}><span>{x.subject}</span><div><i style={{ width: `${Math.min(100, Math.round(x.minutes * 100 / Math.max(...study.subjects.map(y => y.minutes))))}%` }} /></div><b>{fmtMinutes(x.minutes)}</b></div>)}</div>}
      </section>

      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-head"><div><h2>Homework</h2><p className="muted">{s.homework.submitted_this_week} handed in this week · {s.homework.open} open{s.homework.overdue ? ` · ${s.homework.overdue} overdue` : ""}</p></div></div>
          <List items={s.homework.pending} empty="Nothing waiting. All homework is handed in." render={h => <div className="item"><div><b>{h.title}</b><small>{h.class_name}</small></div><span className={`due-chip ${h.overdue ? "overdue" : ""}`}>{h.due_date ? `${h.overdue ? "Overdue · " : "Due "}${fmt(h.due_date)}` : "No due date"}</span></div>} />
        </section>
        <section className="panel">
          <div className="panel-head"><div><h2>Recent tests</h2><p className="muted">The latest marks.</p></div></div>
          <List items={s.tests.recent} empty="No marks yet." render={t => <div className="score-row"><span><b>{t.title}</b><small>{t.subject} · {fmt(t.test_date)}</small></span><b>{t.marks}/{t.max_marks}</b><strong>{t.percentage}%</strong></div>} />
        </section>
      </div>

      <section className="panel">
        <div className="panel-head"><div><h2>Coming up this week</h2><p className="muted">Homework due, tests and exams in the next 7 days.</p></div></div>
        <List items={s.upcoming} empty="Nothing due in the next 7 days." render={u => <div className="item"><div><b>{KIND[u.kind][0]} {u.title}</b><small>{KIND[u.kind][1]}</small></div><span className="due-chip">{fmt(u.date)}</span></div>} />
        {(s.own_goals.open > 0 || s.own_goals.finished_this_week > 0) && <p className="hint" style={{ marginTop: 12 }}>Personal study plan: {s.own_goals.open} open · {s.own_goals.finished_this_week} finished this week.</p>}
      </section>
    </>
  );
}

// ---- The page a parent opens (no sign-in) ----
export function ParentPage() {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    const token = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    if (!token) { setState({ error: "This link is incomplete. Ask the student to share it again." }); return; }
    api("/parent/view", { method: "POST", body: json({ token }) }).then(d => setState({ data: d })).catch(e => setState({ error: e.message }));
  }, []);
  const { data, error, loading } = state;
  return (
    <main className="container parent-page">
      <div className="parent-top"><div className="brand small">Study<span>Track</span></div>{data && <button className="secondary small-btn no-print" onClick={() => window.print()}>Print or save as PDF</button>}</div>
      {loading && <Loading />}
      {error && <section className="panel status-panel"><h1>Link not available</h1><p className="muted">{error}</p></section>}
      {data && (
        <>
          <div className="page-title">
            <h1>{data.summary.student.first_name}'s week</h1>
            <p className="muted">{data.summary.student.parent_name ? `For ${data.summary.student.parent_name}. ` : ""}{fmt(data.summary.week.start)} to {fmt(data.summary.week.end)}{data.summary.student.classes.length ? ` · ${data.summary.student.classes.join(", ")}` : ""}</p>
          </div>
          <ParentSummary summary={data.summary} />
          <p className="hint parent-foot">A read-only summary shared by {data.summary.student.first_name}. It shows study time, homework, marks and attendance only, nothing private. This link stops working on {fmt(data.expires_at.slice(0, 10))} or when {data.summary.student.first_name} stops sharing.</p>
        </>
      )}
    </main>
  );
}

// ---- Menu > Parent view (the student shares, previews and stops) ----
export function ParentLinkPage({ user }) {
  const [info, setInfo] = useState(null), [fresh, setFresh] = useState(null), [preview, setPreview] = useState(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [copied, setCopied] = useState(false);
  const load = useCallback(() => api("/student/parent-link").then(setInfo).catch(e => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  if (!info) return error ? <ErrorBox error={error} /> : <Loading />;

  const url = fresh ? `${window.location.origin}${fresh.path}` : "";
  const create = async () => {
    if (info.link.active && !window.confirm("Make a new link? The old link will stop working straight away.")) return;
    setBusy(true); setError(""); setCopied(false);
    try { setFresh(await api("/student/parent-link", { method: "POST", body: "{}" })); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const stop = async () => {
    if (!window.confirm("Stop sharing? The link will stop working straight away.")) return;
    setBusy(true); setError("");
    try { await api("/student/parent-link", { method: "DELETE" }); setFresh(null); setPreview(null); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setError("Could not copy. Press and hold the link to copy it."); } };
  const togglePreview = async () => {
    if (preview) { setPreview(null); return; }
    try { setPreview((await api("/student/parent-link/preview")).summary); } catch (e) { setError(e.message); }
  };
  const whatsapp = `https://wa.me/?text=${encodeURIComponent(`${user.name.split(" ")[0]}'s weekly study summary on StudyTrack: ${url}`)}`;

  return (
    <>
      <div className="page-title"><h1>Parent view</h1><p className="muted">Let your parent or guardian see how your week is going, without them needing an account.</p></div>
      <ErrorBox error={error} />
      <section className="panel">
        <h2>What they will see</h2>
        <div className="share-cols">
          <div><b>✅ Shared</b><ul className="plain-list"><li>Study time this week and your streak</li><li>Homework: what is open or overdue</li><li>Recent test marks and your average</li><li>Attendance for the last 30 days</li><li>What is coming up in 7 days</li></ul></div>
          <div><b>🔒 Never shared</b><ul className="plain-list"><li>Your e-mail, phone or class codes</li><li>Your personal goals and notes</li><li>Teacher feedback and remarks</li><li>Anything about other students</li></ul></div>
        </div>
        <div className="action-row" style={{ marginTop: 12 }}><button className="secondary" onClick={togglePreview}>{preview ? "Hide preview" : "Preview what they will see"}</button></div>
      </section>

      <section className="panel">
        {info.link.active ? (
          <>
            <h2>Sharing is on</h2>
            <p className="muted">Created {when(info.link.created_at)} · last opened {when(info.link.last_viewed_at)} · opened {info.link.view_count} {info.link.view_count === 1 ? "time" : "times"} · stops working {fmt(info.link.expires_at.slice(0, 10))}</p>
          </>
        ) : <><h2>Sharing is off</h2><p className="muted">Create a link and send it to your parent or guardian. Anyone who has the link can see the summary, so only send it to them.</p></>}
        {fresh && (
          <div className="share-box" role="status">
            <b>Your link (shown only now)</b>
            <code className="share-url">{url}</code>
            <div className="action-row"><button className="primary" onClick={copy}>{copied ? "Copied ✓" : "Copy link"}</button><a className="secondary share-wa" href={whatsapp} target="_blank" rel="noopener noreferrer">Share on WhatsApp</a></div>
            <small className="muted">For your safety this link can't be shown again later. If you lose it, make a new one.</small>
          </div>
        )}
        <div className="action-row" style={{ marginTop: 14 }}>
          <button className={info.link.active ? "secondary" : "primary"} disabled={busy} onClick={create}>{info.link.active ? "Make a new link" : "Create link for my parent"}</button>
          {info.link.active && <button className="danger-outline" disabled={busy} onClick={stop}>Stop sharing</button>}
        </div>
      </section>
      {preview && <><div className="notice" role="note">This is a preview of exactly what your parent will see.</div><ParentSummary summary={preview} /></>}
    </>
  );
}
