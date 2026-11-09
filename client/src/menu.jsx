import React, { useEffect, useRef, useState } from "react";

// ---- Theme: Auto (follows the phone), Light or Dark. Remembered in a plain cookie (no personal data in it). ----
const THEME_COOKIE = "st_theme";
export function readTheme() { const m = document.cookie.match(/(?:^|; )st_theme=(light|dark)\b/); return m ? m[1] : "auto"; }
export function applyTheme(mode, persist = true) {
  const root = document.documentElement;
  if (mode === "light" || mode === "dark") root.dataset.theme = mode; else delete root.dataset.theme;
  if (!persist) return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = mode === "auto" ? `${THEME_COOKIE}=; path=/; max-age=0; SameSite=Strict${secure}` : `${THEME_COOKIE}=${mode}; path=/; max-age=31536000; SameSite=Strict${secure}`;
}
export function ThemeSwitch() {
  const [mode, setMode] = useState(readTheme);
  const choose = m => { setMode(m); applyTheme(m); };
  return (
    <div>
      <div className="theme-label" id="theme-label">Appearance</div>
      <div className="theme-switch" role="group" aria-labelledby="theme-label">
        {[["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]].map(([id, text]) => <button key={id} type="button" aria-pressed={mode === id} onClick={() => choose(id)}>{text}</button>)}
      </div>
    </div>
  );
}

// ---- The slide-in menu used by both the student and the teacher app ----
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Drawer({ label, name, email, onClose, children, footer }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // the page behind the menu does not scroll
    ref.current?.querySelector(".drawer-item.active, .drawer-item")?.focus();
    const onKey = e => {
      if (e.key === "Escape") { closeRef.current?.(); return; }
      if (e.key !== "Tab" || !ref.current) return;
      const items = [...ref.current.querySelectorAll(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = overflow; previous?.focus?.(); };
  }, []);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <nav className="drawer" aria-label={label} ref={ref} onClick={e => e.stopPropagation()}>
        <div className="drawer-head"><div><b>{name}</b><small>{email}</small></div><button className="secondary small-btn" onClick={onClose} aria-label="Close menu">Close</button></div>
        <div className="drawer-body">{children}</div>
        <div className="drawer-foot">{footer}<ThemeSwitch /></div>
      </nav>
    </div>
  );
}

export const DrawerLabel = ({ children }) => <div className="drawer-label" role="presentation">{children}</div>;
export const DrawerDivider = () => <div className="drawer-divider" role="separator" />;

// icon: an emoji (decorative). badge: a number shown in red. sub: indented child row. expanded: makes it a toggle.
export function DrawerItem({ icon, children, active = false, badge = 0, onClick, sub = false, disabled = false, expanded, right = null }) {
  return (
    <button type="button" className={`drawer-item${sub ? " sub" : ""}${active ? " active" : ""}`} disabled={disabled} onClick={onClick} aria-current={active && expanded === undefined ? "page" : undefined} aria-expanded={expanded}>
      <span className="d-main">{icon && <span className="drawer-icon" aria-hidden="true">{icon}</span>}<span>{children}</span></span>
      <span className="drawer-right">{right}{badge > 0 && <span className="menu-badge" aria-label={`${badge} new`}>{badge}</span>}{expanded !== undefined && <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>}</span>
    </button>
  );
}
export const DrawerSub = ({ children }) => <div className="drawer-sub">{children}</div>;
