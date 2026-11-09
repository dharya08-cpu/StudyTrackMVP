// Per-account switches: due-date reminders (students) and new-device sign-in alerts (everyone).
import { HttpError } from "../validate.js";

export function settingsRoutes(ctx, r) {
  const { db, auth, limiters, mailer } = ctx;
  const read = async user => {
    const row = await db.one("SELECT reminders_enabled,login_alerts_enabled FROM users WHERE id=$1", [user.id]);
    return { reminders_enabled: Boolean(row.reminders_enabled), login_alerts_enabled: Boolean(row.login_alerts_enabled), email_alerts_available: mailer.enabled, role: user.role };
  };
  r.get("/api/account/settings", auth, async (req, res) => res.json(await read(req.user)));
  r.patch("/api/account/settings", auth, limiters.heavy.guard, async (req, res) => {
    const b = req.body || {};
    const sets = [], params = [];
    for (const [key, column] of [["remindersEnabled", "reminders_enabled"], ["loginAlertsEnabled", "login_alerts_enabled"]]) {
      if (b[key] === undefined) continue;
      if (typeof b[key] !== "boolean") throw new HttpError(400, "Settings must be on or off.");
      params.push(b[key]); sets.push(`${column}=$${params.length}`);
    }
    if (sets.length) { params.push(req.user.id); await db.exec(`UPDATE users SET ${sets.join(",")} WHERE id=$${params.length}`, params); }
    res.json(await read(req.user));
  });
}
