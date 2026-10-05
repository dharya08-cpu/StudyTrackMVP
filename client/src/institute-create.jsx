import React, { useState } from "react";
import { api, json } from "./api.js";
import { ErrorBox } from "./ui.jsx";

// Two-step "Create Your Own Coaching Institute" flow.
//   Step 1: email and password (for a signed-in teacher the email is fixed and
//           the password is asked again as confirmation).
//   Step 2: institute name, coaching code and details.
// The request goes to the owner for approval; the head is signed in right away.
export function InstituteCreateFlow({ user = null, onDone, onCancel }) {
  const [step, setStep] = useState(1);
  const [account, setAccount] = useState({ email: user?.email || "", password: "", name: user?.name || "" });
  const [details, setDetails] = useState({ instituteName: "", coachingCode: "", phone: "", city: "", description: "", expectedTeachers: "", expectedStudents: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const setA = key => e => setAccount({ ...account, [key]: e.target.value });
  const setD = key => e => setDetails({ ...details, [key]: e.target.value });

  const next = e => {
    e.preventDefault();
    setError("");
    if (!account.email.trim() || !account.password) { setError("Enter your email and password."); return; }
    setStep(2);
  };
  const submit = async e => {
    e.preventDefault();
    setError("");
    if (!account.name.trim()) { setError("Enter your name. It is shown as the institute head."); return; }
    setBusy(true);
    try {
      const body = { ...account, ...details, expectedTeachers: details.expectedTeachers === "" ? null : Number(details.expectedTeachers), expectedStudents: details.expectedStudents === "" ? null : Number(details.expectedStudents) };
      const result = await api("/auth/institute-request", { method: "POST", body: json(body) });
      onDone(result);
    } catch (err) {
      setError(err.message);
      if (err.status === 401) setStep(1);
    } finally { setBusy(false); }
  };

  return (
    <div className="flow">
      <h1>Create your coaching institute</h1>
      <p className="muted">{step === 1 ? "Step 1 of 2: confirm who you are." : "Step 2 of 2: tell us about your institute."}</p>
      {step === 1 ? (
        <form onSubmit={next}>
          <label className="field">Email<input type="email" autoComplete="email" value={account.email} onChange={setA("email")} readOnly={Boolean(user)} required /></label>
          <label className="field">{user ? "Confirm your password" : "Password"}<input type="password" autoComplete={user ? "current-password" : "new-password"} minLength={user ? undefined : 6} maxLength={128} value={account.password} onChange={setA("password")} required /></label>
          {!user && <p className="hint">New here? Use any email and a password of 6+ characters. We create your teacher account with the institute. Already a StudyTrack teacher? Use your existing email and password.</p>}
          <ErrorBox error={error} />
          <button className="primary">Continue</button>
          <button type="button" className="link" onClick={onCancel}>Cancel</button>
        </form>
      ) : (
        <form onSubmit={submit}>
          <label className="field">Your name<input value={account.name} onChange={setA("name")} maxLength={100} required /></label>
          <label className="field">Institute name<input value={details.instituteName} onChange={setD("instituteName")} minLength={3} maxLength={80} placeholder="e.g. Bright Future Academy" required /></label>
          <label className="field">Coaching code <span className="hint-inline">(optional. Teachers use it to join. Leave blank to get one.)</span><input value={details.coachingCode} onChange={e => setDetails({ ...details, coachingCode: e.target.value.toUpperCase() })} maxLength={12} placeholder="4 to 12 letters or numbers" pattern="[A-Za-z0-9]{4,12}|" title="4 to 12 letters or numbers" /></label>
          <label className="field">Contact phone<input type="tel" value={details.phone} onChange={setD("phone")} maxLength={20} required /></label>
          <label className="field">City<input value={details.city} onChange={setD("city")} maxLength={80} /></label>
          <div className="form-grid">
            <label className="field">Teachers expected<input type="number" min="0" value={details.expectedTeachers} onChange={setD("expectedTeachers")} /></label>
            <label className="field">Students expected<input type="number" min="0" value={details.expectedStudents} onChange={setD("expectedStudents")} /></label>
          </div>
          <label className="field">About your institute <span className="hint-inline">(optional)</span><textarea value={details.description} onChange={setD("description")} maxLength={500} /></label>
          <ErrorBox error={error} />
          <button className="primary" disabled={busy}>{busy ? "Sending…" : "Send for approval"}</button>
          <button type="button" className="link" onClick={() => { setStep(1); setError(""); }}>Back</button>
        </form>
      )}
    </div>
  );
}

export const INSTITUTE_INFO = (
  <>
    A coaching institute is a shared space for your whole coaching.<br />
    You create it and receive a coaching code.<br />
    Other teachers join with that code and work in one place.<br />
    Their classes, student counts and progress show on one institute page.<br />
    StudyTrack reviews each new institute before it goes live.
  </>
);
