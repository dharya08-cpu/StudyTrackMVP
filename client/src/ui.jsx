import React, { useEffect, useRef, useState } from "react";

export function localDateInput(){const parts=new Intl.DateTimeFormat("en-CA",{year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());const m=Object.fromEntries(parts.filter(p=>p.type!=="literal").map(p=>[p.type,p.value]));return `${m.year}-${m.month}-${m.day}`}
export function Stat({label,value,sub}){return <div className="stat"><span>{label}</span><strong>{value}</strong>{sub&&<small>{sub}</small>}</div>}
export function Card({title,meta,body,children}){return <div className="card"><b>{title}</b>{meta&&<small>{meta}</small>}{body&&<p>{body}</p>}{children}</div>}
export function List({items,render,empty="Nothing here yet."}){return items?.length?<div className="list">{items.map((x,i)=><React.Fragment key={x.id||i}>{render(x,i)}</React.Fragment>)}</div>:<div className="empty">{empty}</div>}
export function ErrorBox({error}){return error?<div className="error">{error}</div>:null}
export function Loading(){return <div className="loading">Loading StudyTrack…</div>}
export function MiniBars({items,labelKey="subject",valueKey="minutes"}){const max=Math.max(...items.map(x=>Number(x[valueKey]||0)),1);return <div className="bars">{items.map((x,i)=><div className="bar-row" key={i}><span>{x[labelKey]}</span><div><i style={{width:`${Math.max(3,Number(x[valueKey]||0)/max*100)}%`}}/></div><b>{Math.round(Number(x[valueKey]||0)/60*10)/10}h</b></div>)}</div>}
export function Trend({value}){return <span className={`trend ${value}`}>{value==="improving"?"↗ Improving":value==="declining"?"↘ Declining":value==="new"?"↗ New activity":"→ Stable"}</span>}
export function minutesToHours(m){return Number((Number(m||0)/60).toFixed(1))}
export function trend(current,previous){if(!previous)return current>0?"improving":"stable";const d=(current-previous)/previous*100;return d>5?"improving":d<-5?"declining":"stable"}

// ---------------------------------------------------------------------------
// Shared building blocks used by the newer screens
// ---------------------------------------------------------------------------

const modalStack = [];
export function Modal({ title, children, onClose, wide = false, labelledBy = "modal-title" }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const token = {};
    modalStack.push(token);
    // Escape closes only the top-most dialog.
    const onKey = e => { if (e.key === "Escape" && modalStack[modalStack.length - 1] === token) closeRef.current?.(); };
    document.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      const at = modalStack.indexOf(token);
      if (at >= 0) modalStack.splice(at, 1);
      previous?.focus?.();
    };
  }, []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={wide ? "modal wide" : "modal"} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1} ref={ref} onClick={e => e.stopPropagation()}>
        <div className="panel-head">
          <h3 id={labelledBy}>{title}</h3>
          <button className="secondary" onClick={onClose} aria-label="Close">Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function InfoTip({ children, label = "What is this?" }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="info-tip">
      <button type="button" className="info-btn" aria-label={label} aria-expanded={open} onClick={e => { e.stopPropagation(); setOpen(o => !o); }}>ⓘ</button>
      {open && <span className="info-pop" role="note">{children}</span>}
    </span>
  );
}

export function CopyChip({ value, label }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1600); }
    catch { setCopied(false); }
  };
  return <button type="button" className="code-chip" onClick={copy} title="Copy code" aria-label={`${label || "Code"} ${value}. Press to copy`}>{value}<span>{copied ? "Copied" : "Copy"}</span></button>;
}

export function Spinner({ text = "Loading…" }) { return <div className="loading" role="status">{text}</div>; }

export function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
export function formatDate(value) {
  if (!value) return "—";
  const d = new Date(String(value).replace(" ", "T") + (String(value).includes("T") || String(value).endsWith("Z") ? "" : "Z"));
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
