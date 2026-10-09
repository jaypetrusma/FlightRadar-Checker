/*  THIS WORKER IS DESIGNED TO GET THE DESTINATION OF FLIGHTS THAT FLY OVER MY HOUSE
    BC I HAVE AN INATE DESIRE TO KNOW — now serverless, so the PC can stay off.  */

import airports from "./airports.json"; // ICAO -> [IATA, name]

// Keep these in sync with "triggers.crons" in wrangler.jsonc. All are UTC and cover both AEST and AEDT;
// each job also gates itself on local time, so the extra hours are no-ops.
const POLL_CRON = "* 0-12,20-23 * * *";   // local 7am-11pm: poll the sky
const SUMMARY_CRON = "*/5 12-13 * * *";   // local 11pm: daily wrap-up (retries every 5 min if Discord fails)
const WEEKLY_CRON = "*/5 20-21 * * SUN";  // local Monday 7am: weekly scoreboard + credit report

const AVATAR_URL = "https://jaypetrusma.com/android-chrome-512x512.png"; // JP mark, shared across Jay's projects
const FETCH_TIMEOUT_MS = 10_000;
const FAILURES_BEFORE_WARN = 5;
const KEEP_SIGHTINGS_DAYS = 90;
const MAX_POSITION_AGE_S = 60;
const AIRLINE_CALLSIGN = /^[A-Z]{3}\d/; // ICAO airline callsigns (QFA432); GA regos rarely have an FR24 route
const FR24_PROD = "https://fr24api.flightradar24.com";
const ADSB_PROD = "https://api.adsb.lol";
const ADSBDB_PROD = "https://api.adsbdb.com";
const UA = "flightradar-checker (personal, non-commercial)";

// FR24 credits: https://fr24api.flightradar24.com/docs/credit-overview (empty result = 1 credit)
const CREDITS_POSITIONS_FULL = 8;
const CREDITS_SUMMARY_LIGHT = 1;

export default {
  async scheduled(controller, env, ctx) {
    const jobs = { [POLL_CRON]: [pollMinute], [SUMMARY_CRON]: [dailySummary], [WEEKLY_CRON]: [weeklyReports] };
    // Unknown cron string (local testing, or wrangler.jsonc edited): run everything; each job self-gates.
    const run = jobs[controller.cron] ?? [pollMinute, dailySummary, weeklyReports];
    ctx.waitUntil(runJobs(env, run));
  },
};

async function runJobs(env, run) {
  // Retired from STOP_ON (local date, YYYY-MM-DD) onwards: no polling, no reports, no credits used.
  if (env.STOP_ON && localTime(env.TIMEZONE).date >= env.STOP_ON) return;
  for (const job of run) await job(env);
}

// ---------- polling ----------

// One cron tick a minute; poll several times inside it. Waiting doesn't count toward CPU time,
// and cron invocations may run for up to 15 minutes of wall time.
export async function pollMinute(env) {
  const { hour } = localTime(env.TIMEZONE);
  if (hour < Number(env.ACTIVE_START) || hour >= Number(env.ACTIVE_END)) return;

  const interval = Math.min(60, Math.max(10, Number(env.POLL_INTERVAL_SECONDS) || 30));
  const start = Date.now();
  for (let offset = 0; offset < 60; offset += interval) {
    const wait = start + offset * 1000 - Date.now();
    if (wait < 0 && offset > 0) continue; // a slow poll overran this slot
    if (wait > 0) await sleep(wait);
    // Paid FR24 fallback at most once a minute.
    await pollOnce(env, { allowFr24Fallback: offset === 0 });
  }
}

export async function pollOnce(env, { allowFr24Fallback }) {
  const bounds = parseBounds(env.BOUNDS);
  let aircraft = await fetchAdsbLol(env, bounds);
  if (!aircraft) {
    if (!allowFr24Fallback) return;
    aircraft = await fetchFr24Positions(env);
    if (!aircraft) return;
  }
  aircraft = aircraft.filter((a) => inBounds(a, bounds));
  if (aircraft.length === 0) return;

  const today = localTime(env.TIMEZONE).date;
  const now = Date.now();
  const inserted = await env.DB.batch(
    aircraft.map((a) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO sightings (day, aircraft, seen_at, callsign) VALUES (?, ?, ?, ?) RETURNING rowid"
      ).bind(today, a.key, now, a.callsign || null)
    )
  );
  const fresh = aircraft
    .map((a, i) => ({ ...a, rowid: inserted[i].results[0]?.rowid }))
    .filter((a) => a.rowid !== undefined);
  if (fresh.length === 0) return;

  const credits = await creditTracker(env, today);
  for (const a of fresh) {
    if (!a.routeKnown) Object.assign(a, await lookupRoute(env, a, credits));
  }

  const results = await env.DB.batch(
    fresh.flatMap((a) => [
      env.DB.prepare("UPDATE sightings SET dest = ? WHERE day = ? AND aircraft = ?").bind(a.destIcao || null, today, a.key),
      env.DB.prepare("SELECT COUNT(*) AS n FROM sightings WHERE day = ? AND rowid <= ?").bind(today, a.rowid),
    ])
  );
  const lines = fresh.map((a, i) => buildMessage(a, results[i * 2 + 1].results[0].n));
  await postWebhook(env.WEBHOOK_URL, lines);
}

async function fetchAdsbLol(env, b) {
  const lat = ((b.north + b.south) / 2).toFixed(4);
  const lon = ((b.west + b.east) / 2).toFixed(4);
  // Radius that covers the whole box; inBounds() trims back to the box afterwards.
  const radiusNm = Math.max(1, Math.ceil(distanceNm(b.north, b.west, b.south, b.east) / 2));
  const base = devOverride(env.ADSB_BASE, ADSB_PROD);
  try {
    const res = await fetchWithTimeout(`${base}/v2/point/${lat}/${lon}/${radiusNm}`, {
      headers: { "Accept": "application/json", "User-Agent": UA },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    await clearFailures(env, "adsb");
    return (body.ac ?? [])
      .filter((ac) => ac.lat != null && ac.lon != null && ac.alt_baro !== "ground" && (ac.seen_pos ?? 0) <= MAX_POSITION_AGE_S)
      .map((ac) => {
        const callsign = (ac.flight ?? "").trim();
        return {
          key: `${ac.hex}:${callsign}`,
          hex: ac.hex,
          callsign,
          type: ac.t,
          reg: ac.r,
          alt: typeof ac.alt_baro === "number" ? ac.alt_baro : null,
          track: ac.track ?? null,
          lat: ac.lat,
          lon: ac.lon,
        };
      });
  } catch (err) {
    console.error(`adsb.lol poll failed: ${err}`);
    await recordFailure(env, "adsb", `⚠️ FlightRadar checker: adsb.lol has failed ${FAILURES_BEFORE_WARN}+ times in a row (${err}). Falling back to FR24 polling, which uses credits.`);
    return null;
  }
}

// Paid fallback when adsb.lol is down: same data as before, capped so one poll can't burn the month.
async function fetchFr24Positions(env) {
  const today = localTime(env.TIMEZONE).date;
  const credits = await creditTracker(env, today);
  if (!(await credits.canSpend(CREDITS_POSITIONS_FULL))) return null;
  const rows = await fr24Get(env, "/api/live/flight-positions/full", { bounds: env.BOUNDS, limit: "15" }, CREDITS_POSITIONS_FULL, credits);
  return rows?.map((f) => ({
    key: `${(f.hex ?? f.fr24_id).toLowerCase()}:${(f.callsign ?? "").trim()}`,
    hex: f.hex,
    callsign: (f.callsign ?? "").trim(),
    flight: f.flight,
    type: f.type,
    reg: f.reg,
    alt: f.alt,
    track: f.track,
    lat: f.lat,
    lon: f.lon,
    origIcao: f.orig_icao,
    destIcao: f.dest_icao,
    routeKnown: true,
  })) ?? null;
}

// Route for a newly seen aircraft: FR24 flight summary (1 credit), then adsbdb (free, static routes).
async function lookupRoute(env, a, credits) {
  if (!AIRLINE_CALLSIGN.test(a.callsign)) return {};

  if (await credits.canSpend(CREDITS_SUMMARY_LIGHT)) {
    const now = Date.now();
    const rows = await fr24Get(env, "/api/flight-summary/light", {
      callsigns: a.callsign,
      flight_datetime_from: fr24Datetime(now - 18 * 3600 * 1000),
      flight_datetime_to: fr24Datetime(now),
      sort: "desc",
      limit: "1",
    }, CREDITS_SUMMARY_LIGHT, credits);
    const f = rows?.[0];
    if (f && (f.orig_icao || f.dest_icao)) {
      return {
        flight: f.flight,
        type: a.type || f.type,
        reg: a.reg || f.reg,
        origIcao: f.orig_icao,
        destIcao: f.dest_icao_actual || f.dest_icao,
      };
    }
  }
  return await adsbdbRoute(env, a);
}

async function adsbdbRoute(env, a) {
  try {
    const base = devOverride(env.ADSBDB_BASE, ADSBDB_PROD);
    const res = await fetchWithTimeout(`${base}/v0/callsign/${encodeURIComponent(a.callsign)}`, { headers: { "User-Agent": UA } });
    if (!res.ok) return {};
    const route = (await res.json()).response?.flightroute;
    const { origin, destination } = route ?? {};
    if (!origin || !destination || a.track == null) return {};
    // adsbdb stores one direction per callsign; trust it only if the aircraft is heading that way.
    const headingTo = (ap) => angleDiff(a.track, bearing(a.lat, a.lon, ap.latitude, ap.longitude)) < 90;
    const flight = route.callsign_iata || undefined;
    if (headingTo(destination)) return { flight, origIcao: origin.icao_code, destIcao: destination.icao_code };
    if (headingTo(origin)) return { flight, origIcao: destination.icao_code, destIcao: origin.icao_code };
  } catch (err) {
    console.error(`adsbdb lookup failed for ${a.callsign}: ${err}`);
  }
  return {};
}

function buildMessage(a, count) {
  const ident = escapeMd(a.flight || a.callsign || a.reg || a.hex || "Unknown aircraft");
  const craft = [a.type, a.reg].filter(Boolean).map(escapeMd).join(", ");
  let msg = `**${ident}**${craft ? ` (${craft})` : ""} overhead`;
  if (a.alt > 0) msg += ` at ${a.alt.toLocaleString("en-AU")} ft`;

  const orig = airportName(a.origIcao);
  const dest = airportName(a.destIcao);
  if (orig || dest) {
    msg += ` — ${orig ?? "unknown origin"} → ${dest ?? "unknown destination"}`;
  } else {
    msg += " — destination unknown";
  }
  msg += ` — #${count} today`;
  return msg;
}

function airportName(icao) {
  if (!icao) return null;
  const entry = airports[icao];
  return entry ? `${entry[1]} (${entry[0] || icao})` : icao;
}

// ---------- reports ----------

export async function dailySummary(env) {
  const { date: today, hour } = localTime(env.TIMEZONE);
  if (hour < Number(env.ACTIVE_END)) return;
  const claim = `daily-summary:${today}`;
  if (!(await claimOnce(env, claim))) return;

  const [countRes, topRes, recordRes] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM sightings WHERE day = ?").bind(today),
    env.DB.prepare("SELECT dest, COUNT(*) AS n FROM sightings WHERE day = ? GROUP BY dest ORDER BY n DESC, dest LIMIT 3").bind(today),
    env.DB.prepare("SELECT day, count FROM daily_counts WHERE day != ? ORDER BY count DESC, day LIMIT 1").bind(today),
  ]);
  const count = countRes.results[0].n;
  const top3 = topRes.results;
  const prev = recordRes.results[0];

  const medals = ["🥇", "🥈", "🥉"];
  let msg = `@everyone ✈️ **Daily wrap-up** — **${count}** flight${count !== 1 ? "s" : ""} flew overhead today.`;
  if (top3.length > 0) {
    msg += "\nTop destinations:";
    top3.forEach((row, i) => {
      msg += `\n${medals[i]} ${row.dest ? airportName(row.dest) : "Unknown destination"} — ${row.n}`;
    });
  }
  if (count > 0 && count > (prev?.count ?? 0)) {
    msg += prev
      ? `\n\n🏆 **New record!** ${count} flights beats the previous best of ${prev.count} set on ${prev.day}.`
      : `\n\n🏆 **New record!** ${count} flights — the highest day so far!`;
  }

  const cutoff = localTime(env.TIMEZONE, new Date(Date.now() - KEEP_SIGHTINGS_DAYS * 86_400_000)).date;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO daily_counts (day, count) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET count = excluded.count").bind(today, count),
    env.DB.prepare("DELETE FROM sightings WHERE day < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM credits WHERE day < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM claims WHERE claimed_at < datetime('now', ?)").bind(`-${KEEP_SIGHTINGS_DAYS} days`),
  ]);

  if (!(await postWebhook(env.LEADERBOARD_WEBHOOK_URL, [msg], { mentionEveryone: true }))) await releaseClaim(env, claim);
}

export async function weeklyReports(env) {
  const { date: today, hour, weekday } = localTime(env.TIMEZONE);
  // Monday = 1, first tick at or after 7am
  if (weekday !== 1 || hour < 7) return;
  await weeklyScoreboard(env, today);
  await weeklyCreditReport(env, today);
}

async function weeklyScoreboard(env, today) {
  const claim = `weekly-scoreboard:${today}`;
  if (!(await claimOnce(env, claim))) return;

  const { results } = await env.DB.prepare("SELECT day, count FROM daily_counts ORDER BY count DESC, day LIMIT 10").all();
  if (results.length === 0) return;

  const medals = ["🥇", "🥈", "🥉"];
  let msg = `@everyone 🏆 **Weekly scoreboard — Top 10 days**`;
  results.forEach(({ day, count }, i) => {
    msg += `\n${i < 3 ? medals[i] : `${i + 1}.`} ${day} — ${count} flight${count !== 1 ? "s" : ""}`;
  });
  if (!(await postWebhook(env.LEADERBOARD_WEBHOOK_URL, [msg], { mentionEveryone: true }))) await releaseClaim(env, claim);
}

async function weeklyCreditReport(env, today) {
  const claim = `weekly-credit-report:${today}`;
  if (!(await claimOnce(env, claim))) return;

  const maxCredits = Number(env.MAX_MONTHLY_CREDITS || 0);
  let used30d, used7d;
  try {
    [used30d, used7d] = await Promise.all([fetchUsageCredits(env, "30d"), fetchUsageCredits(env, "7d")]);
  } catch (err) {
    console.error(`Credit usage check failed: ${err}`);
    await releaseClaim(env, claim);
    return;
  }

  const avgDaily = used7d / 7;
  const projected30d = avgDaily * 30;

  let msg = `📊 **Weekly credit check** — ~${Math.round(used30d).toLocaleString("en-AU")} credits used in the last 30 days`;
  if (maxCredits > 0) {
    const remaining = maxCredits - used30d;
    msg += ` of ${maxCredits.toLocaleString("en-AU")} (~${Math.round(remaining).toLocaleString("en-AU")} remaining).`;
  } else {
    msg += ".";
  }
  msg += `\nThis week's average: ~${Math.round(avgDaily).toLocaleString("en-AU")} credits/day.`;

  if (maxCredits > 0) {
    if (projected30d > maxCredits) {
      msg += `\n⚠️ At this week's rate (~${Math.round(projected30d).toLocaleString("en-AU")} credits per 30 days), the plan's ${maxCredits.toLocaleString("en-AU")}-credit limit may run out before the month is up.`;
    } else {
      msg += `\n✅ At this week's rate, usage is on track to stay within the ${maxCredits.toLocaleString("en-AU")}-credit limit.`;
    }
  }
  if (!(await postWebhook(env.LEADERBOARD_WEBHOOK_URL, [msg]))) await releaseClaim(env, claim);
}

async function fetchUsageCredits(env, period) {
  const res = await fetchWithTimeout(`${devOverride(env.FR24_BASE, FR24_PROD)}/api/usage?period=${period}`, { headers: fr24Headers(env) });
  if (!res.ok) throw new Error(`FR24 usage API returned ${res.status} for period=${period}`);
  const rows = (await res.json()).data ?? [];
  return rows.reduce((sum, row) => sum + (row.credits ?? 0), 0);
}

// ---------- FR24 + credit budget ----------

function fr24Headers(env) {
  return { "Accept": "application/json", "Accept-Version": "v1", "Authorization": `Bearer ${env.FR24_TOKEN}` };
}

async function fr24Get(env, path, params, creditsPerRow, credits) {
  const url = `${devOverride(env.FR24_BASE, FR24_PROD)}${path}?${new URLSearchParams(params)}`;
  let res;
  try {
    res = await fetchWithTimeout(url, { headers: fr24Headers(env) });
  } catch (err) {
    console.error(`FR24 request failed: ${err}`);
    await recordFailure(env, "fr24", `⚠️ FlightRadar checker: FR24 has failed ${FAILURES_BEFORE_WARN}+ times in a row (${err}).`);
    return null;
  }
  if (!res.ok) {
    console.error(`FR24 API error ${res.status}: ${await res.text()}`);
    if (res.status === 401 || res.status === 403) {
      await warnOnce(env, "fr24-auth", `⚠️ FlightRadar checker: FR24 rejected the API token (${res.status}). Routes will come from adsbdb only until it's replaced.`);
    } else if (res.status === 402 || res.status === 429) {
      await warnOnce(env, "fr24-credits", `⚠️ FlightRadar checker: FR24 API returned ${res.status} — credits may be exhausted or rate limited.`);
    } else {
      await recordFailure(env, "fr24", `⚠️ FlightRadar checker: FR24 has returned errors ${FAILURES_BEFORE_WARN}+ times in a row (latest ${res.status}).`);
    }
    return null;
  }
  const rows = (await res.json()).data ?? [];
  await credits.spend(Math.max(1, rows.length * creditsPerRow));
  await clearFailures(env, "fr24");
  return rows;
}

// Daily circuit breaker: stop spending FR24 credits once today's estimate passes the budget.
async function creditTracker(env, today) {
  const budget = Number(env.DAILY_CREDIT_BUDGET) || Math.floor(Number(env.MAX_MONTHLY_CREDITS || 30000) / 30);
  let used = null;
  return {
    async canSpend(n) {
      if (used === null) {
        used = (await env.DB.prepare("SELECT used FROM credits WHERE day = ?").bind(today).first("used")) ?? 0;
      }
      if (used + n <= budget) return true;
      await warnOnce(env, "credit-budget", `⚠️ FlightRadar checker: today's FR24 budget of ${budget} credits is used up. Routes fall back to adsbdb until midnight.`);
      return false;
    },
    async spend(n) {
      used = (used ?? 0) + n;
      await env.DB.prepare("INSERT INTO credits (day, used) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET used = used + excluded.used")
        .bind(today, n).run();
    },
  };
}

// ---------- D1 helpers ----------

// D1 is strongly consistent, so exactly one run wins each claim (KV couldn't guarantee that).
async function claimOnce(env, name) {
  const { meta } = await env.DB.prepare("INSERT OR IGNORE INTO claims (name) VALUES (?)").bind(name).run();
  return meta.changes === 1;
}

async function releaseClaim(env, name) {
  await env.DB.prepare("DELETE FROM claims WHERE name = ?").bind(name).run();
}

async function warnOnce(env, kind, content) {
  if (await claimOnce(env, `warn:${kind}:${localTime(env.TIMEZONE).date}`)) {
    await postWebhook(env.LEADERBOARD_WEBHOOK_URL, [content]);
  }
}

async function recordFailure(env, source, warning) {
  const streak = await env.DB.prepare(
    "INSERT INTO failures (source, streak) VALUES (?, 1) ON CONFLICT (source) DO UPDATE SET streak = streak + 1 RETURNING streak"
  ).bind(source).first("streak");
  if (streak >= FAILURES_BEFORE_WARN) await warnOnce(env, `${source}-down`, warning);
}

async function clearFailures(env, source) {
  await env.DB.prepare("UPDATE failures SET streak = 0 WHERE source = ? AND streak > 0").bind(source).run();
}

// ---------- Discord ----------

// Sends lines as few messages as possible (Discord caps content at 2,000 chars). Returns true if all sent.
async function postWebhook(url, lines, { mentionEveryone = false } = {}) {
  const chunks = [];
  for (const line of lines) {
    const last = chunks.length - 1;
    if (last >= 0 && chunks[last].length + line.length + 1 <= 1900) chunks[last] += `\n${line}`;
    else chunks.push(line);
  }
  let allOk = true;
  for (const content of chunks) {
    const body = JSON.stringify({
      content,
      avatar_url: AVATAR_URL,
      allowed_mentions: { parse: mentionEveryone ? ["everyone"] : [] },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await fetchWithTimeout(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      } catch (err) {
        console.error(`Webhook failed: ${err}`);
        allOk = false;
        break;
      }
      if (res.status === 429 && attempt === 0) {
        const retryAfter = Number((await res.json().catch(() => ({}))).retry_after) || 1;
        await sleep(Math.min(retryAfter, 10) * 1000);
        continue;
      }
      if (!res.ok) {
        console.error(`Webhook error ${res.status}: ${await res.text()}`);
        allOk = false;
      }
      break;
    }
  }
  return allOk;
}

function escapeMd(s) {
  return String(s).replace(/[\\*_~`|>[\]()]/g, "\\$&");
}

// ---------- utilities ----------

function fetchWithTimeout(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

// Base-URL overrides are for local mocks only; never send the FR24 token anywhere else.
function devOverride(value, prod) {
  if (!value) return prod;
  const { hostname } = new URL(value);
  if (hostname === "localhost" || hostname === "127.0.0.1") return value.replace(/\/$/, "");
  console.error(`Ignoring non-local base URL override ${hostname}`);
  return prod;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBounds(s) {
  const [north, south, west, east] = String(s).split(",").map(Number);
  if ([north, south, west, east].some(Number.isNaN)) throw new Error("BOUNDS must be north,south,west,east");
  return { north, south, west, east };
}

function inBounds(a, b) {
  return a.lat <= b.north && a.lat >= b.south && a.lon >= b.west && a.lon <= b.east;
}

const toRad = (d) => (d * Math.PI) / 180;

function distanceNm(lat1, lon1, lat2, lon2) {
  const h = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(h));
}

function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function fr24Datetime(ms) {
  return new Date(ms).toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS, UTC
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formatters = new Map();

export function localTime(timeZone, now = new Date()) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-AU", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
    });
    formatters.set(timeZone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(now).map(({ type, value }) => [type, value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: DAY_NAMES.indexOf(p.weekday),
  };
}
