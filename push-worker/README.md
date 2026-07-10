# RWC background push worker

Sends real background alerts to your phone for the special alarm and the
default TNCA/TNCB/TNCC significant-weather notification — **even when the
dashboard app is fully closed**. This is a separate small service from the
GitHub Pages site, because a static site has no way to run code when nobody
has it open; this Worker is the piece that runs on a schedule instead.

It duplicates the same detection logic already in `index.html`
(`hasNotifyWx`, the per-station gust alarm) so behavior matches what you see
in the app, and reads the same per-station Settings you configure in the
dashboard's ⚙ Settings panel (synced to this worker when you enable
background alerts).

## What you need

- A free Cloudflare account (Workers Free plan covers this comfortably).
- EITHER nothing else (dashboard-only deploy, see next section) OR
  Node.js + `npx wrangler` for the CLI route further below.

## Deploy without any tools (browser dashboard only)

Everything happens at https://dash.cloudflare.com — works from a phone.

1. **Create the KV store**: Storage & Databases → **KV** → *Create namespace*
   → name it `PUSH_KV`.
2. **Create the Worker**: Workers & Pages → *Create* → **Create Worker** →
   name it `rwc-weather-push` → *Deploy* (it deploys a hello-world first).
3. **Paste the code**: on the new Worker click **Edit code**, delete the
   hello-world, paste the full contents of `push-worker/src/worker.js`
   (open it on GitHub → Raw → select all → copy) → **Deploy**.
4. **Bind the KV store**: Worker → Settings → **Bindings** → *Add* →
   KV namespace → Variable name `PUSH_KV` → pick the namespace from step 1.
5. **Variables & secrets** (Worker → Settings → Variables & Secrets):
   | Name | Type | Value |
   |---|---|---|
   | `ALLOWED_ORIGIN` | Text | `https://gnius21.github.io` |
   | `VAPID_SUBJECT` | Text | `mailto:your@email` |
   | `VAPID_PUBLIC_KEY` | Text | the public key from `wrangler.toml` |
   | `VAPID_PRIVATE_KEY_JWK` | **Secret** | the private JWK JSON (provided out-of-band — never commit it) |
   | `SHARED_SECRET` | Secret | optional, any random string |
6. **Cron**: Worker → Settings → **Triggers** → Cron Triggers → *Add* →
   `*/5 * * * *`.
7. Copy the Worker URL from its overview page
   (`https://rwc-weather-push.<your-subdomain>.workers.dev`) and set it as
   `PUSH_WORKER_URL` in `index.html`.

Steps 4–6 require a re-deploy? No — dashboard changes apply immediately.
Note: when deploying via the dashboard, `wrangler.toml` is ignored; all
settings must be entered in the UI as above.

## One-time setup (CLI route)

```bash
cd push-worker
npx wrangler login                      # opens a browser to authorize

npx wrangler kv namespace create PUSH_KV
# copy the returned "id" into wrangler.toml -> kv_namespaces[0].id
```

Edit `wrangler.toml`:
- `kv_namespaces[0].id` → the id from the command above.
- `ALLOWED_ORIGIN` → your GitHub Pages origin (already set to
  `https://gnius21.github.io`; change if different).
- `VAPID_SUBJECT` → replace with `mailto:you@example.com` (any real-ish
  contact URI; push services only use it if they need to reach you about
  abuse/quota issues).
- `VAPID_PUBLIC_KEY` is already filled in — it's the public half of a key
  pair generated for this project and is safe to publish.

Set the **private** half as a secret (never put this in a file — Claude gave
you this value in chat, not in any committed file):

```bash
npx wrangler secret put VAPID_PRIVATE_KEY_JWK
# paste the JWK JSON string when prompted, then press Enter
```

Optional but recommended — a shared secret so randoms can't spam your
`/subscribe` endpoint. Pick any random string and set it both here and in
`index.html` (see below):

```bash
npx wrangler secret put SHARED_SECRET
```

## Deploy

```bash
npx wrangler deploy
```

This prints your Worker's URL, e.g. `https://rwc-weather-push.YOUR-SUBDOMAIN.workers.dev`.

## Wire it into the dashboard

In `index.html`, set:

```js
const PUSH_WORKER_URL = 'https://rwc-weather-push.YOUR-SUBDOMAIN.workers.dev';
const PUSH_SHARED_SECRET = ''; // fill in if you set SHARED_SECRET above
```

(These already exist as placeholders near the notification code — search for
`PUSH_WORKER_URL`.) Commit and push that change to `main` so the live site
points at your deployed Worker.

## Using it

Open the dashboard on your phone → ⚙ Settings → turn on **Background alerts**
(below Browser notifications). It registers your device with the Worker and
from then on:

- TNCA/TNCB/TNCC reporting RA/SHRA/TS/TSRA always notifies (matches the
  in-app default).
- Any station with its per-station gust alarm enabled notifies per your
  configured threshold.
- Runs every 5 minutes via Cron Trigger, whether or not the app is open.

Saving Settings again re-syncs your per-station thresholds to the Worker.

## Costs

Workers Free plan: 100,000 requests/day and Cron Triggers included, KV Free
plan: 100,000 reads + 1,000 writes/day. A personal dashboard with a cron
every 5 minutes (~288 runs/day) and a handful of devices stays far inside
all of these — this should cost $0.

## Troubleshooting

- `wrangler tail` — stream live logs from the deployed Worker to see cron
  runs and any push-send errors.
- If a subscription returns HTTP 404/410 from the push service (e.g. you
  uninstalled the app), the Worker automatically removes it on the next run.
- iOS requires the dashboard to be **installed to the Home Screen**
  (Share → Add to Home Screen) and iOS 16.4+ before push subscriptions work
  at all — this matches the existing in-app notification requirement.
