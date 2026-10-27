// Browser API layer. Authentication is an httpOnly cookie that JavaScript cannot read (so XSS cannot steal it).
// Every state-changing request also carries a CSRF token, which is kept only in memory.
const API = import.meta.env.VITE_API_URL || "/api";
const CREDENTIALS = API.startsWith("http") ? "include" : "same-origin";

let csrfToken = null, adminCsrfToken = null, activeClassId = null, hadSession = false;
export const setCsrf = token => { csrfToken = token || null; hadSession = Boolean(token); };
export const setAdminCsrf = token => { adminCsrfToken = token || null; };
// Class the teacher is currently working in; sent with every request so the server answers for that class only.
export function setActiveClass(id) { activeClassId = id ?? null; }

// Codes that mean "this account can no longer use the app at all".
const ACCESS_BLOCK_CODES = new Set(["INSTITUTE_SUSPENDED", "INSTITUTE_BANNED", "ACCOUNT_BANNED"]);

export class ApiError extends Error {
  constructor(message, status, code) { super(message); this.name = "ApiError"; this.status = status; this.code = code; }
}

async function send(path, options, admin) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  const method = (options.method || "GET").toUpperCase();
  const token = admin ? adminCsrfToken : csrfToken;
  try {
    return await fetch(API + path, {
      ...options, method, credentials: CREDENTIALS, signal: controller.signal,
      headers: {
        ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...(method !== "GET" && token ? { "X-CSRF-Token": token } : {}),
        ...(!admin && activeClassId ? { "X-Class-Id": String(activeClassId) } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (e) {
    if (e.name === "AbortError") throw new ApiError("Request timed out. Please try again.", 0, "TIMEOUT");
    throw new ApiError("Can't reach the server. Check your connection and try again.", 0, "NETWORK");
  } finally { clearTimeout(timeout); }
}

async function request(path, options = {}, { admin = false } = {}) {
  let res = await send(path, options, admin);
  let data = await res.json().catch(() => ({}));
  // The CSRF token is lost on a page reload; fetch a fresh one once and retry.
  if (!res.ok && res.status === 403 && data.code === "BAD_CSRF" && !admin && !options.__retried && !(options.body instanceof FormData)) {
    try { const me = await send("/me", {}, false); const body = await me.json(); if (body.csrfToken) { setCsrf(body.csrfToken); res = await send(path, { ...options, __retried: true }, admin); data = await res.json().catch(() => ({})); } } catch { /* fall through to the error below */ }
  }
  if (!res.ok) {
    const error = new ApiError(data.error || "Request failed", res.status, data.code);
    if (!admin && res.status === 403 && ACCESS_BLOCK_CODES.has(data.code)) window.dispatchEvent(new CustomEvent("studytrack:blocked", { detail: { message: error.message, code: data.code } }));
    if (!admin && res.status === 401 && hadSession && !path.startsWith("/auth/")) window.dispatchEvent(new CustomEvent("studytrack:signed-out"));
    throw error;
  }
  return data;
}

export const api = (path, options) => request(path, options);
export const adminApi = (path, options) => request(path, options, { admin: true });
export const json = body => JSON.stringify(body);
