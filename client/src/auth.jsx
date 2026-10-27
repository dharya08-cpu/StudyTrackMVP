import React, { useEffect, useState } from "react";
import { api, json } from "./api.js";
import { ErrorBox, InfoTip, Loading } from "./ui.jsx";
import { GoogleButton } from "./google.jsx";
import { INSTITUTE_INFO } from "./institute-create.jsx";

const TEACHER_INTENTS = [
  { id: "classes", label: "Create my teacher account" },
  { id: "join-institute", label: "I have an institute code" },
  { id: "create-institute", label: "+ Create Your Own Coaching Institute" },
];
const Brand = () => <><div className="brand">Study<span>Track</span></div><p className="muted">Coaching + self-study progress companion.</p></>;
const Shell = ({ children }) => <main className="auth"><div className="auth-card">{children}</div></main>;
const Divider = () => <div className="or-line"><span>or</span></div>;

function PasswordField({ label = "Password", value, onChange, autoComplete, id }) {
  const [show, setShow] = useState(false);
  return (
    <label className="field" htmlFor={id}>{label}
      <span className="pw-wrap"><input id={id} type={show ? "text" : "password"} value={value} onChange={e => onChange(e.target.value)} autoComplete={autoComplete} maxLength={100} required />
        <button type="button" className="link pw-toggle" onClick={() => setShow(s => !s)} aria-label={show ? "Hide password" : "Show password"}>{show ? "Hide" : "Show"}</button></span>
    </label>
  );
}

// ---- LOG IN: Gmail + password (or Google). Nothing else is asked. ----
function LoginPage({ config, onLogin, goSignup, goForgot, notice }) {
  const [email, setEmail] = useState(""), [password, setPassword] = useState("");
  const [error, setError] = useState(""), [code, setCode] = useState(""), [busy, setBusy] = useState(false), [info, setInfo] = useState("");
  const [attempt, setAttempt] = useState(0);
  const submit = async e => {
    e.preventDefault(); setError(""); setCode(""); setInfo(""); setBusy(true);
    try { onLogin(await api("/auth/login", { method: "POST", body: json({ email, password }) })); }
    catch (err) { setError(err.message); setCode(err.code || ""); setBusy(false); }
  };
  const google = async credential => {
    setError(""); setCode(""); setBusy(true);
    try { onLogin(await api("/auth/google", { method: "POST", body: json({ credential, mode: "login" }) })); }
    catch (err) { setError(err.message); setCode(err.code || ""); setAttempt(a => a + 1); setBusy(false); }
  };
  const resend = async () => { try { const r = await api("/auth/resend-verification", { method: "POST", body: json({ email }) }); setInfo(r.message); setError(""); setCode(""); } catch (e) { setError(e.message); } };
  return (
    <Shell>
      <Brand />
      <h1>Log in</h1>
      {notice && <div className="notice" role="status">{notice}</div>}
      {config.passwordEnabled && (
        <form onSubmit={submit}>
          <label className="field">Gmail<input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" inputMode="email" placeholder="you@gmail.com" required /></label>
          <PasswordField id="login-pw" value={password} onChange={setPassword} autoComplete="current-password" />
          <ErrorBox error={error} />{info && <p className="success" role="status">{info}</p>}
          {code === "EMAIL_NOT_VERIFIED" && <button type="button" className="secondary" onClick={resend}>Send the verification e-mail again</button>}
          {code === "NO_ACCOUNT" && <button type="button" className="secondary" onClick={goSignup}>Create an account</button>}
          <button className="primary" disabled={busy}>{busy ? "Logging in…" : "Log in"}</button>
          <button type="button" className="link" onClick={goForgot}>Forgot password?</button>
        </form>
      )}
      {config.passwordEnabled && config.googleEnabled && <Divider />}
      {!config.passwordEnabled && <ErrorBox error={error} />}
      {config.googleEnabled && <div className={busy ? "google-wrap busy" : "google-wrap"}><GoogleButton key={`login-${attempt}`} clientId={config.googleClientId} onCredential={google} onError={setError} text="signin_with" /></div>}
      {!config.googleEnabled && !config.passwordEnabled && <div className="warning-text">Sign-in is not configured on this server yet.</div>}
      <p className="switch-line">New to StudyTrack? <button className="link" onClick={goSignup}>Create an account</button></p>
      <a className="link-a" href="/admin">Owner admin</a>
    </Shell>
  );
}

// ---- SIGN UP: role, Gmail, password, then verify by e-mail. Details are asked once, after this. ----
function SignupPage({ config, onLogin, goLogin, goSent }) {
  const [role, setRole] = useState("student"), [intent, setIntent] = useState("classes");
  const [email, setEmail] = useState(""), [password, setPassword] = useState(""), [confirm, setConfirm] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0);
  const submit = async e => {
    e.preventDefault(); setError("");
    if (password !== confirm) { setError("The two passwords do not match."); return; }
    setBusy(true);
    try { const r = await api("/auth/register", { method: "POST", body: json({ email, password, role }) }); goSent(r.email); }
    catch (err) { setError(err.message); setBusy(false); }
  };
  const google = async credential => {
    setError(""); setBusy(true);
    try { const d = await api("/auth/google", { method: "POST", body: json({ credential, role, mode: "signup" }) }); onLogin({ ...d, landing: role === "teacher" && intent !== "classes" ? intent : null }); }
    catch (err) { setError(err.message); setAttempt(a => a + 1); setBusy(false); }
  };
  return (
    <Shell>
      <Brand />
      <h1>Create your account</h1>
      <div className="role-switch" role="tablist" aria-label="Account type">
        <button type="button" role="tab" aria-selected={role === "student"} className={role === "student" ? "active" : ""} onClick={() => setRole("student")}>I'm a student</button>
        <button type="button" role="tab" aria-selected={role === "teacher"} className={role === "teacher" ? "active" : ""} onClick={() => setRole("teacher")}>I'm a teacher</button>
      </div>
      {role === "teacher" && (
        <div className="intent-list" role="radiogroup" aria-label="What would you like to do?">
          {TEACHER_INTENTS.map(i => (
            <label key={i.id} className={intent === i.id ? "intent active" : "intent"}>
              <input type="radio" name="intent" checked={intent === i.id} onChange={() => setIntent(i.id)} /><span>{i.label}</span>
              {i.id === "create-institute" && <InfoTip>{INSTITUTE_INFO}</InfoTip>}
            </label>
          ))}
          <small className="muted">This choice is used when you sign up with Google. With a password, find these options in the menu after you log in.</small>
        </div>
      )}
      {config.passwordEnabled && (
        <form onSubmit={submit}>
          <label className="field">Gmail address<input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" inputMode="email" placeholder="you@gmail.com" required /></label>
          <PasswordField id="signup-pw" label="Create a password" value={password} onChange={setPassword} autoComplete="new-password" />
          <PasswordField id="signup-pw2" label="Confirm password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
          <p className="hint">At least 8 characters with a letter and a number. We will e-mail you a link to verify your Gmail.</p>
          <ErrorBox error={error} />
          <button className="primary" disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
        </form>
      )}
      {config.passwordEnabled && config.googleEnabled && <Divider />}
      {!config.passwordEnabled && <ErrorBox error={error} />}
      {config.googleEnabled && <div className={busy ? "google-wrap busy" : "google-wrap"}><GoogleButton key={`signup-${role}-${attempt}`} clientId={config.googleClientId} onCredential={google} onError={setError} text="signup_with" /></div>}
      <p className="hint">Only Gmail addresses can sign up. After this you will be asked for a few details once, and your account is ready.</p>
      <p className="switch-line">Already have an account? <button className="link" onClick={goLogin}>Log in</button></p>
    </Shell>
  );
}

function SentPage({ email, goLogin }) {
  const [msg, setMsg] = useState(""), [error, setError] = useState("");
  const resend = async () => { setError(""); try { setMsg((await api("/auth/resend-verification", { method: "POST", body: json({ email }) })).message); } catch (e) { setError(e.message); } };
  return (
    <Shell><Brand /><h1>Check your Gmail</h1>
      <p>We sent a verification link to <b>{email}</b>. Open it to finish creating your account. The link works once and expires in 24 hours.</p>
      <p className="hint">Can't see it? Check the Spam or Promotions folder.</p>
      {msg && <p className="success" role="status">{msg}</p>}<ErrorBox error={error} />
      <button className="secondary" onClick={resend}>Send it again</button>
      <button className="link" onClick={goLogin}>Back to log in</button>
    </Shell>
  );
}

function ForgotPage({ goLogin }) {
  const [email, setEmail] = useState(""), [msg, setMsg] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const submit = async e => { e.preventDefault(); setError(""); setBusy(true); try { setMsg((await api("/auth/forgot-password", { method: "POST", body: json({ email }) })).message); } catch (err) { setError(err.message); } finally { setBusy(false); } };
  return (
    <Shell><Brand /><h1>Forgot password</h1>
      <p className="muted">Enter your Gmail and we will send you a link to choose a new password.</p>
      <form onSubmit={submit}>
        <label className="field">Gmail<input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@gmail.com" required /></label>
        <ErrorBox error={error} />{msg && <p className="success" role="status">{msg}</p>}
        <button className="primary" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
      </form>
      <button className="link" onClick={goLogin}>Back to log in</button>
    </Shell>
  );
}

// The e-mail link opens /verify?token=...  This page performs the verification and signs the person in.
export function VerifyPage({ onLogin, goLogin }) {
  const [error, setError] = useState("");
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token") || "";
    api("/auth/verify-email", { method: "POST", body: json({ token }) })
      .then(d => { window.history.replaceState({}, "", "/"); onLogin(d); })
      .catch(e => setError(e.message));
  }, []);
  return <Shell><Brand /><h1>Verifying your e-mail…</h1>{error ? <><ErrorBox error={error} /><button className="primary" onClick={goLogin}>Go to log in</button></> : <Loading />}</Shell>;
}
export function ResetPage({ goLogin }) {
  const [password, setPassword] = useState(""), [confirm, setConfirm] = useState(""), [error, setError] = useState(""), [done, setDone] = useState(false), [busy, setBusy] = useState(false);
  const submit = async e => {
    e.preventDefault(); setError("");
    if (password !== confirm) { setError("The two passwords do not match."); return; }
    setBusy(true);
    try { await api("/auth/reset-password", { method: "POST", body: json({ token: new URLSearchParams(window.location.search).get("token") || "", password }) }); window.history.replaceState({}, "", "/"); setDone(true); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  if (done) return <Shell><Brand /><h1>Password changed</h1><p>You can now log in with your new password.</p><button className="primary" onClick={goLogin}>Log in</button></Shell>;
  return (
    <Shell><Brand /><h1>Choose a new password</h1>
      <form onSubmit={submit}>
        <PasswordField id="reset-pw" label="New password" value={password} onChange={setPassword} autoComplete="new-password" />
        <PasswordField id="reset-pw2" label="Confirm new password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        <p className="hint">At least 8 characters with a letter and a number.</p>
        <ErrorBox error={error} /><button className="primary" disabled={busy}>{busy ? "Saving…" : "Save password"}</button>
      </form>
      <button className="link" onClick={goLogin}>Back to log in</button>
    </Shell>
  );
}

export function Auth({ onLogin, notice, startMode = "login" }) {
  const [config, setConfig] = useState(null), [error, setError] = useState("");
  const [mode, setMode] = useState(startMode), [sentTo, setSentTo] = useState("");
  useEffect(() => { api("/auth/config").then(setConfig).catch(e => setError(e.message)); }, []);
  if (!config) return error ? <Shell><Brand /><ErrorBox error={error} /></Shell> : <Loading />;
  if (mode === "signup") return <SignupPage config={config} onLogin={onLogin} goLogin={() => setMode("login")} goSent={email => { setSentTo(email); setMode("sent"); }} />;
  if (mode === "sent") return <SentPage email={sentTo} goLogin={() => setMode("login")} />;
  if (mode === "forgot") return <ForgotPage goLogin={() => setMode("login")} />;
  return <LoginPage config={config} onLogin={onLogin} goSignup={() => setMode("signup")} goForgot={() => setMode("forgot")} notice={notice} />;
}
