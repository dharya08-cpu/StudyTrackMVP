// Sends verification and password-reset e-mails over HTTPS (Render's free plan blocks SMTP).
//   webhook : a small Google Apps Script web app that sends from your own Gmail (see docs/EMAIL-SETUP.md)
//   resend  : the Resend HTTP API (needs a verified sending domain)
//   console : development only, prints the link instead of sending
//   none    : password sign-up is switched off (Google sign-in still works)
export function createMailer(config, { fetchFn = globalThis.fetch, log = console.log } = {}) {
  const m = config.mail;
  const enabled = m.provider !== "none";
  async function send({ to, subject, text, html }) {
    if (m.provider === "console") { log(`[mail] to=${to}\n[mail] ${subject}\n${text}`); return; }
    if (m.provider === "webhook") {
      const res = await fetchFn(m.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, redirect: "follow", signal: AbortSignal.timeout(20000), body: JSON.stringify({ token: m.webhookToken, to, subject, text, html }) });
      const body = (await res.text()).trim();
      if (!res.ok || !/^ok\b/i.test(body)) throw new Error(`mail webhook refused the message (${res.status}): ${body.slice(0, 80)}`);
      return;
    }
    if (m.provider === "resend") {
      const res = await fetchFn("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${m.resendKey}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(20000), body: JSON.stringify({ from: m.from, to: [to], subject, text, html }) });
      if (!res.ok) throw new Error(`Resend refused the message (${res.status}): ${(await res.text()).slice(0, 100)}`);
      return;
    }
    throw new Error("E-mail sending is not configured");
  }
  return { enabled, provider: m.provider, send };
}
