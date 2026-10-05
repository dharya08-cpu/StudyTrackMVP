import React, { useCallback, useEffect, useState } from "react";
import { api, json, setActiveClass, session } from "./api.js";
import { ErrorBox, Loading } from "./ui.jsx";
import { Layout, TeacherRoom } from "./dashboards.jsx";
import { JoinRequests } from "./requests.jsx";
import { InstituteHome, JoinInstituteView } from "./institute.jsx";
import { InstituteCreateFlow, INSTITUTE_INFO } from "./institute-create.jsx";

// Teacher home: header with a Menu button, a slide-in menu, and the current view.
export function TeacherShell({ user, logout, landing, replaceSession }) {
  const [ctx, setCtx] = useState(null);
  const [view, setView] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [studentsOpen, setStudentsOpen] = useState(true);
  const [infoOpen, setInfoOpen] = useState(false);
  const [error, setError] = useState("");

  const loadCtx = useCallback(async () => {
    try {
      const next = await api("/teacher/context");
      setCtx(next);
      setError("");
      return next;
    } catch (e) { setError(e.message); return null; }
  }, []);

  useEffect(() => {
    (async () => {
      const first = await loadCtx();
      if (!first) return;
      const usable = first.classes.find(c => !c.suspended) || first.classes[0];
      if (landing === "institute" && first.institute) setView({ name: "institute" });
      else if (usable) setView({ name: "room", classId: usable.id });
      else if (first.institute) setView({ name: "institute" });
      else setView({ name: "new-class" });
    })();
    return () => setActiveClass(null);
  }, []);

  // The selected class travels with every request.
  const roomClassId = view?.name === "room" ? view.classId : null;
  useEffect(() => { setActiveClass(roomClassId); }, [roomClassId]);

  const go = next => { setView(next); setMenuOpen(false); window.scrollTo?.(0, 0); };
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = e => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  if (!ctx || !view) {
    return error
      ? <Layout user={user} logout={logout}><ErrorBox error={error} /><button className="primary" onClick={loadCtx}>Try again</button></Layout>
      : <Loading />;
  }

  const currentClass = ctx.classes.find(c => c.id === roomClassId) || null;
  const inInstitute = Boolean(ctx.institute);

  const banner = ctx.read_only ? <div className="banner" role="status">Your institute is in read-only mode right now. You can view everything but changes are paused. Contact StudyTrack support.</div> : null;

  let content;
  if (view.name === "room") {
    content = currentClass
      ? <TeacherRoom key={currentClass.id} classInfo={currentClass} pending={ctx.pending_total} goRequests={() => go({ name: "requests" })} />
      : <section className="panel"><div className="empty">That class isn't available anymore.</div></section>;
  } else if (view.name === "requests") {
    content = <JoinRequests onChanged={loadCtx} />;
  } else if (view.name === "institute") {
    content = <InstituteHome
      onChanged={async info => { await loadCtx(); if (info?.left) go(ctx.classes[0] ? { name: "room", classId: ctx.classes[0].id } : { name: "new-class" }); }}
      onCreateAgain={() => go({ name: "create-institute" })}
      goClasses={ctx.classes.length ? () => go({ name: "room", classId: (ctx.classes.find(c => !c.suspended) || ctx.classes[0]).id }) : null} />;
  } else if (view.name === "new-class") {
    content = <NewClass first={ctx.classes.length === 0} onCreated={async cls => { await loadCtx(); go({ name: "room", classId: cls.id }); }} />;
  } else if (view.name === "join-institute") {
    content = <JoinInstituteView onJoined={async () => { await loadCtx(); go({ name: "institute" }); }} />;
  } else if (view.name === "create-institute") {
    content = <section className="panel narrow"><InstituteCreateFlow user={user} onCancel={() => go(ctx.classes[0] ? { name: "room", classId: ctx.classes[0].id } : { name: "new-class" })}
      onDone={async result => { session.set(result.token); replaceSession(result.user); await loadCtx(); go({ name: "institute" }); }} /></section>;
  }

  return (
    <Layout user={user} logout={logout} onMenu={() => setMenuOpen(true)} menuBadge={ctx.pending_total} banner={banner}>
      {error && <ErrorBox error={error} />}
      {content}
      {menuOpen && (
        <div className="drawer-backdrop" onClick={() => setMenuOpen(false)}>
          <nav className="drawer" aria-label="Teacher menu" onClick={e => e.stopPropagation()}>
            <div className="drawer-head">
              <div><b>{user.name}</b><small>{user.email}</small></div>
              <button className="secondary" onClick={() => setMenuOpen(false)} aria-label="Close menu">Close</button>
            </div>

            <button className={`drawer-item ${view.name === "room" ? "active" : ""}`} disabled={!ctx.classes.length} onClick={() => go({ name: "room", classId: (currentClass || ctx.classes.find(c => !c.suspended) || ctx.classes[0]).id })}>🏠 My classroom</button>

            <button className="drawer-item" aria-expanded={studentsOpen} onClick={() => setStudentsOpen(o => !o)}>
              <span>👥 Students</span>
              <span className="drawer-right">{ctx.pending_total > 0 && <span className="menu-badge">{ctx.pending_total}</span>}<span aria-hidden="true">{studentsOpen ? "▾" : "▸"}</span></span>
            </button>
            {studentsOpen && (
              <div className="drawer-sub">
                <button className={`drawer-item sub ${view.name === "requests" ? "active" : ""}`} onClick={() => go({ name: "requests" })}>
                  <span>Student Joining Request</span>{ctx.pending_total > 0 && <span className="menu-badge">{ctx.pending_total}</span>}
                </button>
                {ctx.classes.map(c => (
                  <button key={c.id} className={`drawer-item sub ${roomClassId === c.id ? "active" : ""}`} onClick={() => go({ name: "room", classId: c.id })}>
                    <span>{c.name}{c.suspended && <em className="tag-paused"> paused</em>}</span><small>{c.student_count}</small>
                  </button>
                ))}
                {ctx.classes.length === 0 && <small className="muted drawer-note">No classes yet.</small>}
              </div>
            )}

            <button className={`drawer-item ${view.name === "new-class" ? "active" : ""}`} onClick={() => go({ name: "new-class" })}>➕ Add a class</button>

            <div className="drawer-divider" />
            {inInstitute ? (
              <button className={`drawer-item ${view.name === "institute" ? "active" : ""}`} onClick={() => go({ name: "institute" })}>🏛️ {ctx.institute.name}</button>
            ) : (
              <>
                <div className="drawer-item-row">
                  <button className="drawer-item grow" onClick={() => go({ name: "create-institute" })}>+ Create Your Own Coaching Institute</button>
                  <button type="button" className="info-btn" aria-label="What is a coaching institute?" aria-expanded={infoOpen} onClick={() => setInfoOpen(o => !o)}>ⓘ</button>
                </div>
                {infoOpen && <p className="drawer-info" role="note">{INSTITUTE_INFO}</p>}
                <button className={`drawer-item ${view.name === "join-institute" ? "active" : ""}`} onClick={() => go({ name: "join-institute" })}>🔑 Join with an institute code</button>
              </>
            )}

            <div className="drawer-divider" />
            <button className="drawer-item" onClick={logout}>Logout</button>
          </nav>
        </div>
      )}
    </Layout>
  );
}

function NewClass({ first, onCreated }) {
  const [form, setForm] = useState({ name: "", code: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async e => {
    e.preventDefault(); setError(""); setBusy(true);
    try { onCreated(await api("/teacher/classes", { method: "POST", body: json(form) })); }
    catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <section className="panel narrow">
      <h1>{first ? "Create your first class" : "Add a class"}</h1>
      <p className="muted">Students use the class code to ask to join. Leave it blank and we'll generate one.</p>
      <form onSubmit={submit}>
        <input placeholder="Class name (e.g. Class 2 batch)" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} maxLength={100} required />
        <input placeholder="Class code (optional)" value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })} maxLength={12} pattern="[A-Za-z0-9]{4,12}|" title="4 to 12 letters or numbers" />
        <ErrorBox error={error} />
        <button className="primary" disabled={busy}>{busy ? "Creating…" : "Create class"}</button>
      </form>
    </section>
  );
}
