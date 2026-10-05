import React, { useCallback, useEffect, useState } from "react";
import { api, json } from "./api.js";
import { CopyChip, ErrorBox, Loading, Modal } from "./ui.jsx";

const ROLE_LABEL = { head: "Institute head", co_head: "Co-head", teacher: "Teacher" };

// Mirrors the server rules so buttons only appear when the action will work.
function actionsFor(viewerRole, target) {
  const viewerIsHead = viewerRole === "head";
  const viewerIsManager = viewerRole === "head" || viewerRole === "co_head";
  if (!viewerIsManager || target.role === "head") return { promote: false, demote: false, remove: false, note: false, stepDown: false };
  const isMe = target.is_me;
  return {
    promote: target.role === "teacher",
    demote: target.role === "co_head" && viewerIsHead && !isMe,
    stepDown: target.role === "co_head" && isMe,
    remove: !isMe && (target.role === "teacher" || viewerIsHead),
    note: true,
  };
}

export function InstituteHome({ onChanged, onCreateAgain, goClasses }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [noteFor, setNoteFor] = useState(null);
  const [removeFor, setRemoveFor] = useState(null);
  const [leaveOpen, setLeaveOpen] = useState(false);

  const load = useCallback(async () => {
    try { setData(await api("/institute/home")); setError(""); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (fn, text) => {
    setError(""); setMessage("");
    try { await fn(); setMessage(text); await load(); onChanged?.(); } catch (e) { setError(e.message); }
  };

  if (!data) return error ? <section className="panel"><ErrorBox error={error} /><button className="secondary" onClick={load}>Try again</button></section> : <Loading />;
  const { institute, myRole, teachers } = data;
  const isManager = myRole === "head" || myRole === "co_head";

  if (institute.status === "pending") {
    return (
      <section className="panel status-panel">
        <h1>{institute.name}</h1>
        <p className="status-line"><span className="badge in-progress">Waiting for approval</span></p>
        <p>StudyTrack is reviewing your institute. You'll get full access as soon as it's approved. Teachers can't join with the code until then.</p>
        {institute.code && <p>Your coaching code: <CopyChip value={institute.code} label="Coaching code" /></p>}
        <button className="secondary" onClick={load}>Check status</button>
      </section>
    );
  }
  if (institute.status === "rejected") {
    return (
      <section className="panel status-panel">
        <h1>{institute.name}</h1>
        <p className="status-line"><span className="badge late">Not approved</span></p>
        {institute.status_reason ? <p>Reason: {institute.status_reason}</p> : <p>The request wasn't approved.</p>}
        {myRole === "head" && <button className="primary" onClick={onCreateAgain}>Update details and send again</button>}
      </section>
    );
  }

  return (
    <>
      <section className="institute-hero">
        <div className="sparkles" aria-hidden="true">✨ 🌟 ✨</div>
        <h1>{institute.name}</h1>
        <div className="sparkles" aria-hidden="true">⭐ 🎓 ⭐</div>
        <p className="hero-sub">{teachers.length} {teachers.length === 1 ? "teacher" : "teachers"} • {teachers.reduce((n, t) => n + t.class_count, 0)} classes • {teachers.reduce((n, t) => n + t.student_count, 0)} students</p>
        {isManager && institute.code && <p className="hero-code">Coaching code <CopyChip value={institute.code} label="Coaching code" /><small>Share it with teachers so they can join.</small></p>}
      </section>

      {message && <p className="success" role="status">{message}</p>}
      <ErrorBox error={error} />

      <div className="teacher-grid">
        {teachers.map(t => {
          const can = actionsFor(myRole, t);
          return (
            <article className="teacher-card" key={t.id}>
              <header>
                <div className="avatar" aria-hidden="true">{t.name.slice(0, 1).toUpperCase()}</div>
                <div>
                  <h2>{t.name}{t.is_me && <span className="you"> (you)</span>}</h2>
                  <span className={`role-chip ${t.role}`}>{ROLE_LABEL[t.role]}</span>
                </div>
              </header>
              <dl className="mini-stats">
                <div><dt>Students</dt><dd>{t.student_count}</dd></div>
                <div><dt>Test avg</dt><dd>{t.average_percentage == null ? "—" : `${t.average_percentage}%`}</dd></div>
                <div><dt>Attendance</dt><dd>{t.attendance_percentage == null ? "—" : `${t.attendance_percentage}%`}</dd></div>
                <div><dt>Homework</dt><dd>{t.homework_count}</dd></div>
              </dl>
              <div className="class-rows">
                {t.classes.length === 0 ? <small className="muted">No classes yet.</small> : t.classes.map(c => (
                  <div className="class-row" key={c.id}>
                    <span>{c.name}{c.suspended && <em className="tag-paused"> paused</em>}</span>
                    <span>{c.student_count} {c.student_count === 1 ? "student" : "students"}{c.code && <> • <code>{c.code}</code></>}</span>
                  </div>
                ))}
              </div>
              {t.note && <p className="feedback"><b>Feedback:</b> {t.note}</p>}
              {(can.note || can.promote || can.demote || can.remove || can.stepDown) && (
                <div className="card-actions">
                  {can.note && <button className="secondary small-btn" onClick={() => setNoteFor(t)}>{t.note ? "Edit feedback" : "Add feedback"}</button>}
                  {can.promote && <button className="secondary small-btn" onClick={() => act(() => api(`/institute/members/${t.id}/role`, { method: "POST", body: json({ role: "co_head" }) }), `${t.name} is now a co-head.`)}>Make co-head</button>}
                  {can.demote && <button className="secondary small-btn" onClick={() => act(() => api(`/institute/members/${t.id}/role`, { method: "POST", body: json({ role: "teacher" }) }), `${t.name} is a regular teacher again.`)}>Remove co-head</button>}
                  {can.stepDown && <button className="secondary small-btn" onClick={() => act(() => api(`/institute/members/${t.id}/role`, { method: "POST", body: json({ role: "teacher" }) }), "You stepped down as co-head.")}>Step down</button>}
                  {can.remove && <button className="danger-outline small-btn" onClick={() => setRemoveFor(t)}>Remove</button>}
                </div>
              )}
            </article>
          );
        })}
      </div>

      <div className="institute-footer">
        {goClasses && <button className="secondary" onClick={goClasses}>Go to my classes</button>}
        {myRole !== "head" && <button className="danger-outline" onClick={() => setLeaveOpen(true)}>Leave institute</button>}
      </div>

      {noteFor && <NoteModal teacher={noteFor} onClose={() => setNoteFor(null)} onSave={async note => { setNoteFor(null); await act(() => api(`/institute/members/${noteFor.id}/note`, { method: "POST", body: json({ note }) }), "Feedback saved."); }} />}
      {removeFor && (
        <Modal title={`Remove ${removeFor.name}?`} onClose={() => setRemoveFor(null)}>
          <p>{removeFor.name} leaves the institute but keeps their own account and classes.</p>
          <div className="modal-actions"><button className="secondary" onClick={() => setRemoveFor(null)}>Cancel</button><button className="danger-solid" onClick={() => { const t = removeFor; setRemoveFor(null); act(() => api(`/institute/members/${t.id}`, { method: "DELETE" }), `${t.name} was removed.`); }}>Remove teacher</button></div>
        </Modal>
      )}
      {leaveOpen && (
        <Modal title="Leave this institute?" onClose={() => setLeaveOpen(false)}>
          <p>You keep your account and your classes. You'll need the coaching code to join again.</p>
          <div className="modal-actions"><button className="secondary" onClick={() => setLeaveOpen(false)}>Stay</button><button className="danger-solid" onClick={async () => { setLeaveOpen(false); try { await api("/institute/leave", { method: "POST", body: "{}" }); onChanged?.({ left: true }); } catch (e) { setError(e.message); } }}>Leave institute</button></div>
        </Modal>
      )}
    </>
  );
}

function NoteModal({ teacher, onClose, onSave }) {
  const [note, setNote] = useState(teacher.note || "");
  return (
    <Modal title={`Feedback for ${teacher.name}`} onClose={onClose}>
      <p className="muted">Everyone in the institute can see this note on the institute page.</p>
      <textarea value={note} onChange={e => setNote(e.target.value)} maxLength={300} placeholder="e.g. Students love the weekly doubt sessions." aria-label="Feedback" />
      <small className="muted">{note.length}/300</small>
      <div className="modal-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" onClick={() => onSave(note)}>Save feedback</button></div>
    </Modal>
  );
}

export function JoinInstituteView({ onJoined }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async e => {
    e.preventDefault(); setError(""); setBusy(true);
    try { await api("/institute/join", { method: "POST", body: json({ code }) }); onJoined(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <section className="panel narrow">
      <h1>Join your institute</h1>
      <p className="muted">Enter the coaching code from your institute head. You keep your own classes and students.</p>
      <form onSubmit={submit}>
        <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="Coaching code" maxLength={12} aria-label="Coaching code" required />
        <ErrorBox error={error} />
        <button className="primary" disabled={busy}>{busy ? "Checking…" : "Join institute"}</button>
      </form>
    </section>
  );
}
