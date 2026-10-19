import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/index.js";
import { fakeKv, fakeFetch, json, testEnv } from "./helpers.js";

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

// Tuesday 20 October 2026, 10:00 in Sydney: inside active hours, not a Monday.
const TUESDAY_10AM = Date.parse("2026-10-19T23:00:00Z");

test("a failed webhook post still saves the alerts that went out", async () => {
  mock.timers.enable({ apis: ["Date"], now: TUESDAY_10AM });
  const kv = fakeKv();
  let posts = 0;
  const { fetch } = fakeFetch({
    "https://fr24.test/api/live/": () =>
      json({ data: [{ fr24_id: "a", flight: "QF1" }, { fr24_id: "b", flight: "QF2" }] }),
    "https://hook.test/alerts": () => {
      posts++;
      if (posts === 2) throw new TypeError("fetch failed");
      return new Response(null, { status: 204 });
    },
  });
  mock.method(globalThis, "fetch", fetch);
  mock.method(console, "error", () => {});

  await run(testEnv(kv));

  const state = kv.json("state");
  assert.ok(state, "state was saved");
  assert.ok(state.alerted.a, "the posted flight is remembered, so it does not alert again");
  assert.equal(state.alerted.b, undefined, "the failed flight is left to retry on the next poll");
  assert.equal(state.count, 1);
});
