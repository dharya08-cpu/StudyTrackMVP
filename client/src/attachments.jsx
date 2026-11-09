import React, { useRef, useState } from "react";
import { api } from "./api.js";
import { formatBytes } from "./ui.jsx";

// Many files per homework or test. Every file has its own View / Download buttons, so the first file is never lost
// when more are attached (V5 and earlier kept one file per item and each new file replaced the last).

export const MAX_FILES_AT_ONCE = 5;
export const MAX_FILES_PER_ITEM = 10;
const MAX_UPLOAD_MB = 15;
const ALLOWED_EXT = ["pdf", "jpg", "jpeg", "png", "docx"];
export const FILE_ACCEPT = ".pdf,.jpg,.jpeg,.png,.docx";
export const FILES_HINT = `PDF, JPG, PNG or DOCX, up to ${MAX_UPLOAD_MB} MB each. You can pick several files.`;

// Quick check for a friendly message; the server re-checks the real file content.
export function checkFile(file) {
  if (!ALLOWED_EXT.includes(file.name.split(".").pop().toLowerCase())) return `${file.name}: only PDF, JPG, PNG and DOCX files can be uploaded.`;
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return `${file.name}: files must be ${MAX_UPLOAD_MB} MB or smaller.`;
  return "";
}
const fileKind = a => { const n = (a.name || "").toLowerCase(); return n.endsWith(".pdf") ? "pdf" : /\.(png|jpe?g)$/.test(n) ? "img" : "doc"; };
const extLabel = a => ({ pdf: "PDF", img: /\.png$/i.test(a.name) ? "PNG" : "JPG", doc: "DOCX" }[fileKind(a)]);

// Only http(s) links are ever opened, whatever the server sends.
function safeUrl(url) { try { const u = new URL(url, window.location.href); return u.protocol === "https:" || u.protocol === "http:" ? u.href : null; } catch { return null; } }

// Opens one file through a short-lived signed link. The tab is opened first, inside the tap, so phone browsers allow it.
async function openAttachment(id, disposition, base = "attachments") {
  const tab = window.open("", "_blank");
  if (tab) tab.opener = null;
  try {
    const result = await api(`/${base}/${id}?disposition=${disposition}`);
    const href = safeUrl(result.url);
    if (!href) throw new Error("The file link was not valid.");
    if (tab) tab.location.href = href; else window.location.assign(href);
  } catch (error) { tab?.close(); throw error; }
}

// The files of one homework or test. `onRemove` (teachers only) shows a Remove button on every file.
// `base` says where the files live: "attachments" (a teacher's files) or "submission-files" (files a student handed in).
export function AttachmentList({ items = [], onRemove = null, busyId = null, empty = null, base = "attachments" }) {
  const [opening, setOpening] = useState(null), [error, setError] = useState("");
  const open = async (a, disposition) => {
    setError(""); setOpening(`${a.id}:${disposition}`);
    try { await openAttachment(a.id, disposition, base); } catch (e) { setError(e.message || "Could not open the file."); } finally { setOpening(null); }
  };
  if (!items.length) return empty;
  return (
    <div className="file-list" role="list" aria-label="Attached files">
      {items.map(a => (
        <div className="file-row" role="listitem" key={a.id}>
          <span className={`file-ext ${fileKind(a)}`} aria-hidden="true">{extLabel(a)}</span>
          <div className="file-meta"><b>{a.name}</b><small>{formatBytes(a.size)}</small></div>
          <div className="file-actions">
            {a.viewable && <button type="button" className="secondary small-btn" disabled={opening === `${a.id}:inline`} onClick={e => { e.stopPropagation(); open(a, "inline"); }} aria-label={`View ${a.name}`}>{opening === `${a.id}:inline` ? "Opening…" : "View"}</button>}
            <button type="button" className="secondary small-btn" disabled={opening === `${a.id}:attachment`} onClick={e => { e.stopPropagation(); open(a, "attachment"); }} aria-label={`Download ${a.name}`}>{opening === `${a.id}:attachment` ? "Opening…" : "Download"}</button>
            {onRemove && <button type="button" className="danger-outline small-btn" disabled={busyId === a.id} onClick={e => { e.stopPropagation(); onRemove(a); }} aria-label={`Remove ${a.name}`}>{busyId === a.id ? "Removing…" : "Remove"}</button>}
          </div>
        </div>
      ))}
      {error && <small className="error-text" role="alert">{error}</small>}
    </div>
  );
}

// "Choose files" that ADDS to the list instead of replacing it, so teachers can pick files one at a time or all at once.
export function MultiFilePicker({ files, onChange, onError, max = MAX_FILES_AT_ONCE, label = "Attachments (optional)" }) {
  const ref = useRef(null);
  const sameFile = (a, b) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
  const add = list => {
    const merged = [...files];
    for (const f of list) if (!merged.some(x => sameFile(x, f))) merged.push(f);
    for (const f of merged) { const problem = checkFile(f); if (problem) { onError?.(problem); return; } }
    if (merged.length > max) { onError?.(`You can attach up to ${max} files at a time. Add more after posting.`); return; }
    onError?.(""); onChange(merged);
  };
  return (
    <div className="field-block">
      <label className="field">{label}
        <input ref={ref} type="file" multiple accept={FILE_ACCEPT} onChange={e => { add([...e.target.files]); e.target.value = ""; }} />
        <span className="hint-inline">{FILES_HINT}</span>
      </label>
      {files.length > 0 && (
        <div className="picked" aria-label="Files chosen">
          {files.map(f => <div className="picked-row" key={`${f.name}-${f.size}-${f.lastModified}`}><span>{f.name} <small className="muted">({formatBytes(f.size)})</small></span><button type="button" className="link" style={{ margin: 0 }} onClick={() => onChange(files.filter(x => x !== f))} aria-label={`Remove ${f.name} from the list`}>Remove</button></div>)}
        </div>
      )}
    </div>
  );
}

// Files already on a homework or test (or on a student's own submission), with "Add files" (several at once, each
// uploaded on its own) and "Remove". Teachers use the defaults; students pass the submission endpoints.
export function AttachManager({ kind, itemId, attachments = [], onChanged, onMessage, uploadPath = `/teacher/${kind}/${itemId}/attach`, removeBase = "/teacher/attachments", viewBase = "attachments", max = MAX_FILES_PER_ITEM, readOnly = false, title = "Files" }) {
  const [state, setState] = useState(null), [error, setError] = useState(""), [busyId, setBusyId] = useState(null);
  const ref = useRef(null);
  const room = max - attachments.length;

  const add = async list => {
    setError("");
    if (!list.length) return;
    if (list.length > room) { setError(room > 0 ? `There is room for ${room} more ${room === 1 ? "file" : "files"} (up to ${max} in total).` : `There are already ${max} files. Remove one first.`); return; }
    for (const f of list) { const problem = checkFile(f); if (problem) { setError(problem); return; } }
    const failed = []; let done = 0;
    for (let i = 0; i < list.length; i++) {
      setState({ at: i + 1, of: list.length });
      const body = new FormData(); body.append("file", list[i]);
      try { await api(uploadPath, { method: "POST", body }); done++; } catch (e) { failed.push(`${list[i].name}: ${e.message}`); }
    }
    setState(null);
    if (failed.length) setError(failed.join(" "));
    if (done) onMessage?.(done === 1 ? "File attached. Your earlier files are still there." : `${done} files attached. Your earlier files are still there.`);
    await onChanged?.();
  };
  const remove = async a => {
    if (!window.confirm(`Remove "${a.name}"?${viewBase === "attachments" ? " Students will no longer be able to open it." : ""}`)) return;
    setBusyId(a.id); setError("");
    try { await api(`${removeBase}/${a.id}`, { method: "DELETE" }); onMessage?.("File removed."); await onChanged?.(); } catch (e) { setError(e.message); } finally { setBusyId(null); }
  };
  return (
    <div onClick={e => e.stopPropagation()}>
      <div className="files-head">
        <b>{attachments.length ? `${title} (${attachments.length})` : "No files attached"}</b>
        {!readOnly && <label className={`secondary small-btn file-button${state || room <= 0 ? " disabled" : ""}`} aria-disabled={Boolean(state) || room <= 0}>
          {state ? `Uploading ${state.at} of ${state.of}…` : "+ Add files"}
          <input ref={ref} type="file" hidden multiple accept={FILE_ACCEPT} disabled={Boolean(state) || room <= 0} onChange={e => { const list = [...e.target.files]; e.target.value = ""; add(list); }} />
        </label>}
      </div>
      <AttachmentList items={attachments} onRemove={readOnly ? null : remove} busyId={busyId} base={viewBase} />
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  );
}
