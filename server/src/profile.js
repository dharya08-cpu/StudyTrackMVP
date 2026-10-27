// Details collected once after sign-up (and editable later). Student and teacher forms differ.
import { HttpError, v } from "./validate.js";

const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]{0,99}$/u;
const PHONE_RE = /^[0-9+\-\s()]{6,20}$/;
const name = (value, label, max = 50) => {
  const s = v.str(value, label, { min: 1, max });
  if (!NAME_RE.test(s)) throw new HttpError(400, `${label} can only contain letters, spaces, dots, hyphens and apostrophes`);
  return s;
};
const phone = (value, label) => {
  const s = v.optStr(value, label, { max: 20 });
  if (s && !PHONE_RE.test(s)) throw new HttpError(400, `${label} must be a valid phone number`);
  return s;
};

export function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { first_name: parts[0] || "", last_name: "" };
  return { first_name: parts.slice(0, -1).join(" "), last_name: parts.at(-1) };
}

export function validateProfile(role, body = {}) {
  const base = { first_name: name(body.firstName, "First name"), last_name: name(body.lastName, "Surname"), phone: phone(body.phone, "Phone number"), city: v.optStr(body.city, "City", { max: 80 }) };
  if (role === "student") {
    return { ...base, parent_name: name(body.parentName, "Parent or guardian name", 100), parent_phone: phone(body.parentPhone, "Parent or guardian phone"), grade: v.str(body.grade, "Class or grade", { min: 1, max: 30 }), school: v.optStr(body.school, "School", { max: 100 }), subjects: "" };
  }
  return { ...base, parent_name: "", parent_phone: "", grade: "", school: v.optStr(body.school, "Institute or school", { max: 100 }), subjects: v.str(body.subjects, "Subjects you teach", { min: 1, max: 200 }) };
}

export const PROFILE_COLUMNS = ["first_name", "last_name", "phone", "parent_name", "parent_phone", "grade", "school", "city", "subjects"];
