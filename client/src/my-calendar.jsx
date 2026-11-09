import React, { useCallback, useEffect, useState } from "react";
import { api, json } from "./api.js";
import { ErrorBox, Loading, Modal, List, localDateInput, shiftDate } from "./ui.jsx";

// A student's own calendar: study goals, revision plans and tasks, each with a "complete by" date.
// Private to the student. Teachers never see these.
export const PLAN_KINDS = {
  goal: { icon: "🎯", label: "Study goal", hint: "e.g. Finish 20 maths problems", placeholder: "What do you want to achieve?" },
  revision: { icon: "🔁", label: "Revision", hint: "e.g. Revise Physics ch. 1 to 6", placeholder: "What will you revise?" },
  task: { icon: "✅", label: "My task", hint: "e.g. Prepare lab file", placeholder: "What do you need to do?" },
};
const daysBetween = (a, b) => Math.round((Date.UTC(...b.split("-").map((n, i) => (i === 1 ? n - 1 : +n))) - Date.UTC(...a.split("-").map((n, i) => (i === 1 ? n - 1 : +n)))) / 86400000);
export const fmtDay = date => new Date(`${date}T12:00:00Z`).toLocaleDateString([], { day: "numeric", month: "short", timeZone: "UTC" });
export const fmtRange = (a, b) => (a === b ? fmtDay(a) : `${fmtDay(a)} → ${fmtDay(b)}`);
export const timeText = i => (i.start_time ? `${i.start_time}${i.end_time ? `–${i.end_time}` : ""}` : "");

// "Complete by" status in words, with a tone the CSS turns into a colour (never colour alone).
export function dueInfo(item, today) {
  if (item.done) return { text: "Done", tone: "done" };
  const left = daysBetween(today, item.end_date);
  if (left < 0) return { text: `Overdue by ${-left} ${left === -1 ? "day" : "days"}`, tone: "overdue" };
  if (left === 0) return { text: "Due today", tone: "today" };
  if (left === 1) return { text: "Due tomorrow", tone: "" };
  return { text: `${left} days left`, tone: "" };
}

const PRESETS = [["Same day", 0], ["3 days", 3], ["1 week", 7], ["2 weeks", 14], ["1 month", 30]];

export function PlanItemModal({ item = null, defaultDate, onClose, onSaved }) {
  const today = localDateInput();
  const [f, setF] = useState({
    kind: item?.kind || "revision", title: item?.title || "", subject: item?.subject || "", notes: item?.notes || "",
    startDate: item?.start_date || defaultDate || today, endDate: item?.end_date || defaultDate || today, startTime: item?.start_time || "", endTime: item?.end_time || "",
  });
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const meta = PLAN_KINDS[f.kind];
  const setStart = value => setF(x => ({ ...x, startDate: value, endDate: x.endDate < value ? value : x.endDate }));
  const save = async e => {
    e.preventDefault(); setError(""); setBusy(true);
    try {
      const body = { ...f, startTime: f.startTime || "", endTime: f.endTime || "" };
      await api(item ? `/student/plan-items/${item.item_id ?? item.id}` : "/student/plan-items", { method: item ? "PATCH" : "POST", body: json(body) });
      onSaved();
    } catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <Modal title={item ? "Edit calendar item" : "Add to my calendar"} onClose={onClose}>
      <p className="muted">Only you can see this. It appears on your calendar for every day until the complete-by date.</p>
      <form onSubmit={save}>
        <div className="kind-seg" role="group" aria-label="Type">
          {Object.entries(PLAN_KINDS).map(([k, v]) => <button key={k} type="button" aria-pressed={f.kind === k} onClick={() => setF({ ...f, kind: k })}><span aria-hidden="true">{v.icon}</span>{v.label}</button>)}
        </div>
        <label className="field">Title<input value={f.title} onChange={e => setF({ ...f, title: e.target.value })} placeholder={meta.placeholder} maxLength={120} required autoFocus /></label>
        <small className="hint">{meta.hint}</small>
        <div className="form-grid">
          <label className="field">Subject (optional)<input value={f.subject} onChange={e => setF({ ...f, subject: e.target.value })} placeholder="Physics" maxLength={100} /></label>
          <span />
          <label className="field">Start date<input type="date" value={f.startDate} onChange={e => setStart(e.target.value)} required /></label>
          <label className="field">Complete by<input type="date" value={f.endDate} min={f.startDate} onChange={e => setF({ ...f, endDate: e.target.value })} required /></label>
        </div>
        <div className="mine-filter" role="group" aria-label="Quick complete-by dates">
          {PRESETS.map(([label, days]) => <button key={label} type="button" aria-pressed={f.endDate === shiftDate(f.startDate, days)} onClick={() => setF({ ...f, endDate: shiftDate(f.startDate, days) })}>{label}</button>)}
        </div>
        <div className="form-grid">
          <label className="field">Start time (optional)<input type="time" value={f.startTime} onChange={e => setF({ ...f, startTime: e.target.value })} /></label>
          <label className="field">End time (optional)<input type="time" value={f.endTime} onChange={e => setF({ ...f, endTime: e.target.value })} /></label>
          <textarea value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} placeholder="Notes: chapters, targets, anything to remember (optional)" maxLength={1000} aria-label="Notes" />
        </div>
        <ErrorBox error={error} />
        <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? "Saving…" : item ? "Save changes" : "Add to calendar"}</button></div>
      </form>
    </Modal>
  );
}

// One row, used by the manager page.
function PlanRow({ item, today, onToggle, onEdit, onDelete }) {
  const meta = PLAN_KINDS[item.kind], due = dueInfo(item, today);
  return (
    <div className={`item cal-item ${item.kind}${item.done ? " is-done" : ""}`}>
      <div className="mine-row">
        <button type="button" className="tick-btn" aria-pressed={item.done} aria-label={item.done ? `Mark "${item.title}" as not done` : `Mark "${item.title}" as done`} onClick={() => onToggle(item)}>{item.done ? "✓" : ""}</button>
        <div>
          <b>{meta.icon} {item.title}</b>
          <small>{meta.label}{item.subject ? ` • ${item.subject}` : ""} • {fmtRange(item.start_date, item.end_date)}{timeText(item) ? ` • ${timeText(item)}` : ""}</small>
          {item.notes && <small className="pre">{item.notes}</small>}
          <small><span className={`due-chip ${due.tone}`}>{due.text}</span></small>
        </div>
      </div>
      <div className="status-group"><button className="secondary small-btn" onClick={() => onEdit(item)}>Edit</button><button className="danger-outline small-btn" onClick={() => onDelete(item)}>Delete</button></div>
    </div>
  );
}

// Menu -> Calendar -> Edit my calendar
export function MyCalendarManager({ onChanged }) {
  const [data, setData] = useState(null), [status, setStatus] = useState("open"), [error, setError] = useState("");
  const [editing, setEditing] = useState(undefined);   // undefined = closed, null = new, object = edit
  const load = useCallback(async () => { try { setData(await api("/student/plan-items")); setError(""); } catch (e) { setError(e.message); } }, []);
  useEffect(() => { load(); }, [load]);
  const changed = async () => { await load(); onChanged?.(); };
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  const { today } = data;
  const items = data.items.map(i => ({ ...i }));
  const open = items.filter(i => !i.done), overdue = open.filter(i => i.end_date < today), soon = open.filter(i => i.end_date >= today && daysBetween(today, i.end_date) <= 7);
  const shown = (status === "open" ? open : status === "done" ? items.filter(i => i.done) : items).sort((a, b) => (a.done - b.done) || a.end_date.localeCompare(b.end_date));
  const toggle = async i => { try { await api(`/student/plan-items/${i.id}`, { method: "PATCH", body: json({ done: !i.done }) }); await changed(); } catch (e) { setError(e.message); } };
  const del = async i => { if (!window.confirm(`Delete "${i.title}" from your calendar?`)) return; try { await api(`/student/plan-items/${i.id}`, { method: "DELETE" }); await changed(); } catch (e) { setError(e.message); } };
  return (
    <>
      <div className="page-title"><h1>Edit my calendar</h1><p className="muted">Add your own study goals, revision plans and tasks, each with a date to finish by. They show up on your calendar and help the "what to study today" suggestions.</p></div>
      <div className="mine-summary">
        <div className="stat"><span>Open</span><strong>{open.length}</strong></div>
        <div className="stat"><span>Due in 7 days</span><strong>{soon.length}</strong></div>
        <div className="stat"><span>Overdue</span><strong style={overdue.length ? { color: "var(--bad)" } : undefined}>{overdue.length}</strong></div>
      </div>
      <section className="panel">
        <div className="panel-head"><div><h2>My goals and plans</h2></div><button className="primary" onClick={() => setEditing(null)}>+ Add</button></div>
        <div className="mine-filter" role="group" aria-label="Show">
          {[["open", `Open (${open.length})`], ["done", `Done (${items.length - open.length})`], ["all", "All"]].map(([id, label]) => <button key={id} type="button" aria-pressed={status === id} onClick={() => setStatus(id)}>{label}</button>)}
        </div>
        <ErrorBox error={error} />
        <List items={shown} empty={status === "open" ? "Nothing open. Add a goal, a revision plan or a task to get started." : "Nothing here yet."} render={i => <PlanRow item={i} today={today} onToggle={toggle} onEdit={setEditing} onDelete={del} />} />
      </section>
      {editing !== undefined && <PlanItemModal item={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); changed(); }} />}
    </>
  );
}
