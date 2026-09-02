/*  THIS WORKER IS DESIGNED TO GET THE DESTINATION OF FLIGHTS THAT FLY OVER MY HOUSE
    BC I HAVE AN INATE DESIRE TO KNOW — now serverless, so the PC can stay off.  */

import airports from "./airports.json";

const STATE_KEY = "state";
const SCOREBOARD_KEY = "scoreboard";
const REALERT_AFTER_MS = 45 * 60 * 1000; // don't re-alert the same flight within 45 min
const CREDIT_WARN_EVERY_MS = 24 * 60 * 60 * 1000;

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(run(env));
  },
};

export async function run(env) {
  const { hour, minute, weekday } = localTime(env.TIMEZONE);
  await maybeSendWeeklyScoreboard(env, weekday, hour);
  await maybeSendWeeklyCreditReport(env, weekday, hour);
  if (hour < Number(env.ACTIVE_START) || hour >= Number(env.ACTIVE_END)) {
    if (hour >= Number(env.ACTIVE_END)) await maybeSendDailySummary(env);
    return;
  }
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
    state.destinations = {};
    changed = true;
  }

  for (const f of flights) {
    if (state.alerted[f.fr24_id] && now - state.alerted[f.fr24_id] < REALERT_AFTER_MS) continue;
    state.alerted[f.fr24_id] = now;
    state.count = (state.count ?? 0) + 1;
    const destKey = f.dest_iata || "unknown";
    state.destinations = state.destinations ?? {};
    state.destinations[destKey] = (state.destinations[destKey] ?? 0) + 1;
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

async function maybeSendDailySummary(env) {
  const today = localDate(env.TIMEZONE);
  const state = (await env.STATE.get(STATE_KEY, "json")) ?? { alerted: {}, lastCreditWarn: 0 };
  if (state.summaryDate === today) return;

  const count = state.countDate === today ? (state.count ?? 0) : 0;
  const destinations = state.countDate === today ? (state.destinations ?? {}) : {};

  const top3 = Object.entries(destinations)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const medals = ["🥇", "🥈", "🥉"];
  let msg = `@everyone ✈️ **Daily wrap-up** — **${count}** flight${count !== 1 ? "s" : ""} flew overhead today.`;
  if (top3.length > 0) {
    msg += "\nTop destinations:";
    for (let i = 0; i < top3.length; i++) {
      const [iata, n] = top3[i];
      const name = iata === "unknown" ? "Unknown destination" : (airportName(iata) ?? iata);
      msg += `\n${medals[i]} ${name} — ${n}`;
    }
  }

  // Update scoreboard and check for a new record
  const board = (await env.STATE.get(SCOREBOARD_KEY, "json")) ?? {};
  const prevEntries = Object.entries(board).filter(([date]) => date !== today);
  const prevMax = prevEntries.reduce((max, [, n]) => Math.max(max, n), 0);
  const prevMaxDate = prevEntries.find(([, n]) => n === prevMax)?.[0];
  board[today] = count;
  await env.STATE.put(SCOREBOARD_KEY, JSON.stringify(board));

  if (count > 0 && count > prevMax) {
    if (prevMax > 0) {
      msg += `\n\n🏆 **New record!** ${count} flights beats the previous best of ${prevMax} set on ${prevMaxDate}.`;
    } else {
      msg += `\n\n🏆 **New record!** ${count} flights — the highest day so far!`;
    }
  }

  state.summaryDate = today;
  await env.STATE.put(STATE_KEY, JSON.stringify(state));
  await sendLeaderboardWebhook(env, msg);
}

async function maybeSendWeeklyScoreboard(env, weekday, hour) {
  // Monday = 1, fire on the first tick at or after 7am
  if (weekday !== 1 || hour < 7) return;

  const today = localDate(env.TIMEZONE);
  const state = (await env.STATE.get(STATE_KEY, "json")) ?? { alerted: {}, lastCreditWarn: 0 };
  if (state.scoreboardDate === today) return;

  const board = (await env.STATE.get(SCOREBOARD_KEY, "json")) ?? {};
  const entries = Object.entries(board).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (entries.length === 0) return;

  const medals = ["🥇", "🥈", "🥉"];
  let msg = `@everyone 🏆 **Weekly scoreboard — Top 10 days**`;
  for (let i = 0; i < entries.length; i++) {
    const [date, n] = entries[i];
    const prefix = i < 3 ? medals[i] : `${i + 1}.`;
    msg += `\n${prefix} ${date} — ${n} flight${n !== 1 ? "s" : ""}`;
  }

  state.scoreboardDate = today;
  await env.STATE.put(STATE_KEY, JSON.stringify(state));
  await sendLeaderboardWebhook(env, msg);
}

async function maybeSendWeeklyCreditReport(env, weekday, hour) {
  // Monday = 1, fire on the first tick at or after 7am — same cadence as the scoreboard
  if (weekday !== 1 || hour < 7) return;

  const today = localDate(env.TIMEZONE);
  const state = (await env.STATE.get(STATE_KEY, "json")) ?? { alerted: {}, lastCreditWarn: 0 };
  if (state.creditReportDate === today) return;

  const maxCredits = Number(env.MAX_MONTHLY_CREDITS || 0);
  const base = env.FR24_BASE || "https://fr24api.flightradar24.com";

  let used30d, used7d;
  try {
    [used30d, used7d] = await Promise.all([
      fetchUsageCredits(base, env.FR24_TOKEN, "30d"),
      fetchUsageCredits(base, env.FR24_TOKEN, "7d"),
    ]);
  } catch (err) {
    console.error(`Credit usage check failed: ${err}`);
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

  state.creditReportDate = today;
  await env.STATE.put(STATE_KEY, JSON.stringify(state));
  await sendLeaderboardWebhook(env, msg);
}

async function fetchUsageCredits(base, token, period) {
  const res = await fetch(`${base}/api/usage?period=${period}`, {
    headers: {
      "Accept": "application/json",
      "Accept-Version": "v1",
      "Authorization": `Bearer ${token}`,
    },
  });
  if (!res.ok) throw new Error(`FR24 usage API returned ${res.status} for period=${period}`);
  const rows = (await res.json()).data ?? [];
  return rows.reduce((sum, row) => sum + (row.credits ?? 0), 0);
}

async function sendWebhook(env, content) {
  await postWebhook(env.WEBHOOK_URL, content);
}

async function sendLeaderboardWebhook(env, content) {
  await postWebhook(env.LEADERBOARD_WEBHOOK_URL, content);
}

async function postWebhook(url, content) {
  const res = await fetch(url, {
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
  await sendLeaderboardWebhook(env, content);
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

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function localTime(timeZone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const weekdayStr = new Intl.DateTimeFormat("en-AU", { timeZone, weekday: "short" }).format(now);
  return { hour: get("hour") % 24, minute: get("minute"), weekday: DAY_NAMES.indexOf(weekdayStr) };
}
