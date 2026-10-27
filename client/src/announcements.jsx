import React, { useCallback, useEffect, useState } from "react";
import { api, json } from "./api.js";
import { ErrorBox, List, Loading, formatDate } from "./ui.jsx";

// Audience chooser shared by announcements and calendar events: one class, several classes, or the whole institute.
export function AudiencePicker({ classes, canInstitute, value, onChange }) {
  const usable = classes.filter(c => !c.suspended);
  const set = patch => onChange({ ...value, ...patch });
  const toggle = id => set({ classIds: value.classIds.includes(id) ? value.classIds.filter(x => x !== id) : [...value.classIds, id] });
  return (
    <fieldset className="audience">
      <legend>Send to</legend>
      <label><input type="radio" name="aud" checked={value.scope === "class"} onChange={() => set({ scope: "class", classIds: value.classIds.slice(0, 1) })} /> One class</label>
      {value.scope === "class" && (
        <select value={value.classIds[0] || ""} onChange={e => set({ classIds: e.target.value ? [Number(e.target.value)] : [] })} aria-label="Class" required>
          <option value="">Choose a class</option>{usable.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}
      <label><input type="radio" name="aud" checked={value.scope === "classes"} onChange={() => set({ scope: "classes" })} disabled={usable.length < 2} /> Several classes {usable.length < 2 && <small className="muted">(needs two classes)</small>}</label>
      {value.scope === "classes" && <div className="check-grid">{usable.map(c => <label key={c.id} className="check"><input type="checkbox" checked={value.classIds.includes(c.id)} onChange={() => toggle(c.id)} /> {c.name}</label>)}</div>}
      {canInstitute && <label><input type="radio" name="aud" checked={value.scope === "institute"} onChange={() => set({ scope: "institute", classIds: [] })} /> Entire institute</label>}
    </fieldset>
  );
}
export const audienceBody = a => (a.scope === "institute" ? { scope: "institute" } : { scope: a.scope, classIds: a.classIds });
export const audienceReady = a => a.scope === "institute" || (a.scope === "class" && a.classIds.length === 1) || (a.scope === "classes" && a.classIds.length >= 2);

export function TeacherAnnouncements({ ctx, currentClassId }) {
  const [form, setForm] = useState({ title: "", body: "", important: false });
  const [audience, setAudience] = useState({ scope: "class", classIds: currentClassId ? [currentClassId] : [] });
  const [list, setList] = useState(null);
  const [error, setError] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const canInstitute = Boolean(ctx.institute && ["head", "co_head"].includes(ctx.institute.role) && ctx.institute.status === "active");
  const load = useCallback(() => api("/teacher/announcements").then(d => setList(d.announcements)).catch(e => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const send = async e => {
    e.preventDefault(); setError(""); setMessage(""); setBusy(true);
    try {
      const r = await api("/teacher/announcements", { method: "POST", body: json({ title: form.title, body: form.body, priority: form.important ? "important" : "normal", ...audienceBody(audience) }) });
      setForm({ title: "", body: "", important: false }); setMessage(`Announcement sent to ${r.delivered} ${r.delivered === 1 ? "person" : "people"}. They see it in their notification centre.`); load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const remove = async a => { try { await api(`/teacher/announcements/${a.id}`, { method: "DELETE" }); load(); } catch (err) { setError(err.message); } };
  return (
    <>
      <div className="page-title"><h1>Announcements</h1><p className="muted">Tell one class, several classes or your whole institute.</p></div>
      <section className="panel">
        <h2>New announcement</h2>
        <form onSubmit={send}>
          <label className="field">Title<input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} maxLength={120} placeholder="e.g. Class timing changed" required /></label>
          <label className="field">Message<textarea value={form.body} onChange={e => setForm({ ...form, body: e.target.value })} maxLength={2000} placeholder="Tomorrow's Physics class will begin at 5 PM instead of 4 PM." required /></label>
          <label className="check"><input type="checkbox" checked={form.important} onChange={e => setForm({ ...form, important: e.target.checked })} /> Mark as important 📢</label>
          <AudiencePicker classes={ctx.classes} canInstitute={canInstitute} value={audience} onChange={setAudience} />
          <ErrorBox error={error} />{message && <p className="success" role="status">{message}</p>}
          <button className="primary" disabled={busy || !audienceReady(audience)}>{busy ? "Sending…" : "Send announcement"}</button>
        </form>
      </section>
      <section className="panel">
        <h2>Sent announcements</h2>
        {!list ? <Loading /> : <List items={list} empty="You haven't sent any announcements yet." render={a => (
          <div className="item"><div><b>{a.priority === "important" ? "📢 " : ""}{a.title}</b><p>{a.body}</p><small>To: {a.classes.join(", ")} • {formatDate(a.created_at)}</small></div><button className="danger-outline small-btn" onClick={() => remove(a)}>Delete</button></div>
        )} />}
      </section>
    </>
  );
}

export function StudentAnnouncements() {
  const [list, setList] = useState(null), [error, setError] = useState("");
  useEffect(() => { api("/student/announcements?limit=50").then(d => setList(d.announcements)).catch(e => setError(e.message)); }, []);
  if (error) return <ErrorBox error={error} />;
  if (!list) return <Loading />;
  return (
    <section className="panel">
      <h2>Announcements</h2>
      <List items={list} empty="No announcements yet." render={a => (
        <div className={a.priority === "important" ? "card announce important" : "card announce"}>
          <b>{a.priority === "important" ? "📢 Important: " : "📢 "}{a.title}</b>
          <p className="pre">{a.body}</p>
          <small>{a.author_name} • {formatDate(a.created_at)}{a.scope === "institute" ? " • Whole institute" : ""}</small>
        </div>
      )} />
    </section>
  );
}
