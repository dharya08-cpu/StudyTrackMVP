import React, { useCallback, useEffect, useState } from "react";
import { api, json } from "./api.js";
import { ErrorBox, Loading, Modal, formatDate } from "./ui.jsx";

// "Student Joining Request": every pending request across all of the teacher's classes.
export function JoinRequests({ onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [denying, setDenying] = useState(null);
  const [confirmBlock, setConfirmBlock] = useState(null);

  const load = useCallback(async () => {
    try { setData(await api("/teacher/join-requests")); setError(""); }
    catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const settle = async text => { setMessage(text); await load(); onChanged?.(); };
  const approve = async r => {
    setBusyId(r.id); setMessage(""); setError("");
    try { await api(`/teacher/join-requests/${r.id}/approve`, { method: "POST", body: "{}" }); await settle(`${r.student_name} was added to ${r.class_name}.`); }
    catch (e) { setError(e.message); await load(); } finally { setBusyId(null); }
  };
  const deny = async (r, mode) => {
    setBusyId(r.id); setMessage(""); setError("");
    try {
      await api(`/teacher/join-requests/${r.id}/deny`, { method: "POST", body: json(mode === "block" ? { mode, confirm: true } : { mode }) });
      setDenying(null); setConfirmBlock(null);
      await settle(mode === "block" ? `${r.student_name} is blocked from all your classes.` : `Request from ${r.student_name} was removed.`);
    } catch (e) { setDenying(null); setConfirmBlock(null); setError(e.message); await load(); } finally { setBusyId(null); }
  };
  const unblock = async b => {
    setError("");
    try { await api(`/teacher/blocks/${b.id}`, { method: "DELETE" }); await settle(`${b.student_name || b.student_email} can send join requests again.`); }
    catch (e) { setError(e.message); }
  };

  if (!data) return error ? <section className="panel"><ErrorBox error={error} /><button className="secondary" onClick={load}>Try again</button></section> : <Loading />;
  return (
    <>
      <div className="page-title"><h1>Student Joining Request</h1><p className="muted">Students who entered one of your class codes and are waiting for you.</p></div>
      {message && <p className="success" role="status">{message}</p>}
      <ErrorBox error={error} />
      <section className="panel">
        {data.pending.length === 0 ? (
          <div className="empty">No requests right now. Share your class code and new requests show up here.</div>
        ) : (
          <div className="list">
            {data.pending.map(r => (
              <div className="item request-row" key={r.id}>
                <div>
                  <b>{r.student_name}</b> wants to join your <b>{r.class_name}</b> batch.
                  <small>{r.student_email} • asked {formatDate(r.created_at)}</small>
                </div>
                <div className="status-group">
                  <button className="allow-btn" disabled={busyId === r.id} onClick={() => approve(r)} aria-label={`Allow ${r.student_name}`}>✓ Allow</button>
                  <button className="deny-btn" disabled={busyId === r.id} onClick={() => setDenying(r)} aria-label={`Deny ${r.student_name}`}>✕ Deny</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {data.blocked.length > 0 && (
        <section className="panel">
          <h2>Blocked students</h2>
          <p className="muted">These emails can't send a request to any of your classes.</p>
          <div className="list">
            {data.blocked.map(b => (
              <div className="item" key={b.id}>
                <div><b>{b.student_name || "Student"}</b><small>{b.student_email}</small></div>
                <button className="secondary" onClick={() => unblock(b)}>Unblock</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {denying && !confirmBlock && (
        <Modal title={`Deny ${denying.student_name}?`} onClose={() => setDenying(null)}>
          <p>Choose what happens to this request.</p>
          <div className="choice-stack">
            <button className="choice" onClick={() => deny(denying, "remove")}><b>Deny &amp; Remove</b><small>Removes the request. The student is told you didn't allow them in, and can ask again later.</small></button>
            <button className="choice danger" onClick={() => setConfirmBlock(denying)}><b>Deny &amp; Block</b><small>Also stops this student from sending requests to any of your classes.</small></button>
          </div>
        </Modal>
      )}
      {confirmBlock && (
        <Modal title="Block this student?" onClose={() => setConfirmBlock(null)}>
          <p className="warning-text">Are you sure? Blocking {confirmBlock.student_email} stops this student from sending a joining request to any of your classes, now and in the future. They will see that you didn't allow them to join.</p>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setConfirmBlock(null)}>Go back</button>
            <button className="danger-solid" disabled={busyId === confirmBlock.id} onClick={() => deny(confirmBlock, "block")}>Yes, block student</button>
          </div>
        </Modal>
      )}
    </>
  );
}
