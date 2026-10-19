// Rebuilds worker/src/airports.json (IATA code to airport name) from iata.csv:
//   node scripts/airports.mjs
// The output matches what the original PowerShell one-liner wrote byte for byte, so a
// regenerated file only differs where iata.csv does.

import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const [header, ...rows] = parseCsv(readFileSync(new URL("iata.csv", root), "utf8"));
const iataCol = header.indexOf("iata");
const airportCol = header.indexOf("airport");

// Keyed by lower case because the PowerShell version used an ordered hashtable, which
// ignores case: a later row replaces the name but keeps the first row's key and position.
const map = new Map();
for (const row of rows) {
  const iata = row[iataCol];
  const airport = row[airportCol];
  if (!iata || !airport) continue;
  const name = airport.replace(/\s*\([^)]*\)\s*$/, "");
  const existing = map.get(iata.toLowerCase());
  map.set(iata.toLowerCase(), { key: existing?.key ?? iata, name });
}

const json = `{${[...map.values()].map(({ key, name }) => `${psString(key)}:${psString(name)}`).join(",")}}`;
writeFileSync(new URL("worker/src/airports.json", root), json);

// Windows PowerShell's ConvertTo-Json also escapes < > & and ' as \u00XX.
function psString(s) {
  return JSON.stringify(s).replace(/[<>&']/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function parseCsv(text) {
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { record.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += c;
  }
  if (field || record.length) { record.push(field); records.push(record); }
  return records;
}
