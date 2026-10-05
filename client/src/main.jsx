import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { api, session, setActiveClass } from "./api.js";
import { Loading } from "./ui.jsx";
import { Auth } from "./auth.jsx";
import { TeacherShell } from "./teacher.jsx";
import { StudentGate } from "./student-gate.jsx";
import { AdminApp } from "./admin.jsx";

function BlockedScreen({ message, logout }) {
  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand">Study<span>Track</span></div>
        <h1>Access paused</h1>
        <p role="alert">{message}</p>
        <button className="primary" onClick={logout}>Back to login</button>
      </div>
    </main>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(Boolean(session.get()));
  const [blocked, setBlocked] = useState(null);
  const [landing, setLanding] = useState(null);
  const [role, setRole] = useState("student");
  const [mode, setMode] = useState("login");
  const [notice, setNotice] = useState("");

  const logout = useCallback(() => {
    session.clear();
    setUser(null); setBlocked(null); setLanding(null); setMode("login");
  }, []);

  useEffect(() => {
    if (!session.get()) return;
    api("/me").then(x => setUser(x.user)).catch(e => { if (e.status === 401) session.clear(); }).finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    const onBlocked = e => {
      const code = e.detail?.code;
      // A paused class only locks a teacher out of that one class, not the whole app.
      if (code === "CLASS_SUSPENDED" && user?.role === "teacher") return;
      setBlocked(e.detail?.message || "Access is paused. Please contact support.");
    };
    const onSignedOut = () => { session.clear(); setUser(null); setNotice("Your session ended. Please log in again."); };
    window.addEventListener("studytrack:blocked", onBlocked);
    window.addEventListener("studytrack:signed-out", onSignedOut);
    return () => { window.removeEventListener("studytrack:blocked", onBlocked); window.removeEventListener("studytrack:signed-out", onSignedOut); };
  }, [user?.role]);

  const handleLogin = data => {
    session.set(data.token);
    setActiveClass(null);
    setNotice("");
    setLanding(data.landing || null);
    setUser(data.user);
  };

  if (booting) return <Loading />;
  if (blocked) return <BlockedScreen message={blocked} logout={logout} />;
  if (!user) return <Auth role={role} setRole={setRole} mode={mode} setMode={setMode} onLogin={handleLogin} notice={notice} />;
  if (user.role === "teacher") return <TeacherShell key={user.id} user={user} logout={logout} landing={landing} replaceSession={setUser} />;
  return <StudentGate key={user.id} user={user} logout={logout} />;
}

function Root() {
  const isAdmin = window.location.pathname === "/admin" || window.location.pathname.startsWith("/admin/");
  return isAdmin ? <AdminApp /> : <App />;
}

createRoot(document.getElementById("root")).render(<Root />);
