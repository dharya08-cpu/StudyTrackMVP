// E-mail wording. Plain, short, no tracking. Links are single-use and expire.
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const wrap = (title, lines, link, button) => ({
  html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1e293b"><h2 style="color:#4338ca">${esc(title)}</h2>${lines.map(l => `<p>${esc(l)}</p>`).join("")}<p><a href="${esc(link)}" style="background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">${esc(button)}</a></p><p style="color:#64748b;font-size:13px">If the button does not work, copy this address into your browser:<br>${esc(link)}</p></div>`,
  text: `${title}\n\n${lines.join("\n\n")}\n\n${button}: ${link}\n`,
});
export const verificationEmail = link => ({ subject: "Verify your StudyTrack account", ...wrap("Verify your e-mail", ["Welcome to StudyTrack. Confirm that this is your Gmail address to finish creating your account.", "This link works once and expires in 24 hours. If you did not create an account, ignore this e-mail."], link, "Verify my e-mail") });
export const resetEmail = link => ({ subject: "Reset your StudyTrack password", ...wrap("Reset your password", ["We received a request to reset the password of your StudyTrack account.", "This link works once and expires in 1 hour. If you did not ask for it, ignore this e-mail and your password stays the same."], link, "Choose a new password") });
