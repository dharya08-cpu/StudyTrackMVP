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
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [pwAttempt, setPwAttempt] = useState(0), [needGoogle, setNeedGoogle] = useState(false);

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
  const savePassword = async e => {
    e.preventDefault(); setError(""); setMessage("");
    if (pw.next !== pw.confirm) { setError("The two new passwords do not match."); return; }
    setBusy(true);
    try {
      const r = await api("/account/change-password", { method: "POST", body: json({ currentPassword: pw.current, newPassword: pw.next }) });
      setPw({ current: "", next: "", confirm: "" }); setNeedGoogle(false); onProfile?.({ ...user, has_password: true });
      setMessage(r.signedOutOthers ? `Password saved. ${r.signedOutOthers} other device${r.signedOutOthers === 1 ? "" : "s"} logged out.` : "Password saved."); await load();
    } catch (err) { setError(err.message); if (err.code === "REAUTH_REQUIRED") { setNeedGoogle(true); setPwAttempt(a => a + 1); } } finally { setBusy(false); }
  };
  const reauthForPassword = async credential => {
    try { await api("/account/reauth", { method: "POST", body: json({ credential }) }); setNeedGoogle(false); setMessage("Confirmed. Press Save password again."); setError(""); }
    catch (e) { setError(e.message); setPwAttempt(a => a + 1); }
  };
  const saveName = async e => {
    e.preventDefault();
    await run(async () => { const r = await api("/account/profile", { method: "PATCH", body: json({ name }) }); onProfile?.({ ...user, name: r.name }); }, "Name updated.");
  };

  return (
    <>
      <div className="page-title"><h1>Security &amp; privacy</h1><p className="muted">Manage where you are signed in, your password, and your data.</p></div>
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
      </section>

      {!user.is_demo && (
        <section className="panel">
          <h2>{user.has_password ? "Change password" : "Add a password"}</h2>
          <p className="muted">{user.has_password ? "Changing it logs out your other devices." : "You sign in with Google now. Add a password if you also want to log in with your Gmail and password."}</p>
          <form onSubmit={savePassword}>
            {user.has_password && <label className="field">Current password<input type="password" value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" required /></label>}
            <label className="field">New password<input type="password" value={pw.next} onChange={e => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" minLength={10} required /></label>
            <label className="field">Confirm new password<input type="password" value={pw.confirm} onChange={e => setPw({ ...pw, confirm: e.target.value })} autoComplete="new-password" minLength={10} required /></label>
            <p className="hint">At least 10 characters with a letter and a number. Avoid common words like “password”.</p>
            {needGoogle && config?.googleEnabled && <div className="panel inner"><p>Confirm it's you with Google first.</p><GoogleButton key={`pw-${pwAttempt}`} clientId={config.googleClientId} onCredential={reauthForPassword} onError={setError} /></div>}
            <button className="primary" disabled={busy}>Save password</button>
          </form>
        </section>
      )}

      <AlertsSection user={user} />

      {!user.is_demo && <PrivacySection user={user} onSignedOut={onSignedOut} config={config} />}

      {confirmAll && (
        <Modal title="Log out everywhere?" onClose={() => setConfirmAll(false)}>
          <p>Every device, including this one, will be signed out. You can sign in again with Google.</p>
          <div className="modal-actions"><button className="secondary" onClick={() => setConfirmAll(false)}>Cancel</button><button className="danger-solid" disabled={busy} onClick={logoutEverywhere}>Log out everywhere</button></div>
        </Modal>
      )}
    </>
  );
}

// Privacy rights without asking anyone: download everything StudyTrack holds about you, or delete your account.
function PrivacySection({ user, onSignedOut, config }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [confirming, setConfirming] = useState(false), [form, setForm] = useState({ confirm: "", password: "" });
  const [needGoogle, setNeedGoogle] = useState(false), [attempt, setAttempt] = useState(0);

  const download = async () => {
    setBusy(true); setError(""); setMessage("");
    try {
      const data = await api("/account/export");
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a"); a.href = url; a.download = "studytrack-my-data.json"; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("Your data was downloaded as studytrack-my-data.json.");
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const remove = async e => {
    e?.preventDefault?.(); setBusy(true); setError("");
    try {
      await api("/account", { method: "DELETE", body: json({ confirm: form.confirm, password: user.has_password ? form.password : undefined }) });
      setCsrf(null); onSignedOut("Your account was deleted.");
    } catch (err) {
      setError(err.message); setBusy(false);
      if (err.code === "REAUTH_REQUIRED") { setNeedGoogle(true); setAttempt(a => a + 1); }
    }
  };
  const reauth = async credential => {
    try { await api("/account/reauth", { method: "POST", body: json({ credential }) }); setNeedGoogle(false); setError(""); setMessage("Confirmed. Press Delete my account again."); }
    catch (e) { setError(e.message); setAttempt(a => a + 1); }
  };
  return (
    <section className="panel">
      <h2>Your data</h2>
      <p className="muted">You own your information. Download a copy of it, or delete your account whenever you like.</p>
      {message && <p className="success" role="status">{message}</p>}
      <div className="privacy-actions">
        <div className="privacy-card">
          <h3>Download my data</h3>
          <p className="muted">A file with your profile, study logs, goals, calendar, submissions and results. It never includes passwords.</p>
          <div><button className="secondary" disabled={busy} onClick={download}>{busy && !confirming ? "Preparing…" : "Download my data"}</button></div>
        </div>
        <div className="privacy-card danger">
          <h3>Delete my account</h3>
          <p>This permanently deletes your account and everything in it: study logs, goals, calendar items, submissions and notifications. It cannot be undone.{user.role === "teacher" ? " Teachers must delete their classes first." : ""}</p>
          {!confirming ? <div><button className="danger-outline" onClick={() => { setConfirming(true); setError(""); setMessage(""); }}>Delete my account…</button></div> : (
            <form onSubmit={remove}>
              {user.has_password && <label className="field">Your password<input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} autoComplete="current-password" required /></label>}
              <label className="field">Type DELETE to confirm<input value={form.confirm} onChange={e => setForm({ ...form, confirm: e.target.value })} autoComplete="off" autoCapitalize="characters" required /></label>
              {needGoogle && config?.googleEnabled && <div className="panel inner"><p>Confirm it's you with Google first.</p><GoogleButton key={`del-${attempt}`} clientId={config.googleClientId} onCredential={reauth} onError={setError} /></div>}
              <ErrorBox error={error} />
              <div className="action-row"><button type="button" className="secondary" onClick={() => { setConfirming(false); setError(""); }}>Keep my account</button><button className="danger-solid" disabled={busy || form.confirm !== "DELETE"}>{busy ? "Deleting…" : "Delete my account"}</button></div>
            </form>
          )}
        </div>
      </div>
      {!confirming && error && <ErrorBox error={error} />}
    </section>
  );
}

// Switches for due-date reminders (students) and "new sign-in" alerts (everyone).
function AlertsSection({ user }) {
  const [settings, setSettings] = useState(null), [error, setError] = useState(""), [saving, setSaving] = useState("");
  useEffect(() => { api("/account/settings").then(setSettings).catch(e => setError(e.message)); }, []);
  if (!settings) return error ? <section className="panel"><ErrorBox error={error} /></section> : null;
  const set = async (key, value) => {
    setSaving(key); setError("");
    try { setSettings(await api("/account/settings", { method: "PATCH", body: json({ [key]: value }) })); } catch (e) { setError(e.message); } finally { setSaving(""); }
  };
  const rows = [
    ...(user.role === "student" ? [["remindersEnabled", "reminders_enabled", "Due-date reminders", "A notification the day before, on the day, and when something is overdue: homework, tests, exams and your own goals."]] : []),
    ["loginAlertsEnabled", "login_alerts_enabled", "New sign-in alerts", `When your account is opened on a new kind of device (a different browser or phone), you get a notification in the app${settings.email_alerts_available ? " and an e-mail" : ""}, so you can act fast if it was not you.`],
  ];
  return (
    <section className="panel">
      <h2>Alerts and reminders</h2>
      <div className="alert-rows">
        {rows.map(([key, field, title, text]) => (
          <label className="alert-row" key={key}>
            <input type="checkbox" checked={settings[field]} disabled={saving === key} onChange={e => set(key, e.target.checked)} />
            <span><b>{title}</b><small>{text}</small></span>
          </label>
        ))}
      </div>
      <ErrorBox error={error} />
    </section>
  );
}
