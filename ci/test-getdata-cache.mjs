// Self-check for the getData hand-off between ci/refresh-data-ci.mjs and ci/scrape-forecasts.mjs
// (ci/getdata-cache.mjs). Run: node ci/test-getdata-cache.mjs
// What must hold: off by default, single-use, never throws, never changes WHICH tickers the
// forecast step processes, and both scripts are actually wired to it.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachePath, cachedFirst, saveGetData, takeGetData } from "./getdata-cache.mjs";

const dir = join(mkdtempSync(join(tmpdir(), "getdata-")), "nested");
try {
  // off unless a directory is named
  assert.equal(saveGetData(undefined, "AAPL", "{}"), false, "no dir -> no write");
  assert.equal(takeGetData(undefined, "AAPL"), null, "no dir -> no hit");
  assert.deepEqual(cachedFirst(["A", "B"], null), ["A", "B"], "no dir -> order untouched");

  // round trip is byte-identical, and single-use
  const body = '<html><pre>{"ticker":"BRK.B","experts":[{"name":"x &amp; y"}]}</pre></html>';
  assert.equal(saveGetData(dir, "BRK.B", body), true, "creates the dir and writes");
  assert.equal(takeGetData(dir, "BRK.B"), body, "same bytes back");
  assert.equal(takeGetData(dir, "BRK.B"), null, "second read misses — one use per run");
  assert.equal(existsSync(cachePath(dir, "BRK.B")), false, "entry deleted on read");

  // odd tickers stay inside the dir; empty bodies are not cached
  saveGetData(dir, "A/B", "{}");
  assert.ok(cachePath(dir, "A/B").startsWith(dir + "/") && !cachePath(dir, "A/B").slice(dir.length + 1).includes("/"));
  assert.equal(takeGetData(dir, "A/B"), "{}");
  assert.equal(saveGetData(dir, "E", ""), false, "empty body is not a cache entry");
  assert.equal(saveGetData(dir, "E", undefined), false, "missing body is not a cache entry");

  // an unwritable dir degrades to false, never throws (the backfill row must survive)
  assert.equal(saveGetData("/dev/null/nope", "X", "{}"), false);
  assert.equal(takeGetData("/dev/null/nope", "X"), null);

  // reordering: cached first, both groups keep their order, same set
  saveGetData(dir, "C", "{}"); saveGetData(dir, "E2", "{}");
  const targets = ["HOT", "A", "C", "D", "E2"];
  const q = cachedFirst(targets, dir);
  assert.deepEqual(q, ["C", "E2", "HOT", "A", "D"]);
  assert.deepEqual([...q].sort(), [...targets].sort(), "no ticker added or dropped");
} finally {
  rmSync(join(dir, ".."), { recursive: true, force: true });
}

// both scripts are wired to the same env var, and the forecast step still fetches live on a miss
const refresh = readFileSync(new URL("./refresh-data-ci.mjs", import.meta.url), "utf8");
const fc = readFileSync(new URL("./scrape-forecasts.mjs", import.meta.url), "utf8");
assert.match(refresh, /saveGetData\(process\.env\.GETDATA_CACHE, t, sol\.response\)/, "refresh writes the raw body");
assert.match(fc, /process\.env\.GETDATA_CACHE/, "forecasts reads the same env var");
assert.match(fc, /takeGetData\(CACHE, t\)/, "forecasts consults the cache");
assert.match(fc, /data \?\?= extractJson\(await flareGet\(`https:\/\/www\.tipranks\.com\/api\/stocks\/getData\/\?name=/,
  "a miss or unusable entry still fetches live");
// the cache write must sit AFTER the row is kept, so a failed write cannot drop it
assert.ok(refresh.indexOf("seen.set(t, row); refreshed++;") < refresh.indexOf("saveGetData("), "row kept before caching");
console.log("getdata-cache: ok");
