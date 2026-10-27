import React from "react";
import { NotificationBell } from "./notifications.jsx";

export function Layout({ user, title, subtitle, children, logout, nav = [], tab, setTab, onMenu, menuBadge = 0, banner, unread = 0, onBell }) {
  const defaultSubtitle = user.role === "teacher" ? "Monitor your class and act on useful signals." : "Understand your study, tests and progress.";
  return (
    <div className="app">
      <header>
        <div className="header-left">
          {onMenu && <button className="menu-btn" onClick={onMenu} aria-label={menuBadge > 0 ? `Open menu, ${menuBadge} pending requests` : "Open menu"}><span className="burger" aria-hidden="true"><i /><i /><i /></span><span>Menu</span>{menuBadge > 0 && <span className="menu-badge" aria-hidden="true">{menuBadge}</span>}</button>}
          <div className="brand small">Study<span>Track</span></div>
        </div>
        <div className="userbar">
          {onBell && <NotificationBell unread={unread} onClick={onBell} />}
          <span className="pill">{user.role}</span><span className="hide-mobile">{user.name}</span><button onClick={logout}>Logout</button>
        </div>
      </header>
      {banner}
      <main className="container">
        {title && <div className="page-title"><h1>{title}</h1><p className="muted">{subtitle ?? defaultSubtitle}</p></div>}
        {nav.length > 0 && <div className="tabs" role="tablist">{nav.map(n => <button key={n} role="tab" aria-selected={tab === n} className={tab === n ? "tab active" : "tab"} onClick={() => setTab(n)}>{n}</button>)}</div>}
        {children}
      </main>
    </div>
  );
}
