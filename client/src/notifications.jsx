import React, { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { ErrorBox, Loading, timeAgo } from "./ui.jsx";

const ICONS = { announcement: "📢", homework: "📝", homework_submitted: "📥", homework_reviewed: "✅", test: "🧪", marks: "🧪", holiday: "📅", event: "🎉", join_request: "🙋", join_approved: "✅", join_denied: "⚠️", removed: "⚠️", student_left: "👋", institute_status: "🏛️", teacher_joined: "🎓" };
export const iconFor = n => (n.type === "announcement" && n.priority === "important" ? "❗" : ICONS[n.type] || "🔔");

// Polls the unread count (only while the tab is visible).
export function useUnread() {
  const [unread, setUnread] = useState(0);
  const refresh = useCallback(async () => { try { setUnread((await api("/notifications/unread-count")).unread); } catch { /* the bell must never break the app */ } }, []);
  useEffect(() => {
    refresh();
    const tick = () => { if (!document.hidden) refresh(); };
    const t = setInterval(tick, 30000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", tick); };
  }, [refresh]);
  return [unread, refresh];
}

export function NotificationBell({ unread, onClick }) {
  return (
    <button className="bell" onClick={onClick} aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
      <span aria-hidden="true">🔔</span>{unread > 0 && <span className="menu-badge" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
    </button>
  );
}

export function NotificationCenter({ onChanged }) {
  const [items, setItems] = useState(null);
  const [next, setNext] = useState(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (before = null, append = false) => {
    try {
      const q = new URLSearchParams({ limit: "30", ...(before ? { before } : {}), ...(unreadOnly ? { unread: "1" } : {}) });
      const d = await api(`/notifications?${q}`);
      setItems(prev => (append && prev ? [...prev, ...d.notifications] : d.notifications)); setNext(d.next); setError("");
    } catch (e) { setError(e.message); }
  }, [unreadOnly]);
  useEffect(() => { setItems(null); load(); }, [load]);

  const markRead = async n => { if (n.read_at) return; try { await api(`/notifications/${n.id}/read`, { method: "POST", body: "{}" }); setItems(list => list.map(x => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x))); onChanged?.(); } catch (e) { setError(e.message); } };
  const markAll = async () => { setBusy(true); try { await api("/notifications/read-all", { method: "POST", body: "{}" }); await load(); onChanged?.(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const remove = async n => { try { await api(`/notifications/${n.id}`, { method: "DELETE" }); setItems(list => list.filter(x => x.id !== n.id)); onChanged?.(); } catch (e) { setError(e.message); } };

  return (
    <>
      <div className="page-title"><h1>Notifications</h1><p className="muted">Announcements, homework, tests and class updates.</p></div>
      <section className="panel">
        <div className="panel-head">
          <div className="student-pills"><button className={!unreadOnly ? "active" : ""} onClick={() => setUnreadOnly(false)}>All</button><button className={unreadOnly ? "active" : ""} onClick={() => setUnreadOnly(true)}>Unread</button></div>
          <button className="secondary" disabled={busy} onClick={markAll}>Mark all as read</button>
        </div>
        <ErrorBox error={error} />
        {!items ? <Loading /> : items.length === 0 ? <div className="empty">{unreadOnly ? "You're all caught up." : "No notifications yet."}</div> : (
          <div className="list notif-list">
            {items.map(n => (
              <div key={n.id} className={`notif ${n.read_at ? "read" : "unread"} ${n.priority === "important" ? "important" : ""}`} onClick={() => markRead(n)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === "Enter") markRead(n); }}>
                <span className="notif-icon" aria-hidden="true">{iconFor(n)}</span>
                <div className="notif-body">
                  {n.priority === "important" && <span className="badge late">Important</span>}
                  <b>{n.title}</b>
                  {n.body && <p>{n.body}</p>}
                  <small>{timeAgo(n.created_at)}</small>
                </div>
                <button className="link notif-x" aria-label="Delete notification" onClick={e => { e.stopPropagation(); remove(n); }}>✕</button>
              </div>
            ))}
          </div>
        )}
        {next && <button className="secondary" onClick={() => load(next, true)}>Load older</button>}
      </section>
    </>
  );
}
