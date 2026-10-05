const API = import.meta.env.VITE_API_URL || "/api";
const USER_TOKEN_KEY = "studytrack_token";
const ADMIN_TOKEN_KEY = "studytrack_admin_token";

// Class the teacher is currently working in. It is sent with every request so
// the server answers for that class only.
let activeClassId = null;
export function setActiveClass(id) { activeClassId = id ?? null; }

// Codes that mean "this account can no longer use the app at all".
const ACCESS_BLOCK_CODES = new Set(["INSTITUTE_SUSPENDED", "INSTITUTE_BANNED", "ACCOUNT_BANNED", "CLASS_SUSPENDED", "CLASS_UNAVAILABLE"]);

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request(path, options = {}, { admin = false } = {}) {
  const token = admin ? sessionStorage.getItem(ADMIN_TOKEN_KEY) : localStorage.getItem(USER_TOKEN_KEY);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const isFormData = options.body instanceof FormData;
  let res;
  try {
    res = await fetch(API + path, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(isFormData ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(!admin && activeClassId ? { "x-class-id": String(activeClassId) } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (e) {
    if (e.name === "AbortError") throw new ApiError("Request timed out. Please try again.", 0, "TIMEOUT");
    throw new ApiError("Can't reach the server. Check your connection and try again.", 0, "NETWORK");
  } finally {
    clearTimeout(timeout);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new ApiError(data.error || "Request failed", res.status, data.code);
    if (!admin && res.status === 403 && ACCESS_BLOCK_CODES.has(data.code)) {
      window.dispatchEvent(new CustomEvent("studytrack:blocked", { detail: { message: error.message, code: data.code } }));
    }
    if (!admin && res.status === 401 && token && !path.startsWith("/auth/")) {
      window.dispatchEvent(new CustomEvent("studytrack:signed-out"));
    }
    throw error;
  }
  return data;
}

export const api = (path, options) => request(path, options);
export const adminApi = (path, options) => request(path, options, { admin: true });
export const json = body => JSON.stringify(body);

export const session = {
  get: () => localStorage.getItem(USER_TOKEN_KEY),
  set: token => localStorage.setItem(USER_TOKEN_KEY, token),
  clear: () => { localStorage.removeItem(USER_TOKEN_KEY); setActiveClass(null); },
};
export const adminSession = {
  has: () => Boolean(sessionStorage.getItem(ADMIN_TOKEN_KEY)),
  set: token => sessionStorage.setItem(ADMIN_TOKEN_KEY, token),
  clear: () => sessionStorage.removeItem(ADMIN_TOKEN_KEY),
};
