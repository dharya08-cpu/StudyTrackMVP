import React, { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

let gisPromise = null;
function loadGoogle() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.defer = true;
      s.onload = resolve;
      s.onerror = () => { gisPromise = null; reject(new Error("Could not load Google sign-in. Check your connection.")); };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

// Renders Google's own sign-in button. Each button gets a fresh single-use nonce that is bound to this browser,
// so a captured token cannot be replayed. Remount it (change `key`) after every attempt to get a new nonce.
export function GoogleButton({ clientId, onCredential, onError, text = "continue_with" }) {
  const ref = useRef(null);
  const handlers = useRef({ onCredential, onError });
  handlers.current = { onCredential, onError };
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadGoogle();
      const { nonce } = await api("/auth/nonce", { method: "POST", body: "{}" });
      if (cancelled || !ref.current) return;
      window.google.accounts.id.initialize({ client_id: clientId, nonce, ux_mode: "popup", auto_select: false, cancel_on_tap_outside: true, callback: r => r?.credential && handlers.current.onCredential(r.credential) });
      ref.current.innerHTML = "";
      window.google.accounts.id.renderButton(ref.current, { theme: "outline", size: "large", shape: "pill", text, width: Math.min(300, ref.current.clientWidth || 300) });
      setReady(true);
    })().catch(e => { if (!cancelled) handlers.current.onError?.(e.message); });
    return () => { cancelled = true; };
  }, [clientId, text]);
  return <div className="google-slot"><div ref={ref} aria-label="Sign in with Google" />{!ready && <small className="muted">Loading Google sign-in…</small>}</div>;
}
