// Stand-ins for what the Workers runtime provides, so run() can be driven from node --test.

export function fakeKv(initial = {}) {
  const data = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    data,
    async get(key, type) {
      const value = data.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      data.set(key, value);
    },
    json(key) {
      return data.has(key) ? JSON.parse(data.get(key)) : undefined;
    },
  };
}

// routes maps a URL prefix to a handler that returns a Response or throws.
export function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
    const prefix = Object.keys(routes).find((p) => url.startsWith(p));
    if (!prefix) throw new Error(`Unexpected fetch ${url}`);
    return routes[prefix](url, init);
  };
  return { fetch, calls };
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function testEnv(kv) {
  return {
    STATE: kv,
    TIMEZONE: "Australia/Sydney",
    ACTIVE_START: "7",
    ACTIVE_END: "23",
    POLL_EVERY_N_MINUTES: "1",
    MAX_MONTHLY_CREDITS: "30000",
    FR24_TOKEN: "token",
    BOUNDS: "-33,-34,150,151",
    FR24_BASE: "https://fr24.test",
    WEBHOOK_URL: "https://hook.test/alerts",
    LEADERBOARD_WEBHOOK_URL: "https://hook.test/leaderboard",
  };
}
