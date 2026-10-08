import React, { useState } from "react";
import { api, json } from "./api.js";
import { ErrorBox } from "./ui.jsx";

// "Create Your Own Coaching Institute": the signed-in teacher becomes the head once the owner approves the request.
export function InstituteCreateFlow({ onDone, onCancel }) {
  const [details, setDetails] = useState({ instituteName: "", coachingCode: "", phone: "", city: "", description: "", expectedTeachers: "", expectedStudents: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const setD = key => e => setDetails({ ...details, [key]: e.target.value });
  const submit = async e => {
    e.preventDefault(); setError(""); setBusy(true);
    try {
      const body = { ...details, expectedTeachers: details.expectedTeachers === "" ? null : Number(details.expectedTeachers), expectedStudents: details.expectedStudents === "" ? null : Number(details.expectedStudents) };
      onDone(await api("/institute/request", { method: "POST", body: json(body) }));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <div className="flow">
      <h1>Create your coaching institute</h1>
      <p className="muted">Tell us about your institute. StudyTrack reviews each request before it goes live.</p>
      <form onSubmit={submit}>
        <label className="field">Institute name<input value={details.instituteName} onChange={setD("instituteName")} minLength={3} maxLength={80} placeholder="e.g. Bright Future Academy" required /></label>
        <label className="field">Coaching code <span className="hint-inline">(optional. Teachers use it to join. Leave blank to get one.)</span><input value={details.coachingCode} onChange={e => setDetails({ ...details, coachingCode: e.target.value.toUpperCase() })} maxLength={12} placeholder="4 to 12 letters or numbers" pattern="[A-Za-z0-9]{4,12}|" title="4 to 12 letters or numbers" /></label>
        <label className="field">Contact phone<input type="tel" value={details.phone} onChange={setD("phone")} maxLength={20} required /></label>
        <label className="field">City<input value={details.city} onChange={setD("city")} maxLength={80} /></label>
        <div className="form-grid">
          <label className="field">Teachers expected<input type="number" min="0" value={details.expectedTeachers} onChange={setD("expectedTeachers")} /></label>
          <label className="field">Students expected<input type="number" min="0" value={details.expectedStudents} onChange={setD("expectedStudents")} /></label>
        </div>
        <label className="field">About your institute <span className="hint-inline">(optional)</span><textarea value={details.description} onChange={setD("description")} maxLength={500} /></label>
        <ErrorBox error={error} />
        <button className="primary" disabled={busy}>{busy ? "Sending…" : "Send for approval"}</button>
        <button type="button" className="link" onClick={onCancel}>Cancel</button>
      </form>
    </div>
  );
}

export const INSTITUTE_INFO = (
  <>
    A coaching institute is a shared space for your whole coaching.<br />
    You create it and receive a coaching code.<br />
    Other teachers join with that code and work in one place.<br />
    Their classes, student counts and progress show on one institute page.<br />
    StudyTrack reviews each new institute before it goes live.
  </>
);
