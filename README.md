# KyZer-Fea

KyZer-Fea combines the WhatsApp bot and the Pair Code / QR web panel in **one Node.js service**.

## Routes

- `/` — Pair Code and QR web panel
- `/pair?number=947XXXXXXXX` — Pair Code API
- `/qr` — QR Code API
- `/health` — Render/UptimeRobot health check
- `/bot` — Basic bot status page

## Run locally

Requires Node.js 20 or later.

```bash
npm install
npm start
```

## Required environment variables

Set these in Render's Environment page. Do not commit them to GitHub.

- `MEGA_EMAIL` — MEGA account email used for encrypted WhatsApp session snapshots.
- `MEGA_PASSWORD` — MEGA account password.

The app creates a `KyZer-Fea Sessions` folder in that MEGA account. The Pair Code / QR routes save complete Baileys multi-file session snapshots there. The bot loads the latest snapshot on startup and refreshes backups while connected, so an ephemeral Render filesystem restart does not depend on a hardcoded session link.

Optional variables:

- `BOT_OWNER` — WhatsApp owner number with country code, digits only.
- `AUTO_STATUS_SEEN` — `true` or `false`.
- `AUTO_STATUS_REACT` — `true` or `false`.

## Render Free

The repository includes a Render Blueprint. Create one Web Service from `render.yaml`; it runs the bot and pairing web panel in the same process.

Render Free services sleep after 15 minutes without inbound traffic. To keep the service warm, add its `/health` URL as an HTTP monitor in UptimeRobot Free (5-minute interval). This is a best-effort keep-alive, not a 24/7 uptime guarantee: Render can restart Free instances, and a missed monitor interval can allow the service to sleep.

## GitHub Actions

The Node.js CI workflow installs dependencies, checks the JavaScript files, and smoke-tests the HTTP health endpoint before Render's configured CI-gated auto-deploy.
