import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api, json } from "./api.js";
import { ErrorBox, List, Loading, Modal, localDateInput, shiftDate } from "./ui.jsx";
import { AudiencePicker, audienceBody, audienceReady } from "./announcements.jsx";

export const KINDS = { class: { icon: "📚", label: "Class" }, homework: { icon: "📝", label: "Homework due" }, test: { icon: "🧪", label: "Test" }, event: { icon: "📢", label: "Event" }, holiday: { icon: "📅", label: "Holiday" }, exam: { icon: "🎯", label: "My exam" } };
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const isoWeekday = date => ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
const monthShift = (month, delta) => { const d = new Date(`${month}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + delta); return d.toISOString().slice(0, 7); };
const monthLabel = month => new Date(`${month}-01T12:00:00Z`).toLocaleDateString([], { month: "long", year: "numeric", timeZone: "UTC" });
export const timeRange = e => (e.start_time ? `${e.start_time}${e.end_time ? `–${e.end_time}` : ""}` : "");

// One calendar for classes, homework deadlines, tests, events and holidays.
export function CalendarView({ classes = [], editable = false, ctx = null, reloadKey = 0 }) {
  const today = localDateInput();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selected, setSelected] = useState(today);
  const [classId, setClassId] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const first = `${month}-01`;
  const gridStart = useMemo(() => shiftDate(first, -(isoWeekday(first) - 1)), [first]);
  const gridEnd = shiftDate(gridStart, 41);

  const load = useCallback(async () => {
    try { setData(await api(`/calendar?from=${gridStart}&to=${gridEnd}${classId ? `&classId=${classId}` : ""}`)); setError(""); } catch (e) { setError(e.message); }
  }, [gridStart, gridEnd, classId]);
  useEffect(() => { setData(null); load(); }, [load, reloadKey]);

  const byDate = useMemo(() => { const m = new Map(); for (const e of data?.entries || []) { if (!m.has(e.date)) m.set(e.date, []); m.get(e.date).push(e); } return m; }, [data]);
  const cells = Array.from({ length: 42 }, (_, i) => shiftDate(gridStart, i));
  const dayEntries = byDate.get(selected) || [];
  const removeEvent = async e => { try { await api(`/teacher/calendar-events/${e.event_id}`, { method: "DELETE" }); load(); } catch (err) { setError(err.message); } };

  return (
    <>
      <div className="page-title"><h1>Calendar</h1><p className="muted">Classes, homework deadlines, tests, events and holidays in one place.</p></div>
      <section className="panel">
        <div className="panel-head cal-head">
          <div className="cal-nav"><button className="secondary" onClick={() => setMonth(monthShift(month, -1))} aria-label="Previous month">‹</button><h2>{monthLabel(month)}</h2><button className="secondary" onClick={() => setMonth(monthShift(month, 1))} aria-label="Next month">›</button><button className="secondary" onClick={() => { setMonth(today.slice(0, 7)); setSelected(today); }}>Today</button></div>
          <div className="cal-tools">
            {classes.length > 1 && <select value={classId} onChange={e => setClassId(e.target.value)} aria-label="Filter by class"><option value="">All classes</option>{classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
            {editable && <button className="primary" onClick={() => setAdding(true)}>+ Event / holiday</button>}
          </div>
        </div>
        <div className="cal-legend">{Object.entries(KINDS).filter(([k]) => editable ? k !== "exam" : true).map(([k, v]) => <span key={k}>{v.icon} {v.label}</span>)}</div>
        <ErrorBox error={error} />
        {!data ? <Loading /> : (
          <div className="cal-grid" role="grid" aria-label={monthLabel(month)}>
            {DAYS.map(d => <div key={d} className="cal-dow" role="columnheader">{d}</div>)}
            {cells.map(date => {
              const list = byDate.get(date) || [];
              const kinds = [...new Set(list.map(e => e.kind))];
              return (
                <button key={date} role="gridcell" className={`cal-cell ${date.slice(0, 7) !== month ? "dim" : ""} ${date === today ? "today" : ""} ${date === selected ? "selected" : ""} ${kinds.includes("holiday") ? "holiday" : ""}`} onClick={() => setSelected(date)} aria-label={`${date}, ${list.length} items`}>
                  <span className="cal-num">{Number(date.slice(8))}</span>
                  <span className="cal-dots" aria-hidden="true">{kinds.slice(0, 4).map(k => <i key={k} className={`dot ${k}`} />)}</span>
                  {list.length > 0 && <small className="cal-count">{list.length}</small>}
                </button>
              );
            })}
          </div>
        )}
      </section>
      <section className="panel">
        <h2>{new Date(`${selected}T12:00:00Z`).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}</h2>
        <List items={dayEntries} empty="Nothing scheduled this day." render={e => (
          <div className={`item cal-item ${e.kind}`}>
            <div>
              <b>{KINDS[e.kind].icon} {e.title}</b>
              <small>{KINDS[e.kind].label}{timeRange(e) ? ` • ${timeRange(e)}` : ""}{e.class_name ? ` • ${e.class_name}` : ""}{e.detail ? ` • ${e.detail}` : ""}</small>
              {e.on_holiday && <small className="warn">Holiday: this class may not meet today.</small>}
            </div>
            {editable && e.event_id && <button className="danger-outline small-btn" onClick={() => removeEvent(e)}>Delete</button>}
          </div>
        )} />
      </section>
      {adding && ctx && <EventModal ctx={ctx} date={selected} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
    </>
  );
}

function EventModal({ ctx, date, onClose, onSaved }) {
  const [f, setF] = useState({ kind: "event", title: "", description: "", startDate: date, endDate: "", startTime: "", endTime: "" });
  const [audience, setAudience] = useState({ scope: "class", classIds: ctx.classes[0] ? [ctx.classes[0].id] : [] });
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const canInstitute = Boolean(ctx.institute && ["head", "co_head"].includes(ctx.institute.role) && ctx.institute.status === "active");
  const save = async e => {
    e.preventDefault(); setError(""); setBusy(true);
    try { await api("/teacher/calendar-events", { method: "POST", body: json({ ...f, endDate: f.endDate || undefined, startTime: f.startTime || undefined, endTime: f.endTime || undefined, ...audienceBody(audience) }) }); onSaved(); }
    catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <Modal title="Add to the calendar" onClose={onClose}>
      <form onSubmit={save}>
        <div className="form-grid">
          <select value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })} aria-label="Type"><option value="event">📢 Event</option><option value="holiday">📅 Holiday</option></select>
          <input value={f.title} onChange={e => setF({ ...f, title: e.target.value })} placeholder="Title" maxLength={120} required />
          <label className="field">From<input type="date" value={f.startDate} onChange={e => setF({ ...f, startDate: e.target.value })} required /></label>
          <label className="field">To (optional)<input type="date" value={f.endDate} min={f.startDate} onChange={e => setF({ ...f, endDate: e.target.value })} /></label>
          {f.kind === "event" && <><label className="field">Start time<input type="time" value={f.startTime} onChange={e => setF({ ...f, startTime: e.target.value })} /></label><label className="field">End time<input type="time" value={f.endTime} onChange={e => setF({ ...f, endTime: e.target.value })} /></label></>}
          <textarea value={f.description} onChange={e => setF({ ...f, description: e.target.value })} placeholder="Details (optional)" maxLength={1000} />
        </div>
        <AudiencePicker classes={ctx.classes} canInstitute={canInstitute} value={audience} onChange={setAudience} />
        <ErrorBox error={error} />
        <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !audienceReady(audience)}>{busy ? "Saving…" : "Add"}</button></div>
      </form>
    </Modal>
  );
}

// Weekly class timetable for the current class; it feeds the calendar and every student's planner.
export function ScheduleManager({ classInfo, onChanged }) {
  const [slots, setSlots] = useState(null), [error, setError] = useState("");
  const [f, setF] = useState({ weekday: "1", startTime: "16:00", endTime: "17:00", subject: "", room: "" });
  const load = useCallback(() => api("/teacher/schedule").then(d => setSlots(d.slots)).catch(e => setError(e.message)), []);
  useEffect(() => { load(); }, [load, classInfo.id]);
  const add = async e => { e.preventDefault(); setError(""); try { await api("/teacher/schedule", { method: "POST", body: json({ ...f, weekday: Number(f.weekday) }) }); setF({ ...f, subject: "", room: "" }); load(); onChanged?.(); } catch (err) { setError(err.message); } };
  const del = async s => { try { await api(`/teacher/schedule/${s.id}`, { method: "DELETE" }); load(); onChanged?.(); } catch (err) { setError(err.message); } };
  return (
    <section className="panel">
      <h2>Weekly timetable: {classInfo.name}</h2>
      <p className="muted">These class timings appear on the calendar of every student in this class.</p>
      <form className="form-grid" onSubmit={add}>
        <select value={f.weekday} onChange={e => setF({ ...f, weekday: e.target.value })} aria-label="Day">{DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select>
        <input value={f.subject} onChange={e => setF({ ...f, subject: e.target.value })} placeholder="Subject" maxLength={100} required />
        <label className="field">Start<input type="time" value={f.startTime} onChange={e => setF({ ...f, startTime: e.target.value })} required /></label>
        <label className="field">End<input type="time" value={f.endTime} onChange={e => setF({ ...f, endTime: e.target.value })} required /></label>
        <input value={f.room} onChange={e => setF({ ...f, room: e.target.value })} placeholder="Room (optional)" maxLength={60} />
        <button className="primary">Add class time</button>
      </form>
      <ErrorBox error={error} />
      {!slots ? <Loading /> : <List items={slots} empty="No weekly class times yet." render={s => <div className="item"><div><b>{DAYS[s.weekday - 1]} {s.start_time}–{s.end_time}</b><small>{s.subject}{s.room ? ` • ${s.room}` : ""}</small></div><button className="danger-outline small-btn" onClick={() => del(s)}>Remove</button></div>} />}
    </section>
  );
}
