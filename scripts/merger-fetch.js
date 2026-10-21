// Merger row: project-wide duties for someone with merge rights, over every
// open PR in config.merge_access. Rules live in merger.js; this is the fetch.

const fs = require("fs");
const path = require("path");
const { request, graphql, searchAll } = require("./github.js");
const { GITHUB_USER, MERGE_ACCESS, MERGE_LABELS } = require("./settings.js");
const { mapPR, repoParts, monthWindows } = require("./mappers.js");
const { enrichWithSignals, PR_SIGNALS_LEAN_FRAGMENT } = require("./signals.js");
const { buildMergerSections } = require("./merger.js");

function searchQualifier(entry) {
  return entry.includes("/") ? `repo:${entry}` : `org:${entry}`;
}

// Workflow runs waiting for a maintainer's approval (first-time contributors),
// keyed by head sha. Public for public repos, so the Actions token can read it.
async function fetchWaitingRuns(repoFull) {
  const byHead = new Map();
  for (let page = 1; page <= 5; page++) {
    let body;
    try {
      ({ body } = await request(`https://api.github.com/repos/${repoFull}/actions/runs?status=action_required&per_page=100&page=${page}`));
    } catch (e) { console.warn(`  Failed to list waiting runs for ${repoFull}: ${e.message}`); break; }
    const runs = body.workflow_runs || [];
    for (const r of runs) byHead.set(r.head_sha, (byHead.get(r.head_sha) || 0) + 1);
    if (runs.length < 100) break;
  }
  return byHead;
}

// Who can approve: collaborators with push access when the token may read
// them; otherwise everyone who has ever merged a PR there (from the merged
// scan below), which is public and, over time, the same set.
async function fetchCommitters(repoFull) {
  const logins = new Set();
  try {
    for (let page = 1; page <= 5; page++) {
      const { body } = await request(`https://api.github.com/repos/${repoFull}/collaborators?permission=push&per_page=100&page=${page}`);
      for (const c of body) logins.add(c.login.toLowerCase());
      if (body.length < 100) break;
    }
    return { logins, source: "collaborators" };
  } catch (e) {
    return { logins, source: "" };
  }
}

async function touchesWorkflows(pr) {
  const { owner, name } = repoParts(pr);
  try {
    const { body } = await request(`https://api.github.com/repos/${owner}/${name}/pulls/${pr.number}/files?per_page=100`);
    return body.some((f) => (f.filename || "").startsWith(".github/"));
  } catch (e) { return false; }
}

// All-time merged counter, incrementally maintained. The cache is the previous
// run's output (data/merger-cache.json locally, or the deployed copy on Pages
// in CI, where data/ starts empty). First run walks month-sized windows, since
// a single search caps at 1000 results.
const MERGED_PAGE = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    issueCount pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { number title url mergedAt mergedBy { login } author { login avatarUrl } repository { nameWithOwner } } }
  }
}`;

async function searchMerged(q) {
  const out = [];
  let after = null;
  for (let i = 0; i < 12; i++) {
    const d = await graphql(MERGED_PAGE, { q, after });
    out.push(...(d.search.nodes || []).filter((n) => n && n.mergedAt));
    if (!d.search.pageInfo.hasNextPage) break;
    after = d.search.pageInfo.endCursor;
  }
  return out;
}

// Bump when the cached shape changes; an old cache is discarded and rebuilt.
const MERGER_CACHE_VERSION = 2;

async function loadMergerCache() {
  const local = path.join(__dirname, "..", "data", "merger-cache.json");
  if (fs.existsSync(local)) { try { const c = JSON.parse(fs.readFileSync(local, "utf8")); if (c.version === MERGER_CACHE_VERSION) return c; } catch {} }
  const pages = process.env.DASHBOARD_PAGES_URL || (process.env.GITHUB_REPOSITORY
    ? `https://${process.env.GITHUB_REPOSITORY.split("/")[0]}.github.io/${process.env.GITHUB_REPOSITORY.split("/")[1]}/` : "");
  if (pages) {
    try { const { body } = await request(`${pages}data/merger-cache.json`); if (body && body.version === MERGER_CACHE_VERSION) return body; } catch {}
  }
  return { version: MERGER_CACHE_VERSION, entries: {} };
}

// One history scan per org; `repoFilter` (lowercase owner/repo set, or null
// for the whole org) decides which merges count toward the totals.
async function updateMergedCounter(org, repoFilter, cache) {
  const qual = `org:${org}`;
  const c = cache.entries[org] || { mergers: {}, last_merged_at: "", seen: [], first_mine: "", mine: [] };
  c.mine = c.mine || [];
  let merged = [];
  if (!c.last_merged_at) {
    const first = await graphql(MERGED_PAGE, { q: `${qual} is:pr is:merged sort:created-asc`, after: null });
    const oldest = (first.search.nodes || []).map((n) => n.mergedAt).filter(Boolean).sort()[0];
    if (!oldest) return c;
    console.log(`  Merged history for ${org}: first full scan from ${oldest.slice(0, 7)}...`);
    for (const w of monthWindows(oldest)) merged.push(...(await searchMerged(`${qual} is:pr is:merged merged:${w}`)));
  } else {
    merged = await searchMerged(`${qual} is:pr is:merged merged:>=${c.last_merged_at.slice(0, 10)}`);
  }
  const seen = new Set(c.seen || []);
  for (const m of merged) {
    const key = `${(m.repository || {}).nameWithOwner || ""}#${m.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (m.mergedAt > c.last_merged_at) c.last_merged_at = m.mergedAt;
    if (repoFilter && !repoFilter.has(((m.repository || {}).nameWithOwner || "").toLowerCase())) continue;
    const who = (m.mergedBy || {}).login || "";
    if (!who) continue;
    c.mergers[who] = (c.mergers[who] || 0) + 1;
    if (who.toLowerCase() === GITHUB_USER.toLowerCase()) {
      if (!c.first_mine || m.mergedAt < c.first_mine) c.first_mine = m.mergedAt;
      const repo = ((m.repository || {}).nameWithOwner || "").split("/")[1] || "";
      c.mine.push({ title: m.title, number: m.number, repo, url: m.url, author: (m.author || {}).login || "ghost", avatar: (m.author || {}).avatarUrl || "", closed: m.mergedAt, merged: true, state: "closed" });
    }
  }
  c.mine.sort((a, b) => (a.closed < b.closed ? 1 : -1));
  // Remember what was counted on the boundary day: the next incremental query
  // starts from that day and must not count those again.
  const boundary = c.last_merged_at.slice(0, 10);
  c.seen = [...new Set(merged.filter((m) => m.mergedAt.slice(0, 10) === boundary).map((m) => `${(m.repository || {}).nameWithOwner || ""}#${m.number}`))];
  cache.entries[org] = c;
  return c;
}

async function fetchMergerData() {
  if (MERGE_ACCESS.length === 0) return null;
  console.log(`\nMerger row: ${MERGE_ACCESS.join(", ")}`);
  const t0 = Date.now();
  const lap = (label) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${label}`);
  const cache = await loadMergerCache();
  let allOpen = [];
  const committers = new Set();
  const committerSources = new Set();
  const mergedTotals = { count: 0, since: "", prs: [] };
  for (const entry of MERGE_ACCESS) {
    const items = await searchAll(`${searchQualifier(entry)} is:pr is:open`);
    allOpen.push(...items.map(mapPR));
  }
  lap(`${allOpen.length} open PRs listed`);
  // Merge history once per org, counting only the repos in merge_access.
  const byOrg = new Map();
  for (const entry of MERGE_ACCESS) {
    const org = entry.split("/")[0].toLowerCase();
    if (!byOrg.has(org)) byOrg.set(org, entry.includes("/") ? new Set() : null);
    if (entry.includes("/") && byOrg.get(org)) byOrg.get(org).add(entry.toLowerCase());
  }
  for (const [org, repoFilter] of byOrg) {
    const counter = await updateMergedCounter(org, repoFilter, cache);
    mergedTotals.count += counter.mergers[GITHUB_USER] || 0;
    mergedTotals.prs.push(...(counter.mine || []));
    if (counter.first_mine && (!mergedTotals.since || counter.first_mine < mergedTotals.since)) mergedTotals.since = counter.first_mine;
    // Everyone who has merged here can approve: the fallback and a complement
    // to the collaborator list.
    for (const who of Object.keys(counter.mergers)) committers.add(who.toLowerCase());
    committerSources.add("merge history");
  }
  lap("merge history up to date");
  const repos = [...new Set(allOpen.map((pr) => { const { owner, name } = repoParts(pr); return `${owner}/${name}`; }))];
  const ciWaiting = new Map();
  for (const repoFull of repos) {
    for (const [sha, n] of await fetchWaitingRuns(repoFull)) ciWaiting.set(sha, (ciWaiting.get(sha) || 0) + n);
    const c = await fetchCommitters(repoFull);
    for (const l of c.logins) committers.add(l);
    if (c.source) committerSources.add(c.source);
  }
  lap(`${allOpen.length} open PRs across ${repos.length} repos; ${ciWaiting.size} heads with runs awaiting approval; ${committers.size} committers (${[...committerSources].join(" + ")})`);
  let enriched = await enrichWithSignals(allOpen, "project-wide", PR_SIGNALS_LEAN_FRAGMENT);
  lap("signals fetched");
  const incomplete = enriched.filter((p) => p.signals_missing).length;
  enriched = enriched.filter((p) => !p.signals_missing);
  for (const pr of enriched) {
    if (ciWaiting.has(pr.head_oid)) pr.touches_workflows = await touchesWorkflows(pr);
  }
  lap("workflow-touch checks done");
  const { sections, counts } = buildMergerSections(enriched, { committers, ciWaiting, mergeLabels: MERGE_LABELS, me: GITHUB_USER });
  const outDir = path.join(__dirname, "..", "data");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "merger-cache.json"), JSON.stringify(cache));
  console.log(`  Sections: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}; merged by ${GITHUB_USER}: ${mergedTotals.count}${mergedTotals.since ? ` since ${mergedTotals.since.slice(0, 7)}` : ""}.`);
  if (incomplete) console.warn(`  Merger sections are incomplete: ${incomplete} PRs had no signals (rate limit).`);
  return { entries: MERGE_ACCESS, total_open: allOpen.length, incomplete, repos, counts, sections, committers_source: [...committerSources].join(" + "), merged: mergedTotals };
}
module.exports = { fetchMergerData, fetchWaitingRuns, fetchCommitters, searchQualifier, MERGER_CACHE_VERSION };
