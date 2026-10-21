// GitHub HTTP client: REST GET, GraphQL POST, paginated search.
const https = require("https");

const TOKEN = process.env.GITHUB_TOKEN || "";
const MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function request(url, retries = MAX_RETRIES) {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent": "PersonalDashboard/1.0",
      Accept: "application/vnd.github+json",
    };
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

    https
      .get(url, { headers }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", async () => {
          if (res.statusCode === 403 || res.statusCode === 429) {
            if (retries > 0) {
              const retryAfter = res.headers["retry-after"];
              const waitSec = retryAfter ? parseInt(retryAfter, 10) : Math.pow(2, MAX_RETRIES - retries + 1);
              console.warn(`Rate limited (${res.statusCode}). Retrying in ${waitSec}s... (${retries} retries left)`);
              await sleep(waitSec * 1000);
              resolve(request(url, retries - 1));
              return;
            }
            reject(new Error(`Rate limited (${res.statusCode}) after ${MAX_RETRIES} retries: ${url.slice(0, 80)}`));
            return;
          }
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve({ body: JSON.parse(body), headers: res.headers });
          } catch (e) {
            reject(new Error(`Invalid JSON from ${url.slice(0, 80)}: ${e.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

async function graphql(query, variables, retries = MAX_RETRIES) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ query, variables });
    const headers = {
      "User-Agent": "PersonalDashboard/1.0",
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    };
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

    const req = https.request(
      "https://api.github.com/graphql",
      { method: "POST", headers },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", async () => {
          if ((res.statusCode === 403 || res.statusCode === 429) && retries > 0) {
            const retryAfter = res.headers["retry-after"];
            const waitSec = retryAfter ? parseInt(retryAfter, 10) : Math.pow(2, MAX_RETRIES - retries + 1);
            console.warn(`GraphQL rate limited (${res.statusCode}). Retrying in ${waitSec}s... (${retries} left)`);
            await sleep(waitSec * 1000);
            resolve(graphql(query, variables, retries - 1));
            return;
          }
          if (res.statusCode >= 400) {
            reject(new Error(`GraphQL HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            const parsed = JSON.parse(body);
            if (parsed.errors) {
              reject(new Error(`GraphQL errors: ${JSON.stringify(parsed.errors).slice(0, 200)}`));
              return;
            }
            resolve(parsed.data);
          } catch (e) {
            reject(new Error(`Invalid GraphQL JSON: ${e.message}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function searchAll(query) {
  const items = [];
  let page = 1;
  const perPage = 100;
  const maxPages = 10;

  while (page <= maxPages) {
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}&sort=updated&order=desc`;
    const { body } = await request(url);
    items.push(...body.items);
    if (body.items.length < perPage) break;
    page++;
  }
  return items;
}

module.exports = { request, graphql, searchAll, sleep };
