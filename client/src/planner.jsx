import React, { useCallback, useEffect, useState } from "react";
import { api, json } from "./api.js";
import { BlockBar, ErrorBox, List, Loading, fmtMinutes, localDateInput } from "./ui.jsx";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MARK = { met: "✓", missed: "✗", today: "…", upcoming: "–", none: "·" };

// Daily and weekly study goals: today's progress bar, weekly ticks and the current streak.
export function GoalsCard({ goals, onChanged }) {
  const [edit, setEdit] = useState(false);
  const [daily, setDaily] = useState(goals?.goal ? goals.goal.daily_minutes / 60 : 4);
  const [weekly, setWeekly] = useState(goals?.goal ? goals.goal.weekly_minutes / 60 : 28);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { if (goals?.goal) { setDaily(goals.goal.daily_minutes / 60); setWeekly(goals.goal.weekly_minutes / 60); } }, [goals?.goal?.daily_minutes, goals?.goal?.weekly_minutes]);
  if (!goals) return <Loading />;
  const save = async e => {
    e.preventDefault(); setError(""); setBusy(true);
    try { await api("/student/goals", { method: "PUT", body: json({ dailyMinutes: Math.round(Number(daily) * 60), weeklyMinutes: Math.round(Number(weekly) * 60) }) }); setEdit(false); onChanged?.(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const g = goals.goal;
  return (
    <section className="panel goals">
      <div className="panel-head"><div><h2>Study goals</h2><p className="muted">{g ? `Daily goal ${fmtMinutes(g.daily_minutes)} • Weekly goal ${fmtMinutes(g.weekly_minutes)}` : "Set a daily and weekly goal to track your progress."}</p></div><button className="secondary" onClick={() => setEdit(e => !e)}>{g ? "Edit goals" : "Set goals"}</button></div>
      {edit && (
        <form className="form-grid" onSubmit={save}>
          <label className="field">Daily goal (hours)<input type="number" min="0.25" max="16" step="0.25" value={daily} onChange={e => setDaily(e.target.value)} required /></label>
          <label className="field">Weekly goal (hours)<input type="number" min="0.5" max="112" step="0.25" value={weekly} onChange={e => setWeekly(e.target.value)} required /></label>
          <ErrorBox error={error} /><button className="primary" disabled={busy}>Save goals</button>
        </form>
      )}
      {g && (
        <>
          <div className="goal-today">
            <b>Today's progress</b>
            <div className="goal-line"><strong>{fmtMinutes(goals.daily.minutes)} / {fmtMinutes(g.daily_minutes)}</strong><BlockBar percent={goals.daily.percent} /><span>{goals.daily.percent}%</span></div>
            {goals.daily.remaining > 0 ? <small className="muted">{fmtMinutes(goals.daily.remaining)} to go today.</small> : <small className="success-text">Daily goal reached. Great work! 🎉</small>}
          </div>
          <div className="goal-week">
            <b>This week</b>
            <div className="week-ticks" role="list">{goals.days.map((d, i) => <span key={d.date} role="listitem" className={`tick ${d.status}`} title={`${d.date}: ${fmtMinutes(d.minutes)}`}>{DAYS[i]} <i>{MARK[d.status]}</i></span>)}</div>
            <div className="goal-line"><strong>{fmtMinutes(goals.weekly.minutes)} / {fmtMinutes(g.weekly_minutes)}</strong><BlockBar percent={goals.weekly.percent} /><span>{goals.weekly.percent}%</span></div>
            {goals.streak > 0 && <small className="streak">🔥 {goals.streak}-day streak</small>}
          </div>
        </>
      )}
    </section>
  );
}

export function StudentPlanner() {
  const [data, setData] = useState(null), [error, setError] = useState("");
  const [slot, setSlot] = useState({ weekday: "1", startTime: "18:00", endTime: "19:00", subject: "", note: "" });
  const [exam, setExam] = useState({ subject: "", title: "", examDate: localDateInput() });
  const load = useCallback(() => api("/student/planner").then(d => { setData(d); setError(""); }).catch(e => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const run = async fn => { setError(""); try { await fn(); await load(); } catch (e) { setError(e.message); } };
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  const s = data.suggestions;
  return (
    <>
      <GoalsCard goals={data.goal} onChanged={load} />
      <ErrorBox error={error} />
      <section className="panel">
        <div className="panel-head"><div><h2>What to study today</h2><p className="muted">Based on your exams, goals, recent study, test scores and syllabus.</p></div></div>
        {s.hint && <p className="notice">{s.hint}</p>}
        <List items={s.items} empty="No suggestions yet." render={i => (
          <div className="item suggestion"><div><b>{i.type === "homework" ? "📝 " : "📖 "}{i.title}</b><small>{i.reasons.join(" • ")}</small></div><span className="pill minutes">{fmtMinutes(i.minutes)}</span></div>
        )} />
      </section>
      <section className="panel">
        <h2>Exam countdowns</h2>
        <List items={data.exams} empty="No upcoming exams. Add one below." render={e => (
          <div className="item"><div><b>{e.title}</b><small>{e.subject} • {e.exam_date} {e.source === "test" ? "• class test" : ""}</small></div>
            <div className="status-group"><span className={`countdown ${e.days_left <= 3 ? "soon" : ""}`}>{e.days_left === 0 ? "Today" : e.days_left === 1 ? "Tomorrow" : `${e.days_left} days`}</span>{e.source === "personal" && <button className="danger-outline small-btn" onClick={() => run(() => api(`/student/exams/${e.id}`, { method: "DELETE" }))}>Remove</button>}</div></div>
        )} />
        <form className="form-grid" onSubmit={e => { e.preventDefault(); run(async () => { await api("/student/exams", { method: "POST", body: json(exam) }); setExam({ ...exam, subject: "", title: "" }); }); }}>
          <input placeholder="Subject" value={exam.subject} onChange={e => setExam({ ...exam, subject: e.target.value })} maxLength={100} required />
          <input placeholder="Exam name" value={exam.title} onChange={e => setExam({ ...exam, title: e.target.value })} maxLength={120} required />
          <input type="date" value={exam.examDate} min={localDateInput()} onChange={e => setExam({ ...exam, examDate: e.target.value })} required />
          <button className="primary">Add exam</button>
        </form>
      </section>
      <section className="panel">
        <h2>Weekly timetable</h2>
        <p className="muted">Class timings (📚) come from your teachers. Your own study blocks (✏️) are yours.</p>
        <div className="timetable">
          {data.timetable.map(day => (
            <div key={day.weekday} className={day.is_today ? "tt-day today" : "tt-day"}>
              <b>{DAYS[day.weekday - 1]}<small>{day.date.slice(5)}</small></b>
              {day.items.length === 0 ? <small className="muted">Free</small> : day.items.map(it => (
                <div key={`${it.source}-${it.id}`} className={`tt-item ${it.source}`}>
                  <span>{it.source === "class" ? "📚" : "✏️"} {it.start_time}–{it.end_time}</span><b>{it.subject}</b>{(it.class_name || it.note) && <small>{it.class_name || it.note}</small>}
                  {it.source === "plan" && <button className="link" aria-label={`Remove ${it.subject}`} onClick={() => run(() => api(`/student/plan-slots/${it.id}`, { method: "DELETE" }))}>✕</button>}
                </div>
              ))}
            </div>
          ))}
        </div>
        <form className="form-grid" onSubmit={e => { e.preventDefault(); run(async () => { await api("/student/plan-slots", { method: "POST", body: json({ ...slot, weekday: Number(slot.weekday) }) }); setSlot({ ...slot, subject: "", note: "" }); }); }}>
          <select value={slot.weekday} onChange={e => setSlot({ ...slot, weekday: e.target.value })} aria-label="Day">{DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select>
          <input placeholder="Subject" value={slot.subject} onChange={e => setSlot({ ...slot, subject: e.target.value })} maxLength={100} required />
          <label className="field">Start<input type="time" value={slot.startTime} onChange={e => setSlot({ ...slot, startTime: e.target.value })} required /></label>
          <label className="field">End<input type="time" value={slot.endTime} onChange={e => setSlot({ ...slot, endTime: e.target.value })} required /></label>
          <input placeholder="Note (optional)" value={slot.note} onChange={e => setSlot({ ...slot, note: e.target.value })} maxLength={200} />
          <button className="primary">Add study block</button>
        </form>
      </section>
    </>
  );
}
