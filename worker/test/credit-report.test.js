import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/index.js";
import { fakeKv, fakeFetch, json, testEnv } from "./helpers.js";

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

// Monday 19 October 2026, 8:00 in Sydney: the weekly reports are due.
const MONDAY_8AM = Date.parse("2026-10-18T21:00:00Z");

test("a failed usage check is tried once a Monday and warned about", async () => {
  mock.timers.enable({ apis: ["Date"], now: MONDAY_8AM });
  const kv = fakeKv();
  const { fetch, calls } = fakeFetch({
    "https://fr24.test/api/usage": () => json({ message: "down" }, 500),
    "https://fr24.test/api/live/": () => json({ data: [] }),
    "https://hook.test/leaderboard": () => new Response(null, { status: 204 }),
  });
  mock.method(globalThis, "fetch", fetch);
  mock.method(console, "error", () => {});
  const env = testEnv(kv);

  await run(env);
  mock.timers.tick(60 * 1000);
  await run(env);

  const usageCalls = calls.filter((c) => c.url.includes("/api/usage"));
  assert.equal(usageCalls.length, 2, "one 30d and one 7d call, not repeated the next minute");
  assert.equal(kv.json("state").creditReportDate, "2026-10-19");
  const warnings = calls.filter((c) => c.url === env.LEADERBOARD_WEBHOOK_URL);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].body.content, /credit usage check failed/i);
});
