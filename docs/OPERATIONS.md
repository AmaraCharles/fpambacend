# FPAMAS backend — operations runbook

For whoever keeps the API running: configuration, backups, monitoring and what
to do when something goes wrong. The API is on Render; the database is MongoDB
Atlas; the dashboard is built into the `fpam-real` repo and served by Vercel.

## 1. Environment variables (Render → service → Environment)

| Variable | Required | Purpose |
|---|---|---|
| `MONGO_URI`, `MONGO_DB_NAME` | yes | Database connection |
| `JWT_SECRET` | yes | Signs session tokens. 32+ random characters. Changing it signs everyone out. |
| `JWT_EXPIRES_IN` | no (default `7d`) | Session length. `12h` is a sensible tighter value. |
| `CLIENT_URL` | no | Extra allowed browser origin |
| `APP_URL` | recommended | Base for links in emails, e.g. `https://fpam.fmhud.gov.ng/app` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | for email | Without `SMTP_HOST` no email is sent (each is logged and skipped) |
| `SMS_PROVIDER` + provider keys | optional | `termii` (`TERMII_API_KEY`, `TERMII_SENDER_ID`), `twilio` (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`) or `africastalking` (`AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID`) |
| `MFA_REQUIRED_ROLES` | no (default `System Admin,Supervisor,Sub-Head`) | Roles that must turn on two-step sign-in before using the dashboard. `none` turns the requirement off. |
| `CLAMAV_HOST`, `CLAMAV_PORT` | optional | Virus-scan uploads with a ClamAV daemon. `CLAMAV_REQUIRED=true` rejects uploads when the scanner is down. |

System Admins can see which of these are working under **System health** in the dashboard.

## 2. Rotating credentials

Do this now if a secret was ever shared in chat, email or a log, and once a year otherwise.

1. **Database password** — Atlas → Database Access → edit the user → new password. Update `MONGO_URI` on Render (and any local `.env`), then redeploy.
2. **Atlas network access** — allow only Render's outbound IPs (or `0.0.0.0/0` with a strong password if Render's free plan has no fixed IP); remove old personal IPs.
3. **JWT secret** — set a new random `JWT_SECRET` on Render. Everyone is signed out.
4. **User passwords** — the login route logged plain-text passwords until October 2026. Ask every user to change theirs (shield icon → Password), admins first, and purge old Render logs if possible.

## 3. Backups and restore

- **Automatic (recommended):** Atlas Cloud Backup on a paid cluster tier gives daily snapshots with point-in-time restore. The free tier has no automatic backups.
- **Manual, from the dashboard:** System health → *Download backup* (System Admin). Extended JSON of every collection; photo/document contents are not included.
- **Manual, from a terminal:** `node scripts/backup.js` (add `--with-files` for photo/document contents).
- **Restore:** `node scripts/restore.js <file>` shows what's in the backup; add `--yes` to restore into empty collections, `--yes --drop` to replace. **Practise it** on a spare database (`MONGO_DB_NAME=assetspatial_restore_test`) — a backup you haven't restored isn't proven.

Backups contain password hashes: store them encrypted, not in email or chat.

## 4. Monitoring

- **Uptime:** point an uptime checker (e.g. UptimeRobot, free) at `https://fpambacend.onrender.com/api/system/ping`. It returns 503 when the database is unreachable.
- **Errors:** dashboard → System health → *Recent errors* shows server 500s and errors users' browsers hit (kept 30 days).
- **Cold starts:** Render's free plan sleeps after ~15 idle minutes. `.github/workflows/keep-warm.yml` pings the API every 10 minutes in working hours; the dashboard also shows a "waking up" banner. A paid Render plan removes the problem entirely (then delete the workflow).

## 5. Tests and CI

`npm test` runs the suite on an in-memory MongoDB (no real database is touched). GitHub Actions runs it on every push (`.github/workflows/ci.yml`).

## 6. Security features to know about

- **Two-step sign-in:** required for System Admins, Supervisors and Sub-Heads (they're shown a setup screen until it's on; change with `MFA_REQUIRED_ROLES`); optional for everyone else under Account security. Admins can reset it for someone who lost their phone (Users → shield button). Recovery codes work once each.
- **Sign out everywhere:** password changes/resets, deactivation and the Sessions tab revoke every token.
- **Uploads:** every file's contents are checked against its type before storage (disguised executables, scripted PDFs and macro files are rejected).
- **API docs:** `https://fpambacend.onrender.com/api/docs`.

## 7. If something breaks

| Symptom | Check |
|---|---|
| Dashboard says "Cannot reach the server" | `/api/system/ping`; Render dashboard logs; Atlas status |
| Everyone suddenly signed out | `JWT_SECRET` changed? |
| No emails | System health → Email check; Render logs show `[mail] SMTP not configured` |
| Upload rejected "contents don't match its type" | The file was renamed (e.g. a .heic saved as .jpg) — export it properly |
