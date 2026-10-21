// GitHub HTTP client: REST GET, GraphQL POST, paginated search, and one
// rate-limit policy shared by all three.
//
// GitHub answers 403 or 429 for three different reasons, and the right wait
// differs for each, so the response is read rather than guessed at:
//   - primary budget spent: x-ratelimit-remaining is 0 and x-ratelimit-reset
//     says when it refills (search has its own small budget, 30/min);
//   - secondary limit (bursts, concurrency): retry-after when present, else the
//     body says "secondary rate limit" and the documented wait is a minute;
//   - anything else with those status codes (a real 403) is not a rate limit
//     and must not be retried into a spin.
const https = require("https");

const TOKEN = process.env.GITHUB_TOKEN || "";
const MAX_RETRIES = 4;
const SECONDARY_WAIT_SEC = 60;
const MAX_WAIT_SEC = 180;
// Search is 30 requests per minute and counts bursts harshly; a short gap
// between consecutive searches keeps a run of ten well inside it.
const SEARCH_GAP_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Decide how to treat a 403/429. Pure: takes the status, headers and body and
// returns { retry: false, reason } or { retry: true, waitSec, reason }.
// `nowSec` is injectable for tests.
function rateLimitPolicy(status, headers, body, retriesLeft, nowSec = Math.floor(Date.now() / 1000)) {
  const h = headers || {};
  const text = typeof body === "string" ? body : "";
  const retryAfter = parseInt(h["retry-after"], 10);
  const remaining = parseInt(h["x-ratelimit-remaining"], 10);
  const reset = parseInt(h["x-ratelimit-reset"], 10);
  const secondary = /secondary rate limit|abuse detection/i.test(text);
  const primary = remaining === 0 || /API rate limit exceeded/i.test(text);

  if (!secondary && !primary && !(retryAfter > 0) && status !== 429) {
    return { retry: false, reason: `HTTP ${status} is not a rate limit` };
  }
  if (retriesLeft <= 0) return { retry: false, reason: "out of retries" };

  let waitSec;
  let reason;
  if (retryAfter > 0) {
    waitSec = retryAfter;
    reason = "retry-after";
  } else if (primary && reset > 0) {
    waitSec = Math.max(1, reset - nowSec + 1);
    reason = `primary budget, resets in ${waitSec}s`;
  } else if (secondary) {
    waitSec = SECONDARY_WAIT_SEC;
    reason = "secondary limit";
  } else {
    waitSec = Math.pow(2, MAX_RETRIES - retriesLeft + 1);
    reason = "backoff";
  }
  return { retry: true, waitSec: Math.min(waitSec, MAX_WAIT_SEC), reason };
}

function baseHeaders() {
  const headers = { "User-Agent": "PersonalDashboard/1.0", Accept: "application/vnd.github+json" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  return headers;
}

// One HTTPS round trip; resolves { status, headers, body } with body as text.
function roundTrip(url, options, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Retry wrapper used by request() and graphql(): applies rateLimitPolicy to
// 403/429 and surfaces the server's own explanation when giving up.
async function withRateLimit(label, send) {
  let retries = MAX_RETRIES;
  for (;;) {
    const res = await send();
    if (res.status !== 403 && res.status !== 429) return res;
    const verdict = rateLimitPolicy(res.status, res.headers, res.body, retries);
    const detail = (res.body || "").replace(/\s+/g, " ").slice(0, 160);
    if (!verdict.retry) {
      throw new Error(`${label}: HTTP ${res.status} (${verdict.reason}) remaining=${res.headers["x-ratelimit-remaining"] ?? "?"} ${detail}`);
    }
    console.warn(`${label}: rate limited (${res.status}, ${verdict.reason}); waiting ${verdict.waitSec}s, ${retries - 1} retries left. ${detail}`);
    await sleep(verdict.waitSec * 1000);
    retries--;
  }
}

async function request(url) {
  const res = await withRateLimit(`GET ${url.slice(0, 80)}`, () => roundTrip(url, { method: "GET", headers: baseHeaders() }));
  if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  try {
    return { body: JSON.parse(res.body), headers: res.headers };
  } catch (e) {
    throw new Error(`Invalid JSON from ${url.slice(0, 80)}: ${e.message}`);
  }
}

async function graphql(query, variables) {
  const payload = JSON.stringify({ query, variables });
  const headers = { ...baseHeaders(), "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
  const res = await withRateLimit("GraphQL", () => roundTrip("https://api.github.com/graphql", { method: "POST", headers }, payload));
  if (res.status >= 400) throw new Error(`GraphQL HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (e) {
    throw new Error(`Invalid GraphQL JSON: ${e.message}`);
  }
  if (parsed.errors) throw new Error(`GraphQL errors: ${JSON.stringify(parsed.errors).slice(0, 200)}`);
  return parsed.data;
}

let lastSearchAt = 0;

// Every page of a search, newest first. Consecutive searches are spaced by
// SEARCH_GAP_MS so a run of them stays under the search API's own limit.
async function searchAll(query) {
  const items = [];
  const perPage = 100;
  const maxPages = 10;
  for (let page = 1; page <= maxPages; page++) {
    const gap = lastSearchAt + SEARCH_GAP_MS - Date.now();
    if (gap > 0) await sleep(gap);
    lastSearchAt = Date.now();
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}&sort=updated&order=desc`;
    const { body } = await request(url);
    items.push(...body.items);
    if (body.items.length < perPage) break;
  }
  return items;
}

module.exports = { request, graphql, searchAll, sleep, rateLimitPolicy, MAX_RETRIES, SECONDARY_WAIT_SEC, MAX_WAIT_SEC, SEARCH_GAP_MS };
