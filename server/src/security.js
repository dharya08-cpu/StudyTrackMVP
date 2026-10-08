// HTTP hardening: security headers, CSP, CORS allow-list, cookies, CSRF tokens, origin checks.
import crypto from "node:crypto";
import { HttpError } from "./validate.js";

export const sha256 = value => crypto.createHash("sha256").update(String(value)).digest("hex");
export function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
export const hmac = (secret, value) => crypto.createHmac("sha256", secret).update(value).digest("hex");

// The full IP address is never stored; only a masked form is shown in "Active sessions".
export function maskIp(ip) {
  const s = String(ip || "").replace(/^::ffff:/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return `${s.split(".").slice(0, 2).join(".")}.•.•`;
  if (s.includes(":")) return `${s.split(":").slice(0, 2).join(":")}:•:•`;
  return "";
}
export const clientIp = req => String(req.ip || req.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    let value = part.slice(at + 1).trim();
    try { value = decodeURIComponent(value); } catch { continue; }
    if (!(name in out)) out[name] = value;
  }
  return out;
}
export function serializeCookie(name, value, { maxAgeSeconds = null, httpOnly = true, secure = false, sameSite = "Lax", path = "/" } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  if (maxAgeSeconds !== null) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  return parts.join("; ");
}
export const cookieMiddleware = (req, res, next) => { req.cookies = parseCookies(req.get("cookie")); next(); };

// Synchroniser token derived from the server secret and the session id. A cross-site page cannot read it.
export const csrfTokenFor = (secret, sessionId) => hmac(secret, `csrf:${sessionId}`);

export function buildCsp({ isProd }) {
  const directives = [
    "default-src 'self'",
    "script-src 'self' https://accounts.google.com/gsi/client",
    "style-src 'self' https://accounts.google.com/gsi/style",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' https://accounts.google.com/gsi/",
    "frame-src https://accounts.google.com/gsi/",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (isProd) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function securityHeaders(config) {
  const csp = buildCsp(config);
  return (req, res, next) => {
    res.removeHeader?.("X-Powered-By");
    res.set("Content-Security-Policy", csp);
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Referrer-Policy", "strict-origin-when-cross-origin");
    res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()");
    res.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    res.set("Cross-Origin-Resource-Policy", "same-origin");
    res.set("X-DNS-Prefetch-Control", "off");
    res.set("X-Permitted-Cross-Domain-Policies", "none");
    if (config.isProd) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (String(req.path || req.url || "").startsWith("/api")) {
      res.set("Cache-Control", "no-store");
      res.set("Pragma", "no-cache");
      res.set("X-Robots-Tag", "noindex, nofollow");
    }
    next();
  };
}

// Only the configured front-end origins get CORS headers; everything else is refused by the browser.
export function corsMiddleware(config) {
  const allowed = new Set(config.corsOrigins);
  return (req, res, next) => {
    const origin = req.get("origin");
    if (origin && allowed.has(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Credentials", "true");
      res.append?.("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
        res.set("Access-Control-Allow-Headers", "Content-Type,X-CSRF-Token,X-Class-Id");
        res.set("Access-Control-Max-Age", "600");
        return res.status(204).end();
      }
    } else if (req.method === "OPTIONS" && origin) {
      return res.status(403).end();
    }
    next();
  };
}

// CSRF defence layer 1: state-changing requests must come from one of our own origins.
export function originGuard(config) {
  const allowed = new Set([...config.appOrigins, ...config.corsOrigins]);
  return (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.get("origin");
    if (!origin || !allowed.has(origin)) return next(new HttpError(403, "This request was blocked for your safety (unexpected origin).", "BAD_ORIGIN"));
    next();
  };
}
