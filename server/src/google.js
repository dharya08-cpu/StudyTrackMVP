// Google Sign-In: verifies the ID token itself (RS256 signature against Google's public keys, issuer, audience,
// expiry, nonce) and then applies the "verified Gmail only" rule. No password is ever stored or accepted.
import crypto from "node:crypto";
import { HttpError, cleanText } from "./validate.js";

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
export const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
const fail = (detail) => Object.assign(new HttpError(401, "Google sign-in could not be verified. Please try again.", "GOOGLE_TOKEN_INVALID"), { detail });

async function defaultFetchJwks() {
  const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") || "")?.[1] || 3600);
  return { keys: (await res.json()).keys || [], maxAgeSeconds: maxAge };
}

export function createGoogleVerifier({ clientId, clock, fetchJwks = defaultFetchJwks }) {
  let cache = { keys: [], expires: 0 };
  async function keys(force = false) {
    if (!force && cache.keys.length && clock.now().getTime() < cache.expires) return cache.keys;
    const { keys: fresh, maxAgeSeconds } = await fetchJwks();
    cache = { keys: fresh, expires: clock.now().getTime() + Math.min(maxAgeSeconds, 24 * 3600) * 1000 };
    return cache.keys;
  }
  const decode = part => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

  return {
    enabled: Boolean(clientId),
    async verify(idToken) {
      if (!clientId) throw new HttpError(503, "Google sign-in is not configured on this server.", "GOOGLE_NOT_CONFIGURED");
      if (typeof idToken !== "string" || idToken.length < 20 || idToken.length > 4096) throw fail("token shape");
      const parts = idToken.split(".");
      if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw fail("token format");
      let header, claims;
      try { header = decode(parts[0]); claims = decode(parts[1]); } catch { throw fail("token json"); }
      if (header.alg !== "RS256" || typeof header.kid !== "string") throw fail("alg/kid");
      let jwk = (await keys()).find(k => k.kid === header.kid);
      if (!jwk) jwk = (await keys(true)).find(k => k.kid === header.kid); // keys rotate: look again once
      if (!jwk) throw fail("unknown key");
      let valid = false;
      try {
        valid = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"));
      } catch { valid = false; }
      if (!valid) throw fail("signature");
      const nowSeconds = Math.floor(clock.now().getTime() / 1000);
      if (!ISSUERS.has(claims.iss)) throw fail("issuer");
      if (claims.aud !== clientId) throw fail("audience");
      if (!Number.isFinite(claims.exp) || claims.exp + 30 < nowSeconds) throw fail("expired");
      if (Number.isFinite(claims.iat) && claims.iat - 300 > nowSeconds) throw fail("issued in the future");
      if (typeof claims.sub !== "string" || !claims.sub) throw fail("subject");
      return claims;
    },
  };
}

// "Verified Gmail accounts only": Google must say the address is verified, it must be a Gmail address,
// and Google Workspace / school accounts (which carry an `hd` claim) are not accepted.
export function assertVerifiedGmail(claims) {
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  const verified = claims.email_verified === true || claims.email_verified === "true";
  const domain = email.split("@")[1] || "";
  if (!verified || !email || !GMAIL_DOMAINS.has(domain) || claims.hd) {
    throw new HttpError(403, "Only verified Gmail accounts can sign in to StudyTrack.", "GMAIL_REQUIRED");
  }
  const fallback = email.split("@")[0].slice(0, 60) || "Student";
  const name = cleanText(String(claims.name || ""), { max: 100, min: 1 }) || fallback;
  return { sub: claims.sub, email, name, nonce: typeof claims.nonce === "string" ? claims.nonce : "" };
}
