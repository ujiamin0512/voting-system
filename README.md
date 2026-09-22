# Voting System

Admin-managed voting with photo candidates, a QR code for participants, device locking and a
live scoreboard. Participants can also submit their own entries — a photo, or a game link that
becomes a QR code everyone scans to play before voting. Runs locally with no database, and
deploys to Vercel with Postgres.

## Run locally

```bash
npm install
npm start
```

- Admin: http://localhost:3000/ — password `admin123`
- Voting: http://localhost:3000/vote
- Submit an entry: http://localhost:3000/submit
- Projector: http://localhost:3000/projector — public, no login needed (`/results` still works)

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

## Troubleshooting the deployment

Open `/api/health` on the deployed site. It reports which backend is live and which
environment variables were found (names only, never values).

- `"storage":"none"` — no database is connected; the admin panel shows a red banner and
  writes fail with instructions instead of a confusing `EROFS: read-only file system`.
  Connect Neon in the Storage tab, then **redeploy** — env vars only apply to new builds.
- `"storage":"postgres"` — connected and working.

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

- **Poll settings** — title, how many votes each participant must cast, open/close voting,
  what participants submit (**Pictures**: name + photo, or **Links**: name + game name + URL),
  and whether submissions are open.
- **Candidates (full CRUD)** — add with name + photo (or name + game + link in Links mode),
  edit anything including the vote count, delete. Entries that came in from a phone carry a
  📱 badge.
- **Submit QR** — participants scan it to land on `/submit` and add their own entry. One entry
  per device (same cookie as voting); submitting again from that phone edits it instead.
- **Preview vote page** — see the ballot exactly as voters do, in a phone-sized frame; selections there are never recorded and never lock your device.
- **Vote QR** — participants scan it to land straight on the voting page.
- **Projector** — a full-screen slideshow for the big screen: one slide per candidate (photo
  above, name below), then a live side-by-side scoreboard ranked left to right. Fully manual:
  ← → / PageUp PageDown (presenter clickers), space or Enter for next, Home/End to jump to the
  first slide or the scoreboard, F for fullscreen, or tap the screen. The scoreboard slide
  is public. A dock in the top-right corner shows the "Vote" and "Submit" QR codes on every slide
  (each disappears when that action is closed). While submissions are open
  the deck starts with a "Scan to submit" slide (QR + live list of what has come in). In Links
  mode the per-candidate slides are replaced by a store-style **Games** grid of covers (uploaded
  cover image, or a generated poster from the title), 12 per page — the presenter can click any
  cover to open the game in a new tab — and the scoreboard becomes a ranked leaderboard, one row
  per game with its cover as an icon. Public, no
  login. Voters get a link to it after submitting. Only the tallies are exposed — admin routes
  still need the password.
- **One vote per device** — on by default; toggle off for kiosk/shared-tablet voting.
- **Clear device locks** — lets everyone vote again without touching the tally.
- **Reset all votes** — zeroes every candidate, clears ballots and device locks.

## Tests

With the server running, `npm test` exercises login, candidate CRUD, the exact-count rule
and device locking against it. The device-lock cases send the id as BOTH a cookie and a
JSON field, the way a browser does — testing with curl alone once hid a bug where that
looked like a repeat vote and every browser ballot was rolled back.

## Stale tabs

Every API response carries the running build id. A tab left open across a deploy notices the
mismatch and handles it per page: the scoreboard reloads itself silently, the vote page
reloads only while no selection is in progress, and the admin panel shows a "newer version"
banner with a Reload button rather than interrupting an edit.

## Links mode (game jams, demos)

1. Admin sets **Participants submit → Links** and shows the Submit QR (or the projector's first slide).
2. Participants scan, enter their name, game name, a link to play it and (optionally) a cover image.
3. Everyone scans the single **Vote** QR: `/vote` is the game library — each card has a ▶ Play
   button that opens the game, and tapping the card picks it for the ballot.
4. Same ballot rules, device locking and scoreboard as picture voting.

The link must be an `http(s)` URL reachable from the participants' phones.

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
