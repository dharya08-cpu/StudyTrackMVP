import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { api, setCsrf, setActiveClass } from "./api.js";
import { Loading } from "./ui.jsx";
import { Auth } from "./auth.jsx";
import { TeacherShell } from "./teacher.jsx";
import { StudentApp } from "./student.jsx";
import { AdminApp } from "./admin.jsx";

function BlockedScreen({ message, logout }) {
  return (
    <main className="auth"><div className="auth-card">
      <div className="brand">Study<span>Track</span></div>
      <h1>Access paused</h1><p role="alert">{message}</p>
      <button className="primary" onClick={logout}>Back to sign-in</button>
    </div></main>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);
  const [blocked, setBlocked] = useState(null);
  const [landing, setLanding] = useState(null);
  const [role, setRole] = useState("student");
  const [notice, setNotice] = useState("");

  const reset = useCallback((text = "") => { setCsrf(null); setActiveClass(null); setUser(null); setBlocked(null); setLanding(null); setNotice(text); }, []);
  const logout = useCallback(async () => { try { await api("/auth/logout", { method: "POST", body: "{}" }); } catch { /* the session may already be gone */ } reset(); }, [reset]);

  // The session lives in an httpOnly cookie, so the only way to know if we are signed in is to ask the server.
  useEffect(() => {
    api("/me").then(x => { setCsrf(x.csrfToken); setUser(x.user); }).catch(() => {}).finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    const onBlocked = e => setBlocked(e.detail?.message || "Access is paused. Please contact support.");
    const onSignedOut = () => reset("Your session ended. Please sign in again.");
    window.addEventListener("studytrack:blocked", onBlocked);
    window.addEventListener("studytrack:signed-out", onSignedOut);
    return () => { window.removeEventListener("studytrack:blocked", onBlocked); window.removeEventListener("studytrack:signed-out", onSignedOut); };
  }, [reset]);

  const handleLogin = data => { setCsrf(data.csrfToken); setActiveClass(null); setNotice(""); setLanding(data.landing || null); setUser(data.user); };

  if (booting) return <Loading />;
  if (blocked) return <BlockedScreen message={blocked} logout={logout} />;
  if (!user) return <Auth role={role} setRole={setRole} onLogin={handleLogin} notice={notice} />;
  if (user.role === "teacher") return <TeacherShell key={user.id} user={user} logout={logout} landing={landing} onProfile={setUser} onSignedOut={reset} />;
  return <StudentApp key={user.id} user={user} logout={logout} onProfile={setUser} onSignedOut={reset} />;
}

function Root() {
  const isAdmin = window.location.pathname === "/admin" || window.location.pathname.startsWith("/admin/");
  return isAdmin ? <AdminApp /> : <App />;
}
createRoot(document.getElementById("root")).render(<Root />);
