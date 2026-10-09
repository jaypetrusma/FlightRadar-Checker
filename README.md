# FlightRadar Checker

Alerts a webhook (e.g. Discord) whenever a flight passes over my house, with the good stuff included:

> **QF432** (B738, VH-VYK) overhead at 35,000 ft — Sydney Airport (SYD) → Melbourne Airport (MEL) — #12 today

The `#12 today` counter tracks flights alerted since midnight Sydney time and resets nightly.

Runs entirely on **Cloudflare Workers free tier**, so no machine at home needs to be on. Every 30 seconds during active hours the worker checks the free [adsb.lol](https://adsb.lol) API for aircraft inside the box, records each new one in D1, looks up its route (FR24, 1 credit), and posts to the webhook.

`FR24DestScript.ps1` is the original manual PowerShell version, kept for reference.

## One-time setup

Prereqs: [Node.js LTS](https://nodejs.org) (`winget install OpenJS.NodeJS.LTS`) and a free [Cloudflare account](https://dash.cloudflare.com/sign-up).

> **Note:** npm struggles on the Google Drive mount (`I:`). You don't need `npm install`: `npx wrangler@4.149.0` runs from the npm cache on `C:`. If `deploy` ever fails with filesystem errors, copy the `worker/` folder to a local disk and run from there. The version is pinned on purpose (supply chain); bump it deliberately.

```powershell
cd worker
npx wrangler@4.149.0 login                          # opens browser OAuth
npx wrangler@4.149.0 d1 create flightradar-checker  # prints a database_id for wrangler.jsonc
npx wrangler@4.149.0 d1 execute flightradar-checker --remote --file schema.sql

npx wrangler@4.149.0 secret put FR24_TOKEN               # FR24 API bearer token
npx wrangler@4.149.0 secret put BOUNDS                   # bounding box "north,south,west,east"
npx wrangler@4.149.0 secret put WEBHOOK_URL              # Discord webhook URL for per-flight alerts
npx wrangler@4.149.0 secret put LEADERBOARD_WEBHOOK_URL  # Discord webhook URL for leaderboards and warnings

npx wrangler@4.149.0 deploy
```

That's it, it's live. Watch it run with `npx wrangler@4.149.0 tail`.

## Configuration knobs (`worker/wrangler.jsonc`)

| Var | Default | Meaning |
|---|---|---|
| `TIMEZONE` | `Australia/Sydney` | Local zone for active hours, the wrap-up and the weekly posts |
| `ACTIVE_START` | `7` | First local hour (inclusive) polling runs |
| `ACTIVE_END` | `23` | Local hour (exclusive) polling stops and the wrap-up posts, i.e. 7am to 11pm |
| `POLL_INTERVAL_SECONDS` | `30` | adsb.lol poll interval, 10 to 60. Free, so it costs no credits |
| `MAX_MONTHLY_CREDITS` | `30000` | Your FR24 plan's allowance. Used by the weekly credit report and the daily budget |
| `DAILY_CREDIT_BUDGET` | `MAX_MONTHLY_CREDITS / 30` | Optional. FR24 calls stop for the day once the estimate passes this |
| `STOP_ON` | `2026-10-31` | Local date (`YYYY-MM-DD`) from which the worker does nothing at all. Remove it to run indefinitely |

The cron schedules are in UTC and cover both AEST and AEDT. If you change `ACTIVE_START`/`ACTIVE_END` or `TIMEZONE`, update `triggers.crons` and the matching `*_CRON` constants at the top of `src/index.js`.

Redeploy after changing: `npx wrangler@4.149.0 deploy`.

## FR24 credit budget

FR24 charges 1 credit for an empty result, 8 per flight from live positions (full) and 1 per flight from flight summary (light). See the [credit overview](https://fr24api.flightradar24.com/docs/credit-overview).

The worker no longer polls FR24 to find aircraft, so there are no empty-poll charges. Credits are spent only on:

- **Route lookups**: one flight summary call per new airline flight (callsigns like `QFA432`), about 1 credit each, so roughly 2,000 credits a month at ~66 flights a day. Light aircraft and helicopters are skipped and show as "destination unknown".
- **Fallback polling**: if adsb.lol is down, the worker polls FR24 live positions (full) once a minute instead, with `limit=15` so a single call can't run away. This costs what the old setup did, until adsb.lol recovers.

If FR24 has no route, the worker tries [adsbdb](https://www.adsbdb.com) (free). adsbdb stores one direction per callsign, so its answer is used only when the aircraft's track points towards that destination (or the reverse).

Every FR24 call is tallied in D1. Once a day's estimate passes `DAILY_CREDIT_BUDGET`, FR24 calls stop until midnight and a warning is posted. Also turn off (or cap) automatic top-up in the FR24 dashboard so a bug can't spend money.

Warnings go to the leaderboard webhook, at most once a day each:

- FR24 rejected the token (401/403)
- credits exhausted or rate limited (402/429)
- FR24 or adsb.lol failing 5+ times in a row
- daily credit budget reached

Every Monday the worker also posts a credit report from FR24's `/api/usage` endpoint: credits used in the last 30 days, how much of `MAX_MONTHLY_CREDITS` that leaves, that week's daily average, and whether the current rate is projected to stay within the limit. FR24's usage windows are rolling (last 7/30 days), not calendar-month, so treat it as a close approximation.

## How the worker behaves

- Three crons: one every minute during active hours (which polls every `POLL_INTERVAL_SECONDS` inside that minute), one for the 11pm wrap-up, and one for the Monday 7am posts. Nothing runs overnight.
- All state is in D1 (see `schema.sql`), which is strongly consistent. Overlapping or late cron runs can't double-alert a flight or double-post the wrap-up and weekly posts: each is claimed with an `INSERT OR IGNORE` before it's sent. If Discord fails, the claim is released and the next tick retries.
- An aircraft (ICAO hex + callsign) alerts once per local day, however long it stays in the box.
- Aircraft on the ground, or with a position older than 60 s, are ignored.
- All new flights from one poll go out as one Discord message, and a 429 from Discord is retried once after `retry_after`.
- Sightings and credit tallies are kept for 90 days; daily totals for the scoreboard are kept forever.

## Security notes

- Secrets (`FR24_TOKEN`, `BOUNDS`, both webhook URLs) live only in Worker secrets. `BOUNDS` is secret because it gives away where I live; alert timings could still narrow that down, so keep the Discord server private.
- The worker has no HTTP handler, and `workers_dev`/`preview_urls` are off, so it has no public URL.
- `FR24_BASE`, `ADSB_BASE` and `ADSBDB_BASE` are honoured only when they point at `localhost`/`127.0.0.1`, so a stray production var can't send the FR24 token elsewhere.
- Webhook posts set `allowed_mentions` (only the leaderboard posts can ping `@everyone`) and escape Discord markdown in aircraft data.
- Every outbound request has a 10 s timeout.
- The Cloudflare API token used for deploys should be scoped to Workers Scripts and D1 on this account only.

## Local testing (no credits, no real webhook)

Create `worker/.dev.vars` (gitignored):

```
FR24_TOKEN=dummy
BOUNDS=-33.80,-33.95,151.00,151.20
WEBHOOK_URL=http://127.0.0.1:9321/webhook              # or a real webhook for a live test
LEADERBOARD_WEBHOOK_URL=http://127.0.0.1:9321/webhook  # or a separate real webhook for a live test
FR24_BASE=http://127.0.0.1:9321                        # omit to hit the real FR24 API
ADSB_BASE=http://127.0.0.1:9321                        # omit to hit the real adsb.lol API
ADSBDB_BASE=http://127.0.0.1:9321                      # omit to hit the real adsbdb API
```

Then:

```powershell
cd worker
npx wrangler@4.149.0 d1 execute flightradar-checker --local --file schema.sql
npx wrangler@4.149.0 dev --test-scheduled --var TIMEZONE:UTC   # pick a zone where it's currently active hours
# in another terminal (cron strings must match wrangler.jsonc; anything else runs every job):
curl "http://127.0.0.1:8787/__scheduled?cron=*+0-12,20-23+*+*+*"
```

The base-URL overrides let you point the worker at a mock server; leave them unset in production.

## Regenerating `worker/src/airports.json`

The map is keyed by ICAO code, with `[IATA, name]` values. If `iata.csv` is updated:

```powershell
$map = [ordered]@{}
Import-Csv .\iata.csv | Where-Object { $_.icao -and $_.airport } |
  ForEach-Object { $map[$_.icao] = @($_.iata, ($_.airport -replace '\s*\([^)]*\)\s*$', '')) }
[IO.File]::WriteAllText("$PWD\worker\src\airports.json",
  ($map | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding $false))
```
