// "New sign-in" alerts. Each account remembers the KINDS of device it has signed in from (browser + operating system +
// phone/tablet/computer). A sign-in from a kind it has not seen before creates an in-app alert and, when e-mail is
// configured, an e-mail. The very first sign-in never alerts, and neither does an account's first sign-in after V6 is
// installed (that one simply teaches it your current device), so nobody gets an alert storm on upgrade.
import { sha256, maskIp, clientIp } from "./security.js";
import { parseUserAgent, locationFromHeaders } from "./sessions.js";
import { notify } from "./repo.js";
import { loginAlertEmail } from "./emails.js";

const EMAIL_COOLDOWN_MS = 10 * 60_000;

export function deviceKind(userAgent) {
  const ua = parseUserAgent(userAgent);
  const label = `${ua.browser} on ${ua.os}`;
  return { label, fingerprint: sha256(`${ua.browser}|${ua.os}|${ua.deviceType}`) };
}

const whenText = (clock, date) => new Intl.DateTimeFormat("en-IN", { timeZone: clock.timeZone, dateStyle: "medium", timeStyle: "short" }).format(date);

export async function noteSignIn(ctx, req, user) {
  try {
    const { db, clock, mailer, config } = ctx;
    if (user.is_demo) return { alerted: false };
    const { label, fingerprint } = deviceKind(req.get("user-agent"));
    const now = clock.nowIso();
    const known = await db.one("SELECT id FROM known_devices WHERE user_id=$1 AND fingerprint=$2", [user.id, fingerprint]);
    if (known) { await db.exec("UPDATE known_devices SET last_seen_at=$1 WHERE id=$2", [now, known.id]); return { alerted: false }; }
    const before = (await db.one("SELECT COUNT(*) AS n FROM known_devices WHERE user_id=$1", [user.id])).n;
    await db.exec("INSERT INTO known_devices(user_id,fingerprint,label,first_seen_at,last_seen_at) VALUES($1,$2,$3,$4,$4) ON CONFLICT(user_id,fingerprint) DO NOTHING", [user.id, fingerprint, label, now]);
    if (before === 0 || !user.login_alerts_enabled) return { alerted: false };

    const where = locationFromHeaders(req) || `network ${maskIp(clientIp(req))}`;
    const when = whenText(clock, clock.now());
    await notify(db, clock, [user.id], { type: "security", priority: "important", title: `New sign-in on ${label}`, body: `${when} from ${where}. If this was not you, open Security & privacy, log out of all other devices and change your password.`, refType: "security" });
    await db.exec("INSERT INTO security_events(user_id,type,ip_masked,detail,created_at) VALUES($1,'login_alert',$2,$3,$4)", [user.id, maskIp(clientIp(req)), label, now]);
    if (mailer.enabled && user.email_verified) {
      const recent = await db.one("SELECT COUNT(*) AS n FROM security_events WHERE user_id=$1 AND type='login_alert_mail' AND created_at>$2", [user.id, new Date(clock.now().getTime() - EMAIL_COOLDOWN_MS).toISOString()]);
      if (recent.n === 0) {
        await db.exec("INSERT INTO security_events(user_id,type,ip_masked,detail,created_at) VALUES($1,'login_alert_mail',$2,'',$3)", [user.id, maskIp(clientIp(req)), now]);
        // Sent in the background: a slow mail service must never delay or break signing in.
        Promise.resolve().then(() => mailer.send({ to: user.email, ...loginAlertEmail({ label, when, where, link: `${config.appOrigins[0]}/` }) })).catch(error => console.error("Login alert mail failed:", error.message));
      }
    }
    return { alerted: true, label };
  } catch (error) { console.error("Login alert check failed:", error.message); return { alerted: false }; }
}
