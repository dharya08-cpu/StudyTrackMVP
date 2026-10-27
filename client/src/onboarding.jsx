import React, { useEffect, useState } from "react";
import { api, json } from "./api.js";
import { ErrorBox, Loading } from "./ui.jsx";

// Shown ONCE after sign-up (either way). Google users see their Google name pre-filled to confirm.
export function Onboarding({ user, onDone, logout }) {
  const [info, setInfo] = useState(null), [f, setF] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const student = user.role === "student";
  useEffect(() => {
    api("/profile").then(d => {
      setInfo(d);
      setF({ firstName: d.profile.first_name || d.suggested.first_name || "", lastName: d.profile.last_name || d.suggested.last_name || "", phone: d.profile.phone || "", city: d.profile.city || "", school: d.profile.school || "",
        parentName: d.profile.parent_name || "", parentPhone: d.profile.parent_phone || "", grade: d.profile.grade || "", classCode: "", subjects: d.profile.subjects || "", className: "" });
    }).catch(e => setError(e.message));
  }, []);
  if (!f) return error ? <main className="auth"><div className="auth-card"><ErrorBox error={error} /><button className="primary" onClick={logout}>Log out</button></div></main> : <Loading />;
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const submit = async e => {
    e.preventDefault(); setError(""); setBusy(true);
    try { const r = await api("/profile", { method: "PUT", body: json(f) }); onDone(r); }
    catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <main className="auth"><div className="auth-card wide">
      <div className="brand">Study<span>Track</span></div>
      <h1>{student ? "Tell us about yourself" : "Set up your teacher profile"}</h1>
      <p className="muted">You only do this once. Signed in as <b>{info.email}</b>.</p>
      {info.source === "google" && <div className="notice" role="status">We filled in your name from your Google account. Please check that it is correct, and change it if not.</div>}
      <form onSubmit={submit}>
        <div className="form-grid">
          <label className="field">First name<input value={f.firstName} onChange={set("firstName")} maxLength={50} autoComplete="given-name" required /></label>
          <label className="field">Surname<input value={f.lastName} onChange={set("lastName")} maxLength={50} autoComplete="family-name" required /></label>
          {student && <>
            <label className="field">Parent or guardian name<input value={f.parentName} onChange={set("parentName")} maxLength={100} required /></label>
            <label className="field">Parent or guardian phone <span className="hint-inline">(optional)</span><input type="tel" value={f.parentPhone} onChange={set("parentPhone")} maxLength={20} /></label>
            <label className="field">Class / grade<input value={f.grade} onChange={set("grade")} maxLength={30} placeholder="e.g. Class 11" required /></label>
            <label className="field">School <span className="hint-inline">(optional)</span><input value={f.school} onChange={set("school")} maxLength={100} /></label>
          </>}
          {!student && <>
            <label className="field">Subjects you teach<input value={f.subjects} onChange={set("subjects")} maxLength={200} placeholder="e.g. Physics, Maths" required /></label>
            <label className="field">Institute or school <span className="hint-inline">(optional)</span><input value={f.school} onChange={set("school")} maxLength={100} /></label>
          </>}
          <label className="field">Your phone <span className="hint-inline">(optional)</span><input type="tel" value={f.phone} onChange={set("phone")} maxLength={20} autoComplete="tel" /></label>
          <label className="field">City <span className="hint-inline">(optional)</span><input value={f.city} onChange={set("city")} maxLength={80} /></label>
        </div>
        {student
          ? <label className="field">Class code <span className="hint-inline">(optional: ask your teacher; you can also add it later)</span><input value={f.classCode} onChange={e => setF({ ...f, classCode: e.target.value.toUpperCase() })} maxLength={12} autoCapitalize="characters" autoComplete="off" /></label>
          : <div className="form-grid">
              <label className="field">First class name <span className="hint-inline">(optional)</span><input value={f.className} onChange={set("className")} maxLength={100} placeholder="e.g. Physics Class 11" /></label>
              <label className="field">Class code <span className="hint-inline">(optional, or we make one)</span><input value={f.classCode} onChange={e => setF({ ...f, classCode: e.target.value.toUpperCase() })} maxLength={12} /></label>
            </div>}
        <ErrorBox error={error} />
        <button className="primary" disabled={busy}>{busy ? "Saving…" : "Save and continue"}</button>
        <button type="button" className="link" onClick={logout}>Log out</button>
      </form>
    </div></main>
  );
}
