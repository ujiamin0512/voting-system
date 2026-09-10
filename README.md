# Voting System

Admin-managed voting with photo candidates, a QR code for participants, device locking and a
live scoreboard. Runs locally with no database, and deploys to Vercel with Postgres.

## Run locally

```bash
npm install
npm start
```

- Admin: http://localhost:3000/ — password `admin123`
- Voting: http://localhost:3000/vote
- Results: http://localhost:3000/results (open it from the admin page so the login token is present)

In VS Code press **F5** instead, and pick a launch configuration. `npm run dev` restarts on
save; `npm run reset` deletes the local `data.json`.

## Storage

The backend is chosen automatically:

| Environment | Condition | Storage |
|---|---|---|
| Local | `DATABASE_URL` unset | `data.json` in the project folder |
| Vercel | `DATABASE_URL` set | Postgres (tables created on first request) |

The admin status line shows which one is live. Vercel's filesystem is ephemeral, so a
database is **required** there — without one, votes disappear between requests.

## Deploy to Vercel

1. Push this repo to GitHub (already wired to `ujiamin0512/voting-system`).
2. On [vercel.com](https://vercel.com/new) → **Import** the repo → **Deploy**.
3. In the project → **Storage** → **Create Database** → **Neon Postgres** → Connect.
   Vercel injects `DATABASE_URL` automatically. (Any Postgres URL works — Supabase too.)
4. In **Settings → Environment Variables** add:
   - `ADMIN_PASSWORD` — your admin password (do not leave the default)
   - `SESSION_SECRET` — any long random string
5. **Redeploy** so the new variables take effect.

Every `git push` to `main` redeploys automatically.

## Environment variables

| Name | Default | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | `admin123` | Admin login |
| `SESSION_SECRET` | derived from the password | Signs admin tokens |
| `DATABASE_URL` | unset | Postgres connection string; enables the database backend |
| `PORT` | `3000` | Local port |
| `HOST_IP` | auto-detected | Overrides the LAN IP used in the local QR code |

## Admin features

- **Poll settings** — title, how many votes each participant must cast, open/close voting.
- **Candidates (full CRUD)** — add with name + photo, edit name/photo/vote count, delete.
- **Show QR code** — participants scan it to land straight on the voting page.
- **Live results** — auto-refreshing scoreboard with ranks, bars and percentages.
- **One vote per device** — on by default; toggle off for kiosk/shared-tablet voting.
- **Clear device locks** — lets everyone vote again without touching the tally.
- **Reset all votes** — zeroes every candidate, clears ballots and device locks.

## Voting rules

The submit button stays disabled until exactly `votesPerVoter` candidates are selected; the
server re-checks the count, rejects duplicates and unknown candidates, and refuses ballots
while voting is closed.

## Device locking

Each device gets a `vdid` cookie (1 year) on first load, mirrored to `localStorage` as a
fallback if cookies are cleared. The server records ids that have voted and rejects repeats
with HTTP 409; the vote page then shows a "🔒 Already voted" screen. On Postgres the device
id is a primary key, so two simultaneous requests cannot both slip through. This stops casual
double-voting — it is not proof against a private window or a second phone.

## Photos

Photos are downscaled in the browser to 640px JPEG and stored inline, keeping uploads well
under Vercel's 4.5 MB request limit. There is no separate file storage to configure.

## QR code notes

Deployed, the QR points at your Vercel domain and works anywhere. Locally it points at your
LAN IP: phones must be on the same Wi-Fi, and Windows Firewall must allow Node on port 3000.
If the detected IP is wrong, run `HOST_IP=192.168.1.50 npm start`.
