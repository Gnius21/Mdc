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

## Easiest path: ntfy (recommended)

Skip all the Web-Push/VAPID machinery. Install the **ntfy** app
(App Store / Play Store), tap **+ Subscribe to topic**, and enter:

- Topic: `rwc-abc-wx-4f49205af5`
- Server: `ntfy.sh` (default)

That's it for the phone. Alerts arrive two ways:

1. **From any open dashboard** — already live; whenever an alarm triggers in
   an open instance of the dashboard (your PC at work, a tablet, anywhere),
   it publishes to the topic and your phone gets a native push.
2. **Fully closed everywhere** — deploy this Worker with just three steps
   (no secrets needed for ntfy-only): paste the code, bind KV, set the
   `NTFY_TOPIC` var (already in wrangler.toml) and the cron trigger. Skip
   every VAPID/secret step below.

Note: ntfy.sh topics are open — anyone who knows the exact topic string can
subscribe or post to it. The random suffix keeps it obscure; if that ever
bothers you, rotate the topic or self-host ntfy with auth.

## Deploy with GitHub Actions (recommended — browser only)

The repo ships a workflow (`.github/workflows/deploy-worker.yml`) that
deploys this Worker for you. One-time setup, all in the browser:

1. Cloudflare dashboard → My Profile → **API Tokens** → *Create Token* →
   use the **"Edit Cloudflare Workers"** template and add the permission
   **Account / Workers KV Storage / Edit**. Copy the token.
2. Cloudflare dashboard → Workers & Pages → copy your **Account ID**
   (right sidebar).
3. GitHub repo → Settings → **Secrets and variables → Actions** → add:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
4. GitHub repo → **Actions** tab → *Deploy push worker* → **Run workflow**.

The workflow creates the KV namespace itself, injects its id, and deploys
with the cron trigger. Because `NTFY_TOPIC` is preconfigured, **background
ntfy alerts are live immediately after the first successful run** — no
VAPID keys, no secrets, no `PUSH_WORKER_URL` needed. It also redeploys
automatically whenever `push-worker/` changes on `main`.

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
