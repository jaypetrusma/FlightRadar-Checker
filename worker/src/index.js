/*  THIS WORKER IS DESIGNED TO GET THE DESTINATION OF FLIGHTS THAT FLY OVER MY HOUSE
    BC I HAVE AN INATE DESIRE TO KNOW — now serverless, so the PC can stay off.  */

import airports from "./airports.json";

const STATE_KEY = "state";
const REALERT_AFTER_MS = 45 * 60 * 1000; // don't re-alert the same flight within 45 min
const CREDIT_WARN_EVERY_MS = 24 * 60 * 60 * 1000;

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(run(env));
  },
};

export async function run(env) {
  const { hour, minute } = localTime(env.TIMEZONE);
  if (hour < Number(env.ACTIVE_START) || hour >= Number(env.ACTIVE_END)) return;
  if (minute % Number(env.POLL_EVERY_N_MINUTES) !== 0) return;

  const base = env.FR24_BASE || "https://fr24api.flightradar24.com";
  const res = await fetch(
    `${base}/api/live/flight-positions/full?bounds=${encodeURIComponent(env.BOUNDS)}`,
    {
      headers: {
        "Accept": "application/json",
        "Accept-Version": "v1",
        "Authorization": `Bearer ${env.FR24_TOKEN}`,
      },
    }
  );

  if (!res.ok) {
    console.error(`FR24 API error ${res.status}: ${await res.text()}`);
    if (res.status === 402 || res.status === 429) {
      await warnOnce(env, `⚠️ FlightRadar checker: FR24 API returned ${res.status} — credits may be exhausted or rate limited.`);
    }
    return;
  }

  const flights = (await res.json()).data ?? [];
  if (flights.length === 0) return;

  const state = (await env.STATE.get(STATE_KEY, "json")) ?? { alerted: {}, lastCreditWarn: 0 };
  const now = Date.now();
  let changed = prune(state.alerted, now);

  const today = localDate(env.TIMEZONE);
  if (state.countDate !== today) {
    state.count = 0;
    state.countDate = today;
    changed = true;
  }

  for (const f of flights) {
    if (state.alerted[f.fr24_id] && now - state.alerted[f.fr24_id] < REALERT_AFTER_MS) continue;
    state.alerted[f.fr24_id] = now;
    state.count = (state.count ?? 0) + 1;
    changed = true;
    await sendWebhook(env, buildMessage(f, env.TIMEZONE, state.count));
  }

  if (changed) await env.STATE.put(STATE_KEY, JSON.stringify(state));
}

function buildMessage(f, timeZone, count) {
  const ident = f.flight || f.callsign || f.reg || f.hex || "Unknown aircraft";

  const craft = [f.type, f.reg].filter(Boolean).join(", ");
  let msg = `**${ident}**${craft ? ` (${craft})` : ""} overhead`;
  if (f.alt > 0) msg += ` at ${f.alt.toLocaleString("en-AU")} ft`;

  const orig = airportName(f.orig_iata);
  const dest = airportName(f.dest_iata);
  if (orig || dest) {
    msg += ` — ${orig ?? "unknown origin"} → ${dest ?? "unknown destination"}`;
  } else {
    msg += " — destination unknown";
  }

  if (f.eta) {
    const eta = new Date(f.eta).toLocaleTimeString("en-AU", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    });
    msg += `, ETA ${eta}`;
  }
  msg += ` — #${count} today`;
  return msg;
}

function airportName(iata) {
  if (!iata) return null;
  const name = airports[iata];
  return name ? `${name} (${iata})` : iata;
}

async function sendWebhook(env, content) {
  const res = await fetch(env.WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) console.error(`Webhook error ${res.status}: ${await res.text()}`);
}

async function warnOnce(env, content) {
  const state = (await env.STATE.get(STATE_KEY, "json")) ?? { alerted: {}, lastCreditWarn: 0 };
  if (Date.now() - (state.lastCreditWarn ?? 0) < CREDIT_WARN_EVERY_MS) return;
  state.lastCreditWarn = Date.now();
  await env.STATE.put(STATE_KEY, JSON.stringify(state));
  await sendWebhook(env, content);
}

function prune(alerted, now) {
  let changed = false;
  for (const [id, ts] of Object.entries(alerted)) {
    if (now - ts >= REALERT_AFTER_MS) {
      delete alerted[id];
      changed = true;
    }
  }
  return changed;
}

function localDate(timeZone) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function localTime(timeZone) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { hour: get("hour") % 24, minute: get("minute") };
}
