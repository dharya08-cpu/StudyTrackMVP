# E-mail setup (needed for "Sign up with Gmail + password")

Verification and reset links are e-mails. Render's free plan blocks normal mail ports, so StudyTrack sends mail over HTTPS. Without this, **Google sign-in still works** and the password form is hidden.

## Easiest: a free Google Apps Script that sends from your own Gmail (about 5 minutes, works on a phone browser with "Desktop site")
1. Go to **script.google.com**, tap **New project**, delete the sample code and paste:
```js
function doPost(e) {
  var d = JSON.parse(e.postData.contents);
  var secret = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!secret || d.token !== secret) return ContentService.createTextOutput('forbidden');
  MailApp.sendEmail({ to: d.to, subject: d.subject, body: d.text, htmlBody: d.html, name: 'StudyTrack' });
  return ContentService.createTextOutput('ok');
}
```
2. **Project Settings (gear) > Script properties > Add**: name `TOKEN`, value a long random secret (12+ characters). Save.
3. **Deploy > New deployment > type: Web app**. *Execute as:* **Me**. *Who has access:* **Anyone**. Deploy, allow the permissions (it only needs to send mail), and **copy the Web app URL** (ends in `/exec`).
4. In Render > Environment add:
   * `MAIL_PROVIDER` = `webhook`
   * `MAIL_WEBHOOK_URL` = the Web app URL
   * `MAIL_WEBHOOK_TOKEN` = the same secret as `TOKEN`
5. Redeploy. Sign-up with a password now works.

Limits and safety: a normal Gmail account can send roughly 100 e-mails a day through Apps Script, enough to start. The secret token stops anyone else from using your script. If you outgrow it, use Resend (`MAIL_PROVIDER=resend`, `RESEND_API_KEY`, `MAIL_FROM`) with your own domain.

## Test it
Open your app > Sign up > use a Gmail address you own. The link should arrive within a minute (check Spam). If Render's log shows `mail webhook refused`, the token or URL does not match.
