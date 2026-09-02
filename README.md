# FlightRadar Checker

Alerts a webhook (e.g. Discord) whenever a flight passes over my house, with the good stuff included:

> **QF432** (B738, VH-VYK) overhead at 35,000 ft — Sydney Airport (SYD) → Melbourne Airport (MEL), ETA 2:32 pm — #12 today

The `#12 today` counter tracks flights alerted since midnight Sydney time and resets nightly.

Runs entirely on **Cloudflare Workers free tier** — no machine at home needs to be on. A cron trigger fires every minute; the worker polls the FR24 API during active hours, deduplicates via Workers KV so each flight alerts once, and posts to the webhook.

`FR24DestScript.ps1` is the original manual PowerShell version, kept for reference.

## One-time setup

Prereqs: [Node.js LTS](https://nodejs.org) (`winget install OpenJS.NodeJS.LTS`) and a free [Cloudflare account](https://dash.cloudflare.com/sign-up).

> **Note:** npm struggles on the Google Drive mount (`I:`). You don't need `npm install` — `npx wrangler@4` runs from the npm cache on `C:`. If `deploy` ever fails with filesystem errors, copy the `worker/` folder to a local disk and run from there.

```powershell
cd worker
npx wrangler@4 login                          # opens browser OAuth
npx wrangler@4 kv namespace create STATE      # prints an id
# → paste that id into wrangler.jsonc replacing REPLACE_WITH_KV_NAMESPACE_ID

npx wrangler@4 secret put FR24_TOKEN               # FR24 API bearer token
npx wrangler@4 secret put BOUNDS                   # bounding box "north,south,west,east"
npx wrangler@4 secret put WEBHOOK_URL              # Discord webhook URL for per-flight alerts
npx wrangler@4 secret put LEADERBOARD_WEBHOOK_URL  # Discord webhook URL for daily/weekly leaderboards

npx wrangler@4 deploy
```

That's it — it's live. Watch it run with `npx wrangler@4 tail`.

## Configuration knobs (`worker/wrangler.jsonc`)

| Var | Default | Meaning |
|---|---|---|
| `TIMEZONE` | `Australia/Sydney` | Local zone for active hours and ETA formatting |
| `ACTIVE_START` | `7` | First local hour (inclusive) polling runs |
| `ACTIVE_END` | `23` | Local hour (exclusive) polling stops — i.e. 7am–11pm |
| `POLL_EVERY_N_MINUTES` | `1` | Raise to 2 or 3 if FR24 credits run tight |
| `MAX_MONTHLY_CREDITS` | `30000` | Your FR24 plan's monthly credit allowance — used only for the weekly credit report below |

Redeploy after changing: `npx wrangler@4 deploy`.

## FR24 credit budget

FR24 charges per result: **1 credit** for an empty poll, **~8 credits per flight** returned (and a flight still in the box next poll is charged again). At 60 s × 16 h/day that's ~28,800 credits/month baseline — tight against the Explorer plan's 30,000. Check usage in the [FR24 API dashboard](https://fr24api.flightradar24.com) after the first day or two; if it's trending over, set `POLL_EVERY_N_MINUTES = "2"` (halves the baseline to ~14,400) or narrow the active hours.

If credits run out, the FR24 API returns 402/429 — the worker sends a warning to the leaderboard webhook (at most once per day) so exhaustion doesn't go silent.

Every Monday (same tick as the weekly scoreboard) the worker also posts a credit report to the leaderboard webhook, pulled from FR24's own `/api/usage` endpoint: credits used in the last 30 days, how much of `MAX_MONTHLY_CREDITS` that leaves, that week's daily average, and whether the current rate is projected to stay within the limit or run out early. FR24's usage windows are rolling (last 7/30 days), not calendar-month, so treat it as a close approximation rather than an exact billing-period figure.

## How the worker behaves

- Cron fires every minute (UTC); the worker exits before calling FR24 outside active hours, so overnight costs nothing.
- Every flight in the FR24 response is alerted (not just the first), with graceful fallbacks — a VFR putterer with no flight plan shows as `✈️ **SPTR12** overhead at 4,500 ft — destination unknown`.
- Dedup state lives in KV under one key: a flight re-alerts only if it's still/again overhead **45+ minutes** after its last alert (`REALERT_AFTER_MS` in `src/index.js`).

## Local testing (no credits, no real webhook)

Create `worker/.dev.vars` (gitignored):

```
FR24_TOKEN=dummy
BOUNDS=-33.0,-34.0,150.0,151.0
WEBHOOK_URL=http://127.0.0.1:9321/webhook              # or a real webhook for a live test
LEADERBOARD_WEBHOOK_URL=http://127.0.0.1:9321/webhook  # or a separate real webhook for a live test
FR24_BASE=http://127.0.0.1:9321                        # omit to hit the real FR24 API
```

Then:

```powershell
cd worker
npx wrangler@4 dev --test-scheduled
# in another terminal:
curl "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*"
```

`FR24_BASE` lets you point the worker at a mock server; leave it unset in production (it defaults to the real API).

## Regenerating `worker/src/airports.json`

If `iata.csv` is updated:

```powershell
$map = [ordered]@{}
Import-Csv .\iata.csv | Where-Object { $_.iata -and $_.airport } |
  ForEach-Object { $map[$_.iata] = ($_.airport -replace '\s*\([^)]*\)\s*$', '') }
[IO.File]::WriteAllText("$PWD\worker\src\airports.json",
  ($map | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding $false))
```
