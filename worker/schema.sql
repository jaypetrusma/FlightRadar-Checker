-- D1 schema. Apply with: npx wrangler@4.149.0 d1 execute flightradar-checker --remote --file schema.sql
-- (use --local instead of --remote for `wrangler dev`). Safe to re-run.

-- One row per job that must only happen once (daily summary, weekly posts, warnings).
CREATE TABLE IF NOT EXISTS claims (
  name TEXT PRIMARY KEY,
  claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per aircraft per local day; the primary key is the dedup.
CREATE TABLE IF NOT EXISTS sightings (
  day TEXT NOT NULL,          -- local date, YYYY-MM-DD
  aircraft TEXT NOT NULL,     -- "<hex>:<callsign>"
  seen_at INTEGER NOT NULL,   -- epoch ms of first sighting
  callsign TEXT,
  dest TEXT,                  -- destination ICAO, NULL if unknown
  PRIMARY KEY (day, aircraft)
);

-- Final count per day, for records and the weekly scoreboard. Kept forever.
CREATE TABLE IF NOT EXISTS daily_counts (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);

-- Estimated FR24 credits spent per local day, for the daily budget.
CREATE TABLE IF NOT EXISTS credits (
  day TEXT PRIMARY KEY,
  used INTEGER NOT NULL DEFAULT 0
);

-- Consecutive failures per upstream ("adsb", "fr24").
CREATE TABLE IF NOT EXISTS failures (
  source TEXT PRIMARY KEY,
  streak INTEGER NOT NULL DEFAULT 0
);
