import React, { useCallback, useEffect, useState } from "react";
import { api, json } from "./api.js";
import { ErrorBox, List, Loading, Modal, formatDate } from "./ui.jsx";

// "My classes": a student can be in many classes (of one teacher, several teachers or an institute) and ask to join more.
export function StudentClasses({ onChanged }) {
  const [data, setData] = useState(null), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [code, setCode] = useState(""), [busy, setBusy] = useState(false), [leaving, setLeaving] = useState(null);
  const load = useCallback(async () => { try { setData(await api("/student/classes")); setError(""); } catch (e) { setError(e.message); } }, []);
  useEffect(() => { load(); }, [load]);
  const waiting = Boolean(data?.pending.length);
  useEffect(() => {
    if (!waiting) return undefined;
    const tick = () => { if (!document.hidden) { load().then(() => onChanged?.()); } };
    const t = setInterval(tick, 8000);
    return () => clearInterval(t);
  }, [waiting, load, onChanged]);

  const join = async e => {
    e.preventDefault(); setError(""); setMessage(""); setBusy(true);
    try { const r = await api("/student/join-request", { method: "POST", body: json({ classCode: code }) }); setCode(""); setMessage(`Request sent to ${r.request.teacherName} for ${r.request.className}. You can join once they allow you in.`); await load(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const cancel = async r => { try { await api(`/student/join-requests/${r.id}/cancel`, { method: "POST", body: "{}" }); await load(); } catch (e) { setError(e.message); await load(); } };
  const leave = async () => { const c = leaving; setLeaving(null); try { await api(`/student/classes/${c.id}/leave`, { method: "POST", body: "{}" }); setMessage(`You left ${c.name}.`); await load(); onChanged?.(); } catch (e) { setError(e.message); } };

  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  return (
    <>
      <section className="panel">
        <h2>My classes</h2>
        <List items={data.classes} empty="You haven't joined a class yet. Ask your teacher for a class code and enter it below." render={c => (
          <div className="item"><div><b>{c.name}</b><small>{c.teacher_name}{c.institute_name ? ` • ${c.institute_name}` : ""} • joined {formatDate(c.joined_at)}</small>{!c.available && <small className="warn">{c.unavailable_reason}</small>}</div>
            <div className="status-group">{!c.available && <span className="badge late">paused</span>}<button className="danger-outline small-btn" onClick={() => setLeaving(c)}>Leave</button></div></div>
        )} />
      </section>
      <section className="panel">
        <h2>Join another class</h2>
        <p className="muted">Enter a class code from your teacher. You can be in as many classes as you like, for example Physics, Chemistry and Biology.</p>
        <form className="inline-form" onSubmit={join}>
          <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="Class code" maxLength={12} autoCapitalize="characters" autoComplete="off" aria-label="Class code" required />
          <button className="primary" disabled={busy}>{busy ? "Sending…" : "Send join request"}</button>
        </form>
        <ErrorBox error={error} />{message && <p className="success" role="status">{message}</p>}
      </section>
      {(data.pending.length > 0 || data.declined.length > 0) && (
        <section className="panel">
          <h2>Join requests</h2>
          {data.pending.map(r => <div className="item" key={r.id}><div><b>{r.className}</b><small>Waiting for {r.teacherName} to allow you in. This page updates by itself.</small></div><button className="link" onClick={() => cancel(r)}>Cancel request</button></div>)}
          {data.declined.map(r => <div className="item" key={r.id}><div><b>{r.className}</b><small>{r.teacherName} didn't allow you to join. You can ask your teacher, or try again after 24 hours.</small></div><span className="badge late">declined</span></div>)}
        </section>
      )}
      {leaving && <Modal title={`Leave ${leaving.name}?`} onClose={() => setLeaving(null)}><p>You will lose access to this class's homework and tests. Your own study logs stay. You can send a new join request later.</p><div className="modal-actions"><button className="secondary" onClick={() => setLeaving(null)}>Stay</button><button className="danger-solid" onClick={leave}>Leave class</button></div></Modal>}
    </>
  );
}
