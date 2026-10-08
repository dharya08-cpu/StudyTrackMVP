import React, { useCallback, useEffect, useState } from "react";
import { api, json, setCsrf } from "./api.js";
import { ErrorBox, Loading, Modal, timeAgo } from "./ui.jsx";
import { GoogleButton } from "./google.jsx";

const deviceIcon = type => (type === "mobile" || type === "tablet" ? "📱" : "💻");

// Security -> Active sessions, plus re-verification and changing the linked Gmail.
export function SecurityPage({ user, onSignedOut, onProfile }) {
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [email, setEmail] = useState(user.email);
  const [flow, setFlow] = useState(null);   // null | "new" | "reauth"
  const [attempt, setAttempt] = useState(0);
  const [config, setConfig] = useState(null);
  const [name, setName] = useState(user.name);

  const load = useCallback(async () => { try { setSessions((await api("/account/sessions")).sessions); setError(""); } catch (e) { setError(e.message); } }, []);
  useEffect(() => { load(); api("/auth/config").then(setConfig).catch(() => {}); }, [load]);
  useEffect(() => { const t = setInterval(() => { if (!document.hidden) load(); }, 60000); return () => clearInterval(t); }, [load]);

  const run = async (fn, text) => {
    setBusy(true); setError(""); setMessage("");
    try { await fn(); if (text) setMessage(text); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const logoutOne = s => run(() => api(`/account/sessions/${s.id}`, { method: "DELETE" }), "That device was logged out.");
  const logoutOthers = () => run(() => api("/account/sessions/revoke-others", { method: "POST", body: "{}" }), "All other devices were logged out.");
  const logoutEverywhere = async () => { setBusy(true); try { await api("/auth/logout-all", { method: "POST", body: "{}" }); setCsrf(null); onSignedOut("You were logged out of every device."); } catch (e) { setError(e.message); setBusy(false); } };

  const changeEmail = async credential => {
    setError(""); setMessage("");
    try {
      const r = await api("/account/change-email", { method: "POST", body: json({ credential }) });
      setEmail(r.email); setFlow(null); setMessage(`Your linked Gmail is now ${r.email}. Other devices were logged out.`); await load();
    } catch (e) { setError(e.message); setAttempt(a => a + 1); if (e.code === "REAUTH_REQUIRED") setFlow("reauth"); }
  };
  const reauth = async credential => {
    setError("");
    try { await api("/account/reauth", { method: "POST", body: json({ credential }) }); setFlow("new"); setAttempt(a => a + 1); setMessage("Confirmed. Now choose the new Gmail account."); }
    catch (e) { setError(e.message); setAttempt(a => a + 1); }
  };
  const saveName = async e => {
    e.preventDefault();
    await run(async () => { const r = await api("/account/profile", { method: "PATCH", body: json({ name }) }); onProfile?.({ ...user, name: r.name }); }, "Name updated.");
  };

  return (
    <>
      <div className="page-title"><h1>Security</h1><p className="muted">Manage where you are signed in and which Google account is linked.</p></div>
      {message && <p className="success" role="status">{message}</p>}
      <ErrorBox error={error} />

      <section className="panel">
        <div className="panel-head"><div><h2>Active sessions</h2><p className="muted">Devices that are signed in to your account right now.</p></div></div>
        {!sessions ? <Loading /> : (
          <div className="list">
            {sessions.map(s => (
              <div className={s.current ? "item session current" : "item session"} key={s.id}>
                <div className="session-main">
                  <span className="device-icon" aria-hidden="true">{deviceIcon(s.device_type)}</span>
                  <div>
                    <b>{s.os}{s.browser ? ` · ${s.browser}` : ""}</b>{s.current && <span className="badge completed this-device">This device</span>}
                    <small>{s.location || "Location unavailable"}</small>
                    <small className={s.active_now ? "active-now" : ""}>{s.active_now ? "● Active now" : timeAgo(s.last_seen_at)}</small>
                  </div>
                </div>
                {!s.current && <button className="secondary small-btn" disabled={busy} onClick={() => logoutOne(s)}>Log out</button>}
              </div>
            ))}
          </div>
        )}
        <div className="action-row session-actions">
          <button className="primary" disabled={busy || !sessions || sessions.length < 2} onClick={logoutOthers}>Log out all other devices</button>
          <button className="danger-outline" disabled={busy} onClick={() => setConfirmAll(true)}>Log out everywhere</button>
        </div>
        <p className="hint">Locations show the city when your host provides it; otherwise only a masked network address is shown. We never store your full IP address.</p>
      </section>

      <section className="panel">
        <h2>Account</h2>
        <form className="form-grid" onSubmit={saveName}>
          <label className="field">Display name<input value={name} onChange={e => setName(e.target.value)} maxLength={100} required /></label>
          <button className="secondary" disabled={busy || name.trim() === user.name}>Save name</button>
        </form>
        <div className="linked-email">
          <div><small>Linked Google account</small><b>{email}</b></div>
          {!flow && <button className="secondary" onClick={() => { setFlow("new"); setAttempt(a => a + 1); setError(""); setMessage(""); }}>Change linked Gmail</button>}
        </div>
        {flow && (
          <div className="panel inner">
            <h3>{flow === "reauth" ? "Step 1: confirm it's you" : "Choose the new Gmail"}</h3>
            <p className="muted">{flow === "reauth" ? `Sign in again with ${email} to confirm it's really you.` : "Sign in with the new Gmail account to prove you own it. Only verified Gmail accounts are accepted."}</p>
            {config?.googleEnabled && <GoogleButton key={`${flow}-${attempt}`} clientId={config.googleClientId} onCredential={flow === "reauth" ? reauth : changeEmail} onError={setError} />}
            <button className="link" onClick={() => setFlow(null)}>Cancel</button>
          </div>
        )}
        <p className="hint">StudyTrack has no password. Google handles sign-in, so there is nothing to reset or leak here.</p>
      </section>

      {confirmAll && (
        <Modal title="Log out everywhere?" onClose={() => setConfirmAll(false)}>
          <p>Every device, including this one, will be signed out. You can sign in again with Google.</p>
          <div className="modal-actions"><button className="secondary" onClick={() => setConfirmAll(false)}>Cancel</button><button className="danger-solid" disabled={busy} onClick={logoutEverywhere}>Log out everywhere</button></div>
        </Modal>
      )}
    </>
  );
}
