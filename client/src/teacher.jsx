import React, { useCallback, useEffect, useState } from "react";
import { api, json, setActiveClass } from "./api.js";
import { ErrorBox, Loading } from "./ui.jsx";
import { Layout } from "./layout.jsx";
import { TeacherRoom, ROOM_SECTIONS } from "./teacher-room.jsx";
import { Drawer, DrawerItem, DrawerLabel, DrawerDivider } from "./menu.jsx";
import { JoinRequests } from "./requests.jsx";
import { InstituteHome, JoinInstituteView } from "./institute.jsx";
import { InstituteCreateFlow, INSTITUTE_INFO } from "./institute-create.jsx";
import { useUnread, NotificationCenter } from "./notifications.jsx";
import { TeacherAnnouncements } from "./announcements.jsx";
import { CalendarView, ScheduleManager } from "./calendar.jsx";
import { SecurityPage } from "./security.jsx";

// Teacher home: header with a Menu button, a slide-in menu, and the current view.
export function TeacherShell({ user, logout, landing, onProfile, onSignedOut, flash = "" }) {
  const [ctx, setCtx] = useState(null);
  const [view, setView] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [error, setError] = useState("");
  const [calKey, setCalKey] = useState(0);
  const [unread, refreshUnread] = useUnread();

  const loadCtx = useCallback(async () => {
    try { const next = await api("/teacher/context"); setCtx(next); setError(""); return next; }
    catch (e) { setError(e.message); return null; }
  }, []);

  useEffect(() => {
    (async () => {
      const first = await loadCtx();
      if (!first) return;
      const usable = first.classes.find(c => !c.suspended) || first.classes[0];
      if (landing === "join-institute" && !first.institute) setView({ name: "join-institute" });
      else if (landing === "create-institute" && !first.institute) setView({ name: "create-institute" });
      else if (landing === "institute" && first.institute) setView({ name: "institute" });
      else if (usable) setView({ name: "room", classId: usable.id, tab: "overview" });
      else if (first.institute) setView({ name: "institute" });
      else setView({ name: "new-class" });
    })();
    return () => setActiveClass(null);
  }, []);

  // The selected class travels with every request.
  const roomClassId = view?.name === "room" ? view.classId : (view?.classId ?? null);
  useEffect(() => { setActiveClass(roomClassId); }, [roomClassId]);

  const go = next => { setView(next.name === "room" ? { tab: "overview", ...next } : next); setMenuOpen(false); window.scrollTo?.(0, 0); if (next.name === "notifications") refreshUnread(); };

  if (!ctx || !view) {
    return error ? <Layout user={user} logout={logout}><ErrorBox error={error} /><button className="primary" onClick={loadCtx}>Try again</button></Layout> : <Loading />;
  }

  const currentClass = ctx.classes.find(c => c.id === roomClassId) || ctx.classes.find(c => !c.suspended) || ctx.classes[0] || null;
  const inInstitute = Boolean(ctx.institute);
  const firstRoom = () => (ctx.classes[0] ? { name: "room", classId: (ctx.classes.find(c => !c.suspended) || ctx.classes[0]).id, tab: "overview" } : { name: "new-class" });
  const banner = ctx.read_only ? <div className="banner" role="status">Your institute is in read-only mode right now. You can view everything but changes are paused. Contact StudyTrack support.</div> : null;

  let content;
  if (view.name === "room") {
    const room = ctx.classes.find(c => c.id === view.classId);
    content = room
      ? <TeacherRoom key={room.id} classInfo={room} ctx={ctx} pending={ctx.pending_total} goRequests={() => go({ name: "requests" })} tab={view.tab || "overview"} setTab={tab => go({ name: "room", classId: room.id, tab })} />
      : <section className="panel"><div className="empty">That class isn't available anymore.</div></section>;
  } else if (view.name === "requests") content = <JoinRequests onChanged={loadCtx} />;
  else if (view.name === "institute") {
    content = <InstituteHome onChanged={async info => { await loadCtx(); if (info?.left) go(firstRoom()); }} onCreateAgain={() => go({ name: "create-institute" })} goClasses={ctx.classes.length ? () => go(firstRoom()) : null} />;
  } else if (view.name === "new-class") content = <NewClass first={ctx.classes.length === 0} onCreated={async cls => { await loadCtx(); go({ name: "room", classId: cls.id, tab: "overview" }); }} />;
  else if (view.name === "join-institute") content = <JoinInstituteView onJoined={async () => { await loadCtx(); go({ name: "institute" }); }} />;
  else if (view.name === "create-institute") content = <section className="panel narrow"><InstituteCreateFlow onCancel={() => go(firstRoom())} onDone={async () => { await loadCtx(); go({ name: "institute" }); }} /></section>;
  else if (view.name === "announcements") content = <TeacherAnnouncements ctx={ctx} currentClassId={currentClass?.id} />;
  else if (view.name === "calendar") {
    content = <>
      <CalendarView classes={ctx.classes} editable ctx={ctx} reloadKey={calKey} />
      {currentClass && <ScheduleManager key={currentClass.id} classInfo={currentClass} onChanged={() => setCalKey(k => k + 1)} />}
    </>;
  } else if (view.name === "notifications") content = <NotificationCenter onChanged={refreshUnread} />;
  else if (view.name === "security") content = <SecurityPage user={user} onSignedOut={onSignedOut} onProfile={onProfile} />;

  const inRoom = view.name === "room";
  const page = (name, icon, label, extra = {}) => <DrawerItem icon={icon} active={view.name === name} onClick={() => go({ name })} {...extra}>{label}</DrawerItem>;
  const menu = menuOpen && (
    <Drawer label="Teacher menu" name={user.name} email={user.email} onClose={() => setMenuOpen(false)}>
      <DrawerLabel>Class</DrawerLabel>
      {ctx.classes.length > 0 ? (
        <label className="drawer-class"><span className="sr-only">Choose class</span>
          <select value={currentClass?.id ?? ""} onChange={e => go({ name: "room", classId: Number(e.target.value), tab: inRoom ? view.tab : "overview" })} aria-label="Choose class">
            {ctx.classes.map(c => <option key={c.id} value={c.id}>{c.name} ({c.student_count}){c.suspended ? " · paused" : ""}</option>)}
          </select>
        </label>
      ) : <small className="muted drawer-note">No classes yet.</small>}
      {currentClass && ROOM_SECTIONS.map(([id, icon, label]) => <DrawerItem key={id} icon={icon} active={inRoom && (view.tab || "overview") === id} onClick={() => go({ name: "room", classId: currentClass.id, tab: id })}>{label}</DrawerItem>)}
      <DrawerLabel>Students</DrawerLabel>
      {page("requests", "📥", "Join requests", { badge: ctx.pending_total })}
      {page("new-class", "➕", "Add a class")}
      <DrawerLabel>School</DrawerLabel>
      {page("announcements", "📢", "Announcements")}
      {page("calendar", "📅", "Calendar & timetable")}
      {page("notifications", "🔔", "Notifications", { badge: unread })}
      <DrawerDivider />
      {inInstitute ? page("institute", "🏛️", ctx.institute.name) : (
        <>
          <div className="drawer-item-row"><DrawerItem icon="🏫" onClick={() => go({ name: "create-institute" })}>Create your own coaching institute</DrawerItem><button type="button" className="info-btn" aria-label="What is a coaching institute?" aria-expanded={infoOpen} onClick={() => setInfoOpen(o => !o)}>ⓘ</button></div>
          {infoOpen && <p className="drawer-info" role="note">{INSTITUTE_INFO}</p>}
          {page("join-institute", "🔑", "Join with an institute code")}
        </>
      )}
      {page("security", "🔒", "Security & privacy")}
    </Drawer>
  );
  return (
    <Layout user={user} logout={logout} onMenu={() => setMenuOpen(true)} menuBadge={ctx.pending_total + unread} banner={banner} unread={unread} onBell={() => go({ name: "notifications" })}>
      {flash && <div className="notice" role="status">{flash}</div>}
      {error && <ErrorBox error={error} />}
      {content}
      {menu}
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
      <p className="muted">Students use the class code to ask to join. A student can join several of your classes. Leave the code blank and we'll generate one.</p>
      <form onSubmit={submit}>
        <input placeholder="Class name (e.g. Physics Class 11)" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} maxLength={100} required />
        <input placeholder="Class code (optional)" value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })} maxLength={12} pattern="[A-Za-z0-9]{4,12}|" title="4 to 12 letters or numbers" />
        <ErrorBox error={error} />
        <button className="primary" disabled={busy}>{busy ? "Creating…" : "Create class"}</button>
      </form>
    </section>
  );
}
