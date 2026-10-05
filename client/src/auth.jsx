import React, { useState } from "react";
import { api, json } from "./api.js";
import { ErrorBox, InfoTip } from "./ui.jsx";
import { InstituteCreateFlow, INSTITUTE_INFO } from "./institute-create.jsx";

const MODE_TITLES = {
  login: role => `Login as ${role}`,
  register: () => "Student registration",
  "teacher-register": () => "New teacher",
  "join-institute": () => "Join your institute",
};

export function Auth({ role, setRole, mode, setMode, onLogin, notice }) {
  const [form, setForm] = useState({ name: "", email: "", password: "", classCode: "", className: "", coachingCode: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = key => e => setForm({ ...form, [key]: e.target.value });
  const switchMode = next => { setError(""); setMode(next); };

  const submit = async e => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      let path, body;
      if (mode === "register") { path = "/auth/register"; body = { name: form.name, email: form.email, password: form.password }; }
      else if (mode === "teacher-register") { path = "/auth/teacher-register"; body = { name: form.name, email: form.email, password: form.password, className: form.className, classCode: form.classCode }; }
      else if (mode === "join-institute") { path = "/auth/teacher-join-institute"; body = { name: form.name, email: form.email, password: form.password, coachingCode: form.coachingCode }; }
      else { path = "/auth/login"; body = { email: form.email, password: form.password, role }; }
      const d = await api(path, { method: "POST", body: json(body) });
      onLogin(d);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  if (mode === "create-institute") {
    return <main className="auth"><div className="auth-card"><div className="brand">Study<span>Track</span></div><InstituteCreateFlow onDone={onLogin} onCancel={() => switchMode("login")} /></div></main>;
  }

  const showName = mode === "register" || mode === "teacher-register" || mode === "join-institute";
  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand">Study<span>Track</span></div>
        <p className="muted">Coaching + self-study progress companion.</p>
        <div className="role-switch" role="tablist" aria-label="Account type">
          <button role="tab" aria-selected={role === "student"} className={role === "student" ? "active" : ""} onClick={() => { setRole("student"); switchMode("login"); }}>Student</button>
          <button role="tab" aria-selected={role === "teacher"} className={role === "teacher" ? "active" : ""} onClick={() => { setRole("teacher"); switchMode("login"); }}>Teacher</button>
        </div>
        {notice && <div className="notice">{notice}</div>}
        <h1>{MODE_TITLES[mode](role)}</h1>
        {mode === "teacher-register" && <p className="muted small-print">Create your account and your first class in one step.</p>}
        {mode === "join-institute" && <p className="muted small-print">Your institute head gives you the coaching code.</p>}
        <form onSubmit={submit}>
          {showName && <input autoComplete="name" placeholder={mode === "register" ? "Full name" : "Your name"} value={form.name} onChange={set("name")} maxLength={100} required={mode !== "join-institute"} />}
          <input type="email" autoComplete="email" placeholder="Email" value={form.email} onChange={set("email")} required />
          <input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="Password" value={form.password} onChange={set("password")} minLength={mode === "login" || mode === "join-institute" ? undefined : 6} maxLength={128} required />
          {mode === "join-institute" && <><input placeholder="Coaching code" value={form.coachingCode} onChange={e => setForm({ ...form, coachingCode: e.target.value.toUpperCase() })} maxLength={12} required /><p className="hint">Already a StudyTrack teacher? Enter your existing email and password and you'll keep your classes. New teacher? Add your name and choose a password.</p></>}
          {mode === "teacher-register" && <>
            <input placeholder="Class name (e.g. Class 11 Physics)" value={form.className} onChange={set("className")} maxLength={100} required />
            <input placeholder="Class code (leave blank to generate)" value={form.classCode} onChange={e => setForm({ ...form, classCode: e.target.value.toUpperCase() })} maxLength={12} pattern="[A-Za-z0-9]{4,12}|" title="4 to 12 letters or numbers" />
            <p className="hint">Students enter this class code to ask to join you.</p>
          </>}
          <ErrorBox error={error} />
          <button className="primary" disabled={busy}>{busy ? "Please wait…" : mode === "login" ? "Login" : mode === "register" ? "Create student account" : mode === "teacher-register" ? "Create teacher account" : "Join institute"}</button>
        </form>

        {role === "student" && (
          <button className="link" onClick={() => switchMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "New student? Create your account" : "Already have an account? Login"}</button>
        )}
        {role === "teacher" && (
          <div className="auth-links">
            {mode !== "login" && <button className="link" onClick={() => switchMode("login")}>Back to teacher login</button>}
            {mode === "login" && <>
              <button className="link" onClick={() => switchMode("teacher-register")}>New teacher? Create your account now</button>
              <button className="link" onClick={() => switchMode("join-institute")}>Have an institute code? Join here</button>
              <div className="link-row"><button className="link" onClick={() => switchMode("create-institute")}>+ Create Your Own Coaching Institute</button><InfoTip>{INSTITUTE_INFO}</InfoTip></div>
            </>}
          </div>
        )}
      </div>
    </main>
  );
}
