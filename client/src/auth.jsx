import React, { useEffect, useState } from "react";
import { api, json } from "./api.js";
import { ErrorBox, InfoTip, Loading } from "./ui.jsx";
import { GoogleButton } from "./google.jsx";
import { INSTITUTE_INFO } from "./institute-create.jsx";

const TEACHER_INTENTS = [
  { id: "classes", label: "Sign in / create my teacher account" },
  { id: "join-institute", label: "I have an institute code" },
  { id: "create-institute", label: "+ Create Your Own Coaching Institute" },
];

// Google-only sign-in. There are no passwords in StudyTrack: Google proves who you are,
// and only verified Gmail accounts are accepted.
export function Auth({ role, setRole, onLogin, notice }) {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [intent, setIntent] = useState("classes");

  useEffect(() => { api("/auth/config").then(setConfig).catch(e => setError(e.message)); }, []);

  const submit = async credential => {
    setError(""); setBusy(true);
    try {
      const d = await api("/auth/google", { method: "POST", body: json({ credential, role }) });
      onLogin({ ...d, landing: role === "teacher" && intent !== "classes" ? intent : null });
    } catch (err) { setError(err.message); setAttempt(a => a + 1); setBusy(false); }
  };

  if (!config && !error) return <Loading />;
  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand">Study<span>Track</span></div>
        <p className="muted">Coaching + self-study progress companion.</p>
        <div className="role-switch" role="tablist" aria-label="Account type">
          <button role="tab" aria-selected={role === "student"} className={role === "student" ? "active" : ""} onClick={() => { setRole("student"); setError(""); }}>Student</button>
          <button role="tab" aria-selected={role === "teacher"} className={role === "teacher" ? "active" : ""} onClick={() => { setRole("teacher"); setError(""); }}>Teacher</button>
        </div>
        {notice && <div className="notice" role="status">{notice}</div>}
        <h1>{role === "student" ? "Student sign-in" : "Teacher sign-in"}</h1>
        <p className="muted small-print">{role === "student" ? "New or returning, use your Gmail account. Your account is created the first time you sign in." : "Use your Gmail account. If you are new, your teacher account is created the first time you sign in."}</p>
        {role === "teacher" && (
          <div className="intent-list" role="radiogroup" aria-label="What would you like to do?">
            {TEACHER_INTENTS.map(i => (
              <label key={i.id} className={intent === i.id ? "intent active" : "intent"}>
                <input type="radio" name="intent" checked={intent === i.id} onChange={() => setIntent(i.id)} />
                <span>{i.label}</span>
                {i.id === "create-institute" && <InfoTip>{INSTITUTE_INFO}</InfoTip>}
              </label>
            ))}
          </div>
        )}
        <ErrorBox error={error} />
        {config?.googleEnabled
          ? <div className={busy ? "google-wrap busy" : "google-wrap"}><GoogleButton key={`${role}-${attempt}`} clientId={config.googleClientId} onCredential={submit} onError={setError} /></div>
          : config && <div className="warning-text">Google sign-in is not configured on this server yet. The owner needs to set GOOGLE_CLIENT_ID.</div>}
        <p className="hint">Only verified Gmail accounts can sign in. School or work Google accounts are not accepted. StudyTrack never sees or stores a password.</p>
        <a className="link-a" href="/admin">Owner admin</a>
      </div>
    </main>
  );
}
