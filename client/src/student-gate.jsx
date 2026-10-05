import React, { useCallback, useEffect, useState } from "react";
import { api, json } from "./api.js";
import { ErrorBox, Loading } from "./ui.jsx";
import { StudentApp } from "./dashboards.jsx";

// Sits between login and the student dashboard. A student without a class is
// asked for a class code, then waits for the teacher to allow them in.
export function StudentGate({ user, logout }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try { setStatus(await api("/student/class-status")); setError(""); }
    catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const waiting = Boolean(status && !status.joined && status.pending);
  useEffect(() => {
    if (!waiting) return undefined;
    const tick = () => { if (!document.hidden) refresh(); };
    const timer = setInterval(tick, 7000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [waiting, refresh]);

  if (!status) {
    if (error) return <GateShell user={user} logout={logout}><ErrorBox error={error} /><button className="primary" onClick={refresh}>Try again</button></GateShell>;
    return <Loading />;
  }
  if (status.joined) return <StudentApp user={user} logout={logout} />;
  if (status.pending) return <PendingScreen user={user} logout={logout} pending={status.pending} refresh={refresh} />;
  return <ClassCodeScreen user={user} logout={logout} decision={status.lastDecision} refresh={refresh} />;
}

function GateShell({ user, logout, children }) {
  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand">Study<span>Track</span></div>
        {children}
        <button className="link" onClick={logout}>Logout ({user.email})</button>
      </div>
    </main>
  );
}

function ClassCodeScreen({ user, logout, decision, refresh }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showDecision, setShowDecision] = useState(true);

  const submit = async e => {
    e.preventDefault();
    setError("");
    setShowDecision(false);
    setBusy(true);
    try {
      await api("/student/join-request", { method: "POST", body: json({ classCode: code }) });
      await refresh();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <GateShell user={user} logout={logout}>
      <h1>Enter your class code</h1>
      <p className="muted">Hi {user.name.split(" ")[0]}. Your teacher gives you a class code. Enter it to ask to join their class.</p>
      {decision && showDecision && (
        <div className="error" role="alert">{decision.teacherName} didn't allow you to join their class. You can ask your teacher, or try a different class code.</div>
      )}
      <form onSubmit={submit}>
        <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="Class code" maxLength={12} autoCapitalize="characters" autoComplete="off" aria-label="Class code" required />
        <ErrorBox error={error} />
        <button className="primary" disabled={busy}>{busy ? "Sending…" : "Send join request"}</button>
      </form>
    </GateShell>
  );
}

function PendingScreen({ user, logout, pending, refresh }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancel = async () => {
    setBusy(true);
    setError("");
    try { await api("/student/join-request/cancel", { method: "POST", body: "{}" }); await refresh(); }
    catch (e) { setError(e.message); await refresh(); } finally { setBusy(false); }
  };
  return (
    <GateShell user={user} logout={logout}>
      <div className="pending-mark" aria-hidden="true"><i /><i /><i /></div>
      <h1>Request sent</h1>
      <p role="status">Your request has been sent to <b>{pending.teacherName}</b>'s class. You will be permitted to class once they allow you to enter. Please wait.</p>
      <p className="muted small-print">Class: {pending.className}. This page updates by itself.</p>
      <ErrorBox error={error} />
      <div className="stack">
        <button className="secondary" onClick={refresh}>Check now</button>
        <button className="link" disabled={busy} onClick={cancel}>Cancel request and use a different code</button>
      </div>
    </GateShell>
  );
}
