import React, { useCallback, useEffect, useState } from "react";
import { adminApi, setAdminCsrf, json } from "./api.js";
import { CopyChip, ErrorBox, Loading, Modal, formatBytes, formatDate, timeAgo } from "./ui.jsx";

const STATUS_CLASS = { pending: "in-progress", active: "completed", suspended: "late", banned: "late", rejected: "pending" };
const FILTERS = ["all", "pending", "active", "suspended", "banned", "rejected", "independent"];

export function AdminApp() {
  const [authed, setAuthed] = useState(null);   // null = checking the cookie session
  const [notice, setNotice] = useState("");
  useEffect(() => { adminApi("/admin/session").then(d => { setAdminCsrf(d.csrfToken); setAuthed(true); }).catch(() => setAuthed(false)); }, []);
  const signOut = useCallback((text = "") => { adminApi("/admin/logout", { method: "POST", body: "{}" }).catch(() => {}); setAdminCsrf(null); setNotice(text); setAuthed(false); }, []);
  if (authed === null) return <Loading />;
  if (!authed) return <AdminLogin notice={notice} onLogin={() => { setNotice(""); setAuthed(true); }} />;
  return <AdminPanel signOut={signOut} />;
}

function AdminLogin({ onLogin, notice }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async e => {
    e.preventDefault(); setError(""); setBusy(true);
    try { const d = await adminApi("/admin/login", { method: "POST", body: json({ key }) }); setAdminCsrf(d.csrfToken); onLogin(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand">Study<span>Track</span></div>
        <p className="muted">Owner admin</p>
        {notice && <div className="notice">{notice}</div>}
        <form onSubmit={submit}>
          <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder="Admin key" autoComplete="current-password" aria-label="Admin key" required />
          <ErrorBox error={error} />
          <button className="primary" disabled={busy}>{busy ? "Checking…" : "Open admin panel"}</button>
        </form>
        <a className="link-a" href="/">Back to StudyTrack</a>
      </div>
    </main>
  );
}

function useAdminData(path, signOut) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setData(await adminApi(path)); setError(""); }
    catch (e) { if (e.status === 401) signOut("Your admin session ended. Sign in again."); else setError(e.message); }
  }, [path, signOut]);
  useEffect(() => { load(); }, [load]);
  return { data, error, load };
}

function AdminPanel({ signOut }) {
  const [tab, setTab] = useState("overview");
  const [openId, setOpenId] = useState(null);
  const [version, setVersion] = useState(0);
  const refreshAll = () => setVersion(v => v + 1);
  const tabs = ["overview", "institutes", "classes", "teachers", "demo", "backups", "security", "activity"];
  return (
    <div className="app">
      <header>
        <div className="brand small">Study<span>Track</span></div>
        <div className="userbar"><span className="pill">Owner admin</span><button onClick={() => signOut()}>Sign out</button></div>
      </header>
      <main className="container">
        <div className="tabs" role="tablist">{tabs.map(t => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>{t}</button>)}</div>
        {tab === "overview" && <Overview key={version} signOut={signOut} openInstitute={setOpenId} goInstitutes={() => setTab("institutes")} />}
        {tab === "institutes" && <Institutes key={version} signOut={signOut} openInstitute={setOpenId} />}
        {tab === "classes" && <Classes key={version} signOut={signOut} />}
        {tab === "teachers" && <Teachers key={version} signOut={signOut} />}
        {tab === "demo" && <Demo key={version} signOut={signOut} />}
        {tab === "backups" && <Backups key={version} signOut={signOut} />}
        {tab === "security" && <SecurityEvents key={version} signOut={signOut} />}
        {tab === "activity" && <Activity key={version} signOut={signOut} />}
      </main>
      {openId && <InstituteDetail id={openId} signOut={signOut} onClose={() => setOpenId(null)} onChanged={refreshAll} />}
    </div>
  );
}

function Overview({ signOut, openInstitute, goInstitutes }) {
  const ov = useAdminData("/admin/overview", signOut);
  const list = useAdminData("/admin/institutes", signOut);
  if (!ov.data || !list.data) return ov.error || list.error ? <ErrorBox error={ov.error || list.error} /> : <Loading />;
  const o = ov.data;
  const pending = list.data.institutes.filter(i => i.status === "pending");
  return (
    <>
      <div className="grid four">
        <Stat2 label="Institutes" value={o.institutes.total} sub={`${o.institutes.active} active`} />
        <Stat2 label="Waiting for approval" value={o.institutes.pending} sub={o.institutes.pending ? "Needs your review" : "All clear"} />
        <Stat2 label="Suspended / banned" value={`${o.institutes.suspended} / ${o.institutes.banned}`} sub={`${o.institutes.independent} independent`} />
        <Stat2 label="Teachers / students" value={`${o.teachers} / ${o.students}`} sub={`${o.classes} classes${o.suspended_classes ? `, ${o.suspended_classes} paused` : ""}`} />
      </div>
      <div className="grid four">
        <Stat2 label="File storage used" value={formatBytes(o.storage_bytes)} sub="Homework and test attachments" />
        <Stat2 label="Signed-in sessions" value={o.active_sessions} sub="Across all devices" />
        <Stat2 label="Database size" value={formatBytes(o.database_bytes)} sub="PostgreSQL database" />
      </div>
      <section className="panel">
        <div className="panel-head"><h2>Approval queue</h2><button className="secondary" onClick={goInstitutes}>All institutes</button></div>
        {pending.length === 0 ? <div className="empty">No institutes are waiting for approval.</div> : (
          <div className="list">{pending.map(i => (
            <div className="item clickable" key={i.id} onClick={() => openInstitute(i.id)}>
              <div><b>{i.name}</b><small>Code {i.code} • {i.head_name} ({i.head_email}) • {formatDate(i.created_at)}</small></div>
              <button className="primary small-btn" onClick={e => { e.stopPropagation(); openInstitute(i.id); }}>Review</button>
            </div>))}</div>
        )}
      </section>
    </>
  );
}
const Stat2 = ({ label, value, sub }) => <div className="stat"><span>{label}</span><strong>{value}</strong>{sub && <small>{sub}</small>}</div>;

function Institutes({ signOut, openInstitute }) {
  const { data, error } = useAdminData("/admin/institutes", signOut);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  const q = query.trim().toLowerCase();
  const rows = data.institutes.filter(i => (filter === "all" || (filter === "independent" ? i.control_mode === "independent" : i.status === filter)) && (!q || `${i.name} ${i.code} ${i.head_email} ${i.head_name}`.toLowerCase().includes(q)));
  return (
    <section className="panel">
      <div className="panel-head"><h2>Coaching institutes</h2></div>
      <div className="student-pills">{FILTERS.map(f => <button key={f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>{f}</button>)}</div>
      <input className="search" placeholder="Search name, code or head email" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search institutes" />
      {rows.length === 0 ? <div className="empty">No institutes match.</div> : (
        <div className="table-wrap"><table><thead><tr><th>Institute</th><th>Code</th><th>Head</th><th>Status</th><th>Teachers</th><th>Students</th><th>Created</th></tr></thead>
          <tbody>{rows.map(i => (
            <tr key={i.id} onClick={() => openInstitute(i.id)} tabIndex={0} onKeyDown={e => { if (e.key === "Enter") openInstitute(i.id); }}>
              <td><b>{i.name}</b></td><td><code>{i.code}</code></td><td>{i.head_name}<small>{i.head_email}</small></td>
              <td><span className={`badge ${STATUS_CLASS[i.status]}`}>{i.status}</span>{i.control_mode === "independent" && <span className="badge independent">independent</span>}</td>
              <td>{i.usage.teachers}{i.max_teachers != null ? ` / ${i.max_teachers}` : ""}</td><td>{i.usage.students}{i.max_students != null ? ` / ${i.max_students}` : ""}</td><td>{formatDate(i.created_at)}</td>
            </tr>))}</tbody></table></div>
      )}
    </section>
  );
}

// A small confirmation dialog that can also ask for a reason or a typed word.
function ActionDialog({ title, children, confirmLabel, danger, askReason, typeToConfirm, onConfirm, onClose }) {
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = !typeToConfirm || typed === typeToConfirm;
  const run = async () => {
    setBusy(true); setError("");
    try { await onConfirm(reason.trim()); onClose(); } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} labelledBy="dialog-title">
      {children}
      {askReason && <label className="field">Reason (optional, shown to the institute head)<input value={reason} onChange={e => setReason(e.target.value)} maxLength={300} /></label>}
      {typeToConfirm && <label className="field">Type <b>{typeToConfirm}</b> to confirm<input value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" /></label>}
      <ErrorBox error={error} />
      <div className="modal-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className={danger ? "danger-solid" : "primary"} disabled={busy || !ready} onClick={run}>{busy ? "Working…" : confirmLabel}</button></div>
    </Modal>
  );
}

function InstituteDetail({ id, signOut, onClose, onChanged }) {
  const { data, error, load } = useAdminData(`/admin/institutes/${id}`, signOut);
  const [dialog, setDialog] = useState(null);
  const [limits, setLimits] = useState(null);
  const [note, setNote] = useState(null);
  const [message, setMessage] = useState("");
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    if (data && limits === null) {
      const i = data.institute;
      setLimits({ max_teachers: i.max_teachers ?? "", max_students: i.max_students ?? "", storage_limit_mb: i.storage_limit_mb ?? "", read_only: Boolean(i.read_only) });
      setNote(i.admin_note || "");
    }
  }, [data]);

  const run = async (fn, text) => {
    setActionError(""); setMessage("");
    try { await fn(); setMessage(text); setLimits(null); await load(); onChanged(); }
    catch (e) { if (e.status === 401) signOut("Your admin session ended. Sign in again."); else setActionError(e.message); }
  };

  if (!data) return <Modal title="Institute" onClose={onClose} wide>{error ? <ErrorBox error={error} /> : <Loading />}</Modal>;
  const inst = data.institute;
  const independent = inst.control_mode === "independent";
  const status = (action, reason) => adminApi(`/admin/institutes/${id}/status`, { method: "POST", body: json({ action, reason }) });
  const u = inst.usage;
  const storageLimit = inst.storage_limit_mb != null ? ` / ${inst.storage_limit_mb} MB` : "";

  return (
    <Modal title={inst.name} onClose={onClose} wide>
      <p><span className={`badge ${STATUS_CLASS[inst.status]}`}>{inst.status}</span>{independent && <span className="badge independent">independent</span>}</p>
      {message && <p className="success" role="status">{message}</p>}
      <ErrorBox error={actionError} />

      <div className="detail-grid">
        <div><small>Coaching code</small><CopyChip value={inst.code} label="Coaching code" /></div>
        <div><small>Head</small><b>{inst.head_name || "—"}</b><span>{inst.head_email}</span></div>
        <div><small>Phone / city</small><b>{inst.contact_phone || "—"}</b><span>{inst.city || "—"}</span></div>
        <div><small>Expected size</small><b>{inst.expected_teachers ?? "—"} teachers</b><span>{inst.expected_students ?? "—"} students</span></div>
        <div><small>Requested</small><b>{formatDate(inst.created_at)}</b><span>Approved {formatDate(inst.approved_at)}</span></div>
      </div>
      {inst.description && <p className="muted">{inst.description}</p>}
      {inst.status_reason && <p className="warning-text">Reason on file: {inst.status_reason}</p>}

      <h3>Usage</h3>
      <div className="grid four usage-grid">
        <Stat2 label="Teachers" value={`${u.teachers}${inst.max_teachers != null ? ` / ${inst.max_teachers}` : ""}`} />
        <Stat2 label="Students" value={`${u.students}${inst.max_students != null ? ` / ${inst.max_students}` : ""}`} />
        <Stat2 label="Classes" value={u.classes} />
        <Stat2 label="Records stored" value={u.records} sub="study, marks, attendance, homework" />
        <Stat2 label="File storage" value={`${formatBytes(u.storage_bytes)}${storageLimit}`} />
      </div>

      {independent ? (
        <div className="callout">This institute is independent. Suspension, bans, limits and read-only mode no longer apply, and this panel can't change or delete it until you return it to managed control.</div>
      ) : null}

      <h3>Status</h3>
      <div className="action-row">
        {inst.status === "pending" && <>
          <button className="allow-btn" onClick={() => setDialog({ type: "approve" })}>Approve</button>
          <button className="deny-btn" onClick={() => setDialog({ type: "reject" })}>Reject</button></>}
        {inst.status === "active" && <>
          <button className="secondary" disabled={independent} onClick={() => setDialog({ type: "suspend" })}>Suspend</button>
          <button className="danger-outline" disabled={independent} onClick={() => setDialog({ type: "ban" })}>Ban</button></>}
        {inst.status === "suspended" && <>
          <button className="allow-btn" onClick={() => setDialog({ type: "reactivate" })}>Reactivate</button>
          <button className="danger-outline" onClick={() => setDialog({ type: "ban" })}>Ban</button></>}
        {inst.status === "banned" && <button className="allow-btn" onClick={() => setDialog({ type: "unban" })}>Unban</button>}
        {inst.status === "rejected" && <small className="muted">Rejected. The head can submit again.</small>}
      </div>

      {!independent && limits && (
        <>
          <h3>Limits and access</h3>
          <form className="form-grid" onSubmit={e => { e.preventDefault(); run(() => adminApi(`/admin/institutes/${id}/limits`, { method: "PATCH", body: json({ max_teachers: limits.max_teachers === "" ? null : Number(limits.max_teachers), max_students: limits.max_students === "" ? null : Number(limits.max_students), storage_limit_mb: limits.storage_limit_mb === "" ? null : Number(limits.storage_limit_mb), read_only: limits.read_only }) }), "Limits saved."); }}>
            <label className="field">Max teachers<input type="number" min="1" placeholder="Unlimited" value={limits.max_teachers} onChange={e => setLimits({ ...limits, max_teachers: e.target.value })} /></label>
            <label className="field">Max students<input type="number" min="1" placeholder="Unlimited" value={limits.max_students} onChange={e => setLimits({ ...limits, max_students: e.target.value })} /></label>
            <label className="field">Storage limit (MB)<input type="number" min="1" placeholder="Unlimited" value={limits.storage_limit_mb} onChange={e => setLimits({ ...limits, storage_limit_mb: e.target.value })} /></label>
            <label className="check"><input type="checkbox" checked={limits.read_only} onChange={e => setLimits({ ...limits, read_only: e.target.checked })} /> Read-only mode (everyone can view, nobody can change anything)</label>
            <button className="primary">Save limits</button>
          </form>
        </>
      )}

      <h3>Control</h3>
      {independent ? (
        <div className="action-row"><button className="secondary" onClick={() => setDialog({ type: "managed" })}>Return to managed control</button></div>
      ) : (
        <div className="action-row">
          <button className="secondary" disabled={inst.status !== "active"} onClick={() => setDialog({ type: "independent" })}>Make independent (after payment)</button>
          {inst.status !== "active" && <small className="muted">Only an active institute can be made independent.</small>}
        </div>
      )}

      <h3>Teachers and classes</h3>
      {data.teachers.length === 0 ? <div className="empty">No teachers.</div> : (
        <div className="list">{data.teachers.map(t => (
          <div className="item col" key={t.id}>
            <div><b>{t.name}</b> <span className={`role-chip ${t.institute_role || "teacher"}`}>{t.institute_role || "teacher"}</span>{t.banned && <span className="badge late">banned</span>}<small>{t.email}</small></div>
            <div className="class-rows">{t.classes.length === 0 ? <small className="muted">No classes</small> : t.classes.map(c => <div className="class-row" key={c.id}><span>{c.name}{c.suspended && <em className="tag-paused"> paused</em>}</span><span>{c.student_count} students • <code>{c.code}</code></span></div>)}</div>
          </div>))}</div>
      )}

      <h3>Private note</h3>
      <textarea value={note ?? ""} onChange={e => setNote(e.target.value)} maxLength={1000} placeholder="Payment status, agreement, anything you want to remember. Only you see this." aria-label="Private note" />
      <div className="action-row"><button className="secondary" onClick={() => run(() => adminApi(`/admin/institutes/${id}/note`, { method: "PATCH", body: json({ note }) }), "Note saved.")}>Save note</button></div>

      <h3>Delete</h3>
      <div className="action-row">
        <button className="danger-outline" disabled={independent} onClick={() => setDialog({ type: "delete" })}>Delete institute only</button>
        <button className="danger-solid" disabled={independent} onClick={() => setDialog({ type: "delete-data" })}>Delete institute and all its data</button>
      </div>

      {dialog?.type === "approve" && <ActionDialog title="Approve this institute?" confirmLabel="Approve" onClose={() => setDialog(null)} onConfirm={() => run(() => status("approve"), "Approved. Teachers can now join with the code.")}><p>The head gets full access and teachers can join with code <b>{inst.code}</b>.</p></ActionDialog>}
      {dialog?.type === "reject" && <ActionDialog title="Reject this request?" confirmLabel="Reject" danger askReason onClose={() => setDialog(null)} onConfirm={reason => run(() => status("reject", reason), "Request rejected.")}><p>The head will see the request wasn't approved, and can submit again.</p></ActionDialog>}
      {dialog?.type === "suspend" && <ActionDialog title="Suspend this institute?" confirmLabel="Suspend" danger askReason onClose={() => setDialog(null)} onConfirm={reason => run(() => status("suspend", reason), "Suspended. Nobody in this institute can use StudyTrack.")}><p>All teachers and students of <b>{inst.name}</b> are locked out immediately. Their data stays safe. You can reactivate any time.</p></ActionDialog>}
      {dialog?.type === "reactivate" && <ActionDialog title="Reactivate this institute?" confirmLabel="Reactivate" onClose={() => setDialog(null)} onConfirm={() => run(() => status("reactivate"), "Reactivated.")}><p>Access is restored right away.</p></ActionDialog>}
      {dialog?.type === "ban" && <ActionDialog title="Ban this institute?" confirmLabel="Ban institute" danger askReason onClose={() => setDialog(null)} onConfirm={reason => run(() => status("ban", reason), "Banned.")}><p>Same lock-out as a suspension, marked as a ban. You can unban later.</p></ActionDialog>}
      {dialog?.type === "unban" && <ActionDialog title="Unban this institute?" confirmLabel="Unban" onClose={() => setDialog(null)} onConfirm={() => run(() => status("unban"), "Unbanned.")}><p>The institute becomes active again.</p></ActionDialog>}
      {dialog?.type === "independent" && <ActionDialog title="Make this institute independent?" confirmLabel="Make independent" typeToConfirm="INDEPENDENT" onClose={() => setDialog(null)} onConfirm={() => run(() => adminApi(`/admin/institutes/${id}/control`, { method: "PATCH", body: json({ mode: "independent" }) }), "Institute is now independent.")}><p>Use this after payment. Every limit, pause and read-only setting is cleared. This panel can no longer suspend, ban, limit or delete this institute unless you return it to managed control.</p></ActionDialog>}
      {dialog?.type === "managed" && <ActionDialog title="Return to managed control?" confirmLabel="Return to managed" onClose={() => setDialog(null)} onConfirm={() => run(() => adminApi(`/admin/institutes/${id}/control`, { method: "PATCH", body: json({ mode: "managed" }) }), "Back under your control.")}><p>You'll be able to suspend, limit and delete this institute again.</p></ActionDialog>}
      {dialog?.type === "delete" && <ActionDialog title="Delete institute only?" confirmLabel="Delete institute" danger typeToConfirm="DELETE" onClose={() => setDialog(null)} onConfirm={async () => { await adminApi(`/admin/institutes/${id}`, { method: "DELETE" }); onChanged(); onClose(); }}><p>The institute and its code are removed. Its teachers keep their accounts, classes and student data as independent teachers.</p></ActionDialog>}
      {dialog?.type === "delete-data" && <ActionDialog title="Delete everything?" confirmLabel="Delete institute and data" danger typeToConfirm="DELETE ALL" onClose={() => setDialog(null)} onConfirm={async () => { await adminApi(`/admin/institutes/${id}?withData=true`, { method: "DELETE" }); onChanged(); onClose(); }}><p className="warning-text">This permanently deletes the institute, all of its teacher accounts, their classes, homework, tests and uploaded files. Students stay registered but lose these classes. This can't be undone.</p></ActionDialog>}
    </Modal>
  );
}

function Classes({ signOut }) {
  const { data, error, load } = useAdminData("/admin/classes", signOut);
  const [dialog, setDialog] = useState(null);
  const [actionError, setActionError] = useState("");
  const [query, setQuery] = useState("");
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  const q = query.trim().toLowerCase();
  const rows = data.classes.filter(c => !q || `${c.name} ${c.code} ${c.teacher_name} ${c.teacher_email} ${c.institute_name || ""}`.toLowerCase().includes(q));
  const guard = async fn => { setActionError(""); try { await fn(); await load(); } catch (e) { if (e.status === 401) signOut("Your admin session ended. Sign in again."); else { setActionError(e.message); throw e; } } };
  return (
    <section className="panel">
      <div className="panel-head"><h2>All classes and class codes</h2></div>
      <input className="search" placeholder="Search class, code, teacher or institute" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search classes" />
      <ErrorBox error={actionError} />
      {rows.length === 0 ? <div className="empty">No classes yet.</div> : (
        <div className="table-wrap"><table><thead><tr><th>Class</th><th>Code</th><th>Teacher</th><th>Institute</th><th>Students</th><th>Storage</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{rows.map(c => (
            <tr key={c.id}>
              <td><b>{c.name}</b></td><td><code>{c.code}</code></td><td>{c.teacher_name}<small>{c.teacher_email}</small></td>
              <td>{c.institute_name ? <>{c.institute_name}{c.control_mode === "independent" && <small>independent</small>}</> : <small>Independent teacher</small>}</td>
              <td>{c.student_count}</td><td>{formatBytes(c.storage_bytes)}</td>
              <td><span className={`badge ${c.suspended ? "late" : "completed"}`}>{c.suspended ? "suspended" : "active"}</span></td>
              <td className="row-actions">
                {c.control_mode === "independent" ? <small>Not controlled</small> : <>
                  {c.suspended ? <button className="secondary small-btn" onClick={() => setDialog({ type: "reactivate", c })}>Reactivate</button> : <button className="secondary small-btn" onClick={() => setDialog({ type: "suspend", c })}>Suspend</button>}
                  <button className="danger-outline small-btn" onClick={() => setDialog({ type: "delete", c })}>Delete</button></>}
              </td>
            </tr>))}</tbody></table></div>
      )}
      {dialog?.type === "suspend" && <ActionDialog title={`Suspend ${dialog.c.name}?`} confirmLabel="Suspend class" danger askReason onClose={() => setDialog(null)} onConfirm={reason => guard(() => adminApi(`/admin/classes/${dialog.c.id}/status`, { method: "POST", body: json({ action: "suspend", reason }) }))}><p>Its teacher and students are locked out of this class right away.</p></ActionDialog>}
      {dialog?.type === "reactivate" && <ActionDialog title={`Reactivate ${dialog.c.name}?`} confirmLabel="Reactivate" onClose={() => setDialog(null)} onConfirm={() => guard(() => adminApi(`/admin/classes/${dialog.c.id}/status`, { method: "POST", body: json({ action: "reactivate" }) }))}><p>Access returns right away.</p></ActionDialog>}
      {dialog?.type === "delete" && <ActionDialog title={`Delete ${dialog.c.name}?`} confirmLabel="Delete class" danger typeToConfirm="DELETE" onClose={() => setDialog(null)} onConfirm={() => guard(() => adminApi(`/admin/classes/${dialog.c.id}`, { method: "DELETE" }))}><p className="warning-text">Deletes the class with its homework, tests, marks, attendance and syllabus, and removes its uploaded files. Students stay registered without a class.</p></ActionDialog>}
    </section>
  );
}

function Teachers({ signOut }) {
  const { data, error, load } = useAdminData("/admin/teachers", signOut);
  const [dialog, setDialog] = useState(null);
  const [actionError, setActionError] = useState("");
  const [query, setQuery] = useState("");
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  const q = query.trim().toLowerCase();
  const rows = data.teachers.filter(t => !q || `${t.name} ${t.email} ${t.institute_name || ""}`.toLowerCase().includes(q));
  const guard = async fn => { setActionError(""); try { await fn(); await load(); } catch (e) { if (e.status === 401) signOut("Your admin session ended. Sign in again."); else { setActionError(e.message); throw e; } } };
  return (
    <section className="panel">
      <div className="panel-head"><h2>All teachers</h2></div>
      <input className="search" placeholder="Search name, email or institute" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search teachers" />
      <ErrorBox error={actionError} />
      {rows.length === 0 ? <div className="empty">No teachers yet.</div> : (
        <div className="table-wrap"><table><thead><tr><th>Teacher</th><th>Institute</th><th>Classes</th><th>Students</th><th>Joined</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{rows.map(t => (
            <tr key={t.id}>
              <td><b>{t.name}</b><small>{t.email}</small></td><td>{t.institute_name ? <>{t.institute_name}<small>{t.institute_role}</small></> : <small>Independent</small>}</td>
              <td>{t.class_count}</td><td>{t.student_count}</td><td>{formatDate(t.created_at)}</td>
              <td><span className={`badge ${t.banned ? "late" : "completed"}`}>{t.banned ? "banned" : "active"}</span></td>
              <td className="row-actions">{t.control_mode === "independent" ? <small>Not controlled</small> : <button className={t.banned ? "secondary small-btn" : "danger-outline small-btn"} onClick={() => setDialog({ t })}>{t.banned ? "Unban" : "Ban"}</button>}</td>
            </tr>))}</tbody></table></div>
      )}
      {dialog && <ActionDialog title={`${dialog.t.banned ? "Unban" : "Ban"} ${dialog.t.name}?`} confirmLabel={dialog.t.banned ? "Unban" : "Ban teacher"} danger={!dialog.t.banned} askReason={!dialog.t.banned} onClose={() => setDialog(null)} onConfirm={reason => guard(() => adminApi(`/admin/teachers/${dialog.t.id}/status`, { method: "POST", body: json({ action: dialog.t.banned ? "unban" : "ban", reason }) }))}><p>{dialog.t.banned ? "They can sign in again." : "They are signed out immediately and can't log in. Students in their classes lose access until you unban them."}</p></ActionDialog>}
    </section>
  );
}

function Activity({ signOut }) {
  const { data, error } = useAdminData("/admin/log", signOut);
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  return (
    <section className="panel">
      <div className="panel-head"><h2>Recent admin actions</h2></div>
      {data.log.length === 0 ? <div className="empty">Nothing has been done yet.</div> : (
        <div className="table-wrap"><table><thead><tr><th>When</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
          <tbody>{data.log.map(l => <tr key={l.id}><td>{formatDate(l.created_at)}</td><td><span className="badge">{l.action}</span></td><td>{l.target_type}: {l.target_label}</td><td>{l.detail}</td></tr>)}</tbody></table></div>
      )}
    </section>
  );
}


function Backups({ signOut }) {
  const { data, error, load } = useAdminData("/admin/backups", signOut);
  const [busy, setBusy] = useState(""), [message, setMessage] = useState(""), [actionError, setActionError] = useState("");
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  const act = async (key, fn, text) => {
    setBusy(key); setMessage(""); setActionError("");
    try { const r = await fn(); if (r.ok === false) setActionError(r.error || "That did not work."); else setMessage(text(r)); await load(); }
    catch (e) { if (e.status === 401) signOut("Your admin session ended. Sign in again."); else setActionError(e.message); }
    finally { setBusy(""); }
  };
  const badge = r => r.status === "ok" ? "completed" : r.status === "failed" ? "late" : "in-progress";
  const verifyBadge = r => r.verify_status === "ok" ? "completed" : r.verify_status === "failed" ? "late" : "pending";
  return (
    <>
      <div className="grid four">
        <Stat2 label="Automatic backups" value={data.enabled ? "On" : "Off"} sub={data.enabled ? "Daily + weekly" : "Set BACKUP_ENABLED=true and configure Supabase"} />
        <Stat2 label="Last daily backup" value={data.last_daily ? timeAgo(data.last_daily) : "Never"} />
        <Stat2 label="Last weekly backup" value={data.last_weekly ? timeAgo(data.last_weekly) : "Never"} />
        <Stat2 label="Last restore test passed" value={data.last_verified ? timeAgo(data.last_verified) : "Never"} sub={data.last_verified ? "Backups are proven restorable" : "A backup that was never restored is not trustworthy"} />
      </div>
      {data.stale && <p className="warning-text">No successful backup in the last 36 hours. Run one now and check the server logs.</p>}
      <section className="panel">
        <div className="panel-head"><div><h2>Backups</h2><p className="muted">Daily and weekly snapshots are stored in a private Supabase bucket. Each weekly backup is automatically test-restored.</p></div>
          <button className="primary" disabled={Boolean(busy)} onClick={() => act("run", () => adminApi("/admin/backups/run", { method: "POST", body: "{}" }), r => `Backup #${r.id} created (${formatBytes(r.size_bytes)}).`)}>{busy === "run" ? "Backing up…" : "Back up now"}</button></div>
        {message && <p className="success" role="status">{message}</p>}<ErrorBox error={actionError} />
        {data.runs.length === 0 ? <div className="empty">No backups yet.</div> : (
          <div className="table-wrap"><table><thead><tr><th>#</th><th>Type</th><th>When</th><th>Size</th><th>Status</th><th>Restore test</th><th /></tr></thead>
            <tbody>{data.runs.map(r => (
              <tr key={r.id} className="static-row">
                <td>{r.id}</td><td>{r.kind}</td><td>{formatDate(r.started_at)}</td><td>{r.size_bytes ? formatBytes(r.size_bytes) : "—"}</td>
                <td><span className={`badge ${badge(r)}`}>{r.status}</span>{r.error && <small>{r.error}</small>}</td>
                <td><span className={`badge ${verifyBadge(r)}`}>{r.verify_status}</span>{r.verified_at && <small>{formatDate(r.verified_at)}</small>}{r.verify_status === "failed" && <small>{r.verify_detail}</small>}</td>
                <td>{r.status === "ok" && <button className="secondary small-btn" disabled={Boolean(busy)} onClick={() => act(`v${r.id}`, () => adminApi(`/admin/backups/${r.id}/verify`, { method: "POST", body: "{}" }), x => `Backup #${r.id} was restored into a temporary schema and matched (${x.total_rows} rows). Nothing live was touched.`)}>{busy === `v${r.id}` ? "Testing…" : "Test restore"}</button>}</td>
              </tr>))}</tbody></table></div>
        )}
      </section>
      <section className="panel"><h2>Recovery</h2><p className="muted">To restore after a disaster, follow <b>docs/RECOVERY.md</b> in the repository: create a fresh Supabase project, run <code>npm run restore -- --id N --target-url ... --confirm</code> and point DATABASE_URL at it.</p></section>
    </>
  );
}

function SecurityEvents({ signOut }) {
  const { data, error } = useAdminData("/admin/security-events", signOut);
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  return (
    <section className="panel">
      <div className="panel-head"><div><h2>Security events</h2><p className="muted">Failed sign-ins, rejected uploads, session changes. Network addresses are masked.</p></div></div>
      {data.events.length === 0 ? <div className="empty">Nothing to report.</div> : (
        <div className="table-wrap"><table><thead><tr><th>When</th><th>Event</th><th>User</th><th>Network</th><th>Detail</th></tr></thead>
          <tbody>{data.events.map(e => <tr key={e.id} className="static-row"><td>{formatDate(e.created_at)}</td><td><span className={`badge ${/failed|rejected/.test(e.type) ? "late" : ""}`}>{e.type}</span></td><td>{e.user_id ?? "—"}</td><td>{e.ip_masked}</td><td className="wrap">{e.detail}</td></tr>)}</tbody></table></div>
      )}
    </section>
  );
}


function Demo({ signOut }) {
  const { data, error, load } = useAdminData("/admin/demo", signOut);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [actionError, setActionError] = useState("");
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  const reset = async () => {
    setBusy(true); setMessage(""); setActionError("");
    try { const r = await adminApi("/admin/demo/reset", { method: "POST", body: "{}" }); setMessage(`Demo data ready: ${r.users} accounts, ${r.classes} classes, ${r.study_logs} study logs, ${r.worksheets} worksheets.`); await load(); }
    catch (e) { if (e.status === 401) signOut("Your admin session ended. Sign in again."); else setActionError(e.message); }
    finally { setBusy(false); }
  };
  return (
    <>
      <section className="panel">
        <div className="panel-head"><div><h2>Demo accounts</h2><p className="muted">Five ready-made accounts with live data in every feature, to show StudyTrack to real teachers. Demo and real accounts never mix.</p></div>
          <button className="primary" disabled={busy || !data.enabled} onClick={reset}>{busy ? "Working…" : data.exists ? "Reset demo data" : "Create demo data"}</button></div>
        {!data.enabled && <p className="warning-text">Demo mode is OFF. Add the environment variable <b>ALLOW_DEMO=true</b> on the server and redeploy.</p>}
        {message && <p className="success" role="status">{message}</p>}<ErrorBox error={actionError} />
        <div className="table-wrap"><table><thead><tr><th>Login (Gmail)</th><th>Password</th><th>Role</th><th>Shows</th></tr></thead>
          <tbody>{data.accounts.map(a => <tr key={a.email} className="static-row"><td>{a.email}</td><td><code>{a.password}</code></td><td>{a.role}</td><td className="wrap">{a.name}: {a.note}</td></tr>)}</tbody></table></div>
        <p className="hint">Class codes: {data.classes.map(c => `${c.code} (${c.name})`).join(", ")}. Institute code: {data.institute}. Status: {data.exists ? `${data.exists} demo accounts exist` : "not created yet"}. These passwords are public by design: anyone who knows them can see the demo, so never put real data in demo accounts. Reset restores everything.</p>
      </section>
    </>
  );
}
