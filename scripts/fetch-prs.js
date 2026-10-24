#!/usr/bin/env node
const https = require("https");
const fs = require("fs");
const path = require("path");

const configPath = path.join(__dirname, "..", "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const GITHUB_USER = process.env.DASHBOARD_USER || config.github_user;
const ORGS = config.orgs || (config.org ? [config.org] : []);
// Orgs or owner/repo entries where the dashboard user can merge. Non-empty
// turns on the merger row: project-wide duties only someone with merge rights
// can do.
const MERGE_ACCESS = config.merge_access || [];
const MERGE_LABELS = config.merge_labels || ["to-be-merged"];
const { buildMergerSections } = require("./merger.js");
const TOKEN = process.env.GITHUB_TOKEN || "";
const MAX_RETRIES = 3;

// Where the previous run's data/prs.json can be read back (the deployed copy
// on Pages). Items whose search-result updated_at has not moved reuse their
// cached activity instead of re-fetching it. Unset: fetch everything.
const PRIOR_DATA_URL = process.env.PRIOR_DATA_URL || "";
// Cached activity older than this is re-fetched even when updated_at has not
// moved, so anything that fails to bump updated_at is wrong for at most this
// long.
const MAX_ACTIVITY_AGE_MS = 6 * 60 * 60 * 1000;
const stats = { rest: 0, graphql: 0 };

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// GitHub answers both "slow down" and "you may not see this" with 403. Only
// the first is worth a retry: a permission 403 (GITHUB_TOKEN reading another
// repo's collaborators) is the same answer every time, and waiting 2/4/8 s
// before each of three identical refusals cost ~2 min per run.
function isRateLimited(statusCode, headers = {}, body = "") {
  if (statusCode === 429) return true;
  if (statusCode !== 403) return false;
  if (headers["retry-after"]) return true;
  if (headers["x-ratelimit-remaining"] === "0") return true;
  return /rate limit|abuse detection/i.test(body || "");
}

function request(url, retries = MAX_RETRIES) {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent": "PersonalDashboard/1.0",
      Accept: "application/vnd.github+json",
    };
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
    stats.rest++;

    https
      .get(url, { headers }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", async () => {
          if (isRateLimited(res.statusCode, res.headers, body)) {
            if (retries > 0) {
              const retryAfter = res.headers["retry-after"];
              // A secondary limit without Retry-After asks for "a few minutes";
              // the 2/4/8 s backoff never outlasts it and the run dies.
              const secondary = /secondary rate limit/i.test(body);
              const waitSec = retryAfter ? parseInt(retryAfter, 10) : secondary ? 60 : Math.pow(2, MAX_RETRIES - retries + 1);
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
    stats.graphql++;

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

function mapPR(item) {
  const repoFull = item.repository_url.split("/");
  const repo = repoFull[repoFull.length - 1];
  const user = item.user || {};

  return {
    title: item.title,
    number: item.number,
    repo,
    url: item.html_url,
    author: user.login || "ghost",
    avatar: user.avatar_url || "",
    created: item.created_at,
    updated: item.updated_at,
    closed: item.closed_at || "",
    comments: item.comments || 0,
    draft: item.draft || false,
    merged: item.pull_request?.merged_at != null,
    labels: (item.labels || []).map((l) => ({
      name: typeof l === "string" ? l : l.name,
      color: typeof l === "string" ? "" : l.color || "",
    })),
  };
}

function mapMention(item) {
  const repoFull = item.repository_url.split("/");
  const repo = repoFull[repoFull.length - 1];
  const user = item.user || {};

  return {
    title: item.title,
    number: item.number,
    repo,
    url: item.html_url,
    author: user.login || "ghost",
    avatar: user.avatar_url || "",
    created: item.created_at,
    updated: item.updated_at,
    is_pr: !!item.pull_request,
    state: item.state,
  };
}

async function fetchForOrg(org) {
  console.log(`\n[${org}] Fetching PRs awaiting review...`);
  const reviewItems = await searchAll(
    `review-requested:${GITHUB_USER} is:pr is:open org:${org}`
  );

  console.log(`[${org}] Fetching open PRs...`);
  const openItems = await searchAll(
    `author:${GITHUB_USER} is:pr is:open org:${org}`
  );

  console.log(`[${org}] Fetching closed PRs...`);
  const closedItems = await searchAll(
    `author:${GITHUB_USER} is:pr is:closed org:${org}`
  );

  console.log(`[${org}] Fetching PRs you reviewed (open)...`);
  const reviewedOpenItems = await searchAll(
    `reviewed-by:${GITHUB_USER} is:pr is:open org:${org} -author:${GITHUB_USER}`
  );

  console.log(`[${org}] Fetching PRs you reviewed (closed)...`);
  const reviewedByItems = await searchAll(
    `reviewed-by:${GITHUB_USER} is:pr is:closed org:${org} -author:${GITHUB_USER}`
  );

  console.log(`[${org}] Fetching mentions...`);
  const mentionItems = await searchAll(
    `mentions:${GITHUB_USER} is:open org:${org} -author:${GITHUB_USER}`
  );

  console.log(`[${org}] Fetching assigned issues...`);
  const assignedIssueItems = await searchAll(
    `assignee:${GITHUB_USER} is:issue is:open org:${org}`
  );

  console.log(`[${org}] Fetching authored issues...`);
  const authoredIssueItems = await searchAll(
    `author:${GITHUB_USER} is:issue is:open org:${org}`
  );

  return { reviewItems, openItems, closedItems, reviewedOpenItems, reviewedByItems, mentionItems, assignedIssueItems, authoredIssueItems };
}

function mapComment(item) {
  const user = item.user || {};
  return {
    author: user.login || "ghost",
    avatar: user.avatar_url || "",
    body: (item.body || "").slice(0, 200),
    created_at: item.created_at,
    type: "comment",
  };
}

function mapReview(item) {
  const user = item.user || {};
  return {
    author: user.login || "ghost",
    avatar: user.avatar_url || "",
    body: (item.body || "").slice(0, 200),
    created_at: item.submitted_at,
    type: "review",
    state: item.state, // APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED
  };
}

function mapCommit(item) {
  const author = item.author || item.committer || {};
  return {
    author: author.login || (item.commit?.author?.name) || "ghost",
    avatar: author.avatar_url || "",
    body: (item.commit?.message || "").split("\n")[0].slice(0, 200),
    created_at: item.commit?.committer?.date || item.commit?.author?.date || "",
    type: "commit",
  };
}

function mapReviewComment(item) {
  const user = item.user || {};
  const path = item.path ? item.path.split("/").pop() : "";
  const prefix = path ? `${path}: ` : "";
  return {
    author: user.login || "ghost",
    avatar: user.avatar_url || "",
    body: (prefix + (item.body || "")).slice(0, 200),
    created_at: item.created_at,
    type: "review-comment",
  };
}

// Plain GET of a public JSON document (the deployed prs.json). Deliberately
// not request(): that attaches the GitHub token, which must not leave
// api.github.com.
function fetchPublicJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "PersonalDashboard/1.0" } }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      })
      .on("error", reject);
  });
}

// Known flaky CI failures, from valkey-daily-dashboard's git-tracked
// flakes.json (config.json `flake_registry`, a URL). The registry's rule is
// that an entry exists only while an issue or fix PR tracks it, so a job that
// matches one is "known, tracked", never "fine". Only job-level entries apply
// here: the registry names them `<job>: unattributed failure`, the parser's
// bucket for a job that failed outside any test (a setup step, a build).
// Test-level entries need the job log parsed and are left to lockkeeper.
const FLAKE_JOB_SUFFIX = ": unattributed failure";

function flakeJobEntries(registry) {
  const out = [];
  for (const e of (registry && registry.entries) || []) {
    if (typeof e.test_name !== "string" || !e.test_name.endsWith(FLAKE_JOB_SUFFIX)) continue;
    if (!e.issue && !e.fix_pr) continue;
    out.push({
      id: e.id || "",
      job: e.test_name.slice(0, -FLAKE_JOB_SUFFIX.length),
      issue: e.issue || null,
      issue_state: e.issue_state || "",
      issue_title: e.issue_title || "",
      fix_pr: e.fix_pr || null,
      fix_sha: e.fix_sha || "",
    });
  }
  return out;
}

// Fails open: no URL, or a registry that cannot be fetched or parsed, gives
// null and the dashboard shows CI exactly as before.
async function loadFlakeRegistry() {
  const url = config.flake_registry;
  if (!url) return null;
  try {
    const registry = await fetchPublicJson(url);
    const jobs = flakeJobEntries(registry);
    console.log(`Flake registry: ${url} (${(registry.entries || []).length} entries, ${jobs.length} job-level)`);
    return { source: url, fetched_at: new Date().toISOString(), jobs };
  } catch (e) {
    console.warn(`  Flake registry unavailable (${e.message}); CI shown without it.`);
    return null;
  }
}

// The previous run's output is the cache. A snapshot for another user or
// another org set is somebody else's dashboard and is discarded.
function priorUsable(prior, user, orgs) {
  if (!prior || typeof prior !== "object") return false;
  if (prior.github_user !== user) return false;
  const a = [...(prior.orgs || [])].sort().join(","), b = [...(orgs || [])].sort().join(",");
  return a === b;
}

function priorIndex(prior) {
  const byUrl = new Map();
  if (!prior) return byUrl;
  for (const list of [prior.reviewing, prior.open_prs, prior.issues, prior.mentions]) {
    for (const item of list || []) if (item && item.url) byUrl.set(item.url, item);
  }
  return byUrl;
}

async function loadPrior() {
  const localPath = path.join(__dirname, "..", "data", "prs.json");
  try {
    if (fs.existsSync(localPath)) {
      console.log(`Prior snapshot: ${localPath}`);
      return JSON.parse(fs.readFileSync(localPath, "utf8"));
    }
    if (PRIOR_DATA_URL) {
      console.log(`Prior snapshot: ${PRIOR_DATA_URL}`);
      return await fetchPublicJson(PRIOR_DATA_URL);
    }
  } catch (e) {
    console.warn(`  No usable prior snapshot (${e.message}); fetching everything.`);
  }
  return null;
}

// Comments, reviews, review comments and commits all bump the search result's
// updated_at, so an item whose updated_at is unchanged since the prior run can
// keep the activity fetched then. The reuse is bounded by MAX_ACTIVITY_AGE_MS
// so a missed bump cannot pin stale activity indefinitely. Returns the cached
// fields or null.
function reuseActivity(prior, item, now = Date.now()) {
  if (!prior || !item || !prior.updated || prior.updated !== item.updated) return null;
  if (!Array.isArray(prior.activity) || !prior.activity_fetched_at) return null;
  if (now - new Date(prior.activity_fetched_at).getTime() > MAX_ACTIVITY_AGE_MS) return null;
  return prior;
}

// CI finishes without touching updated_at, so check-runs are keyed on what the
// GraphQL rollup already reports: same head, same settled verdict, same jobs.
// A rerun flips the rollup through PENDING, which misses and re-fetches.
const SETTLED_ROLLUPS = new Set(["SUCCESS", "FAILURE", "ERROR"]);
function reuseCI(prior, item) {
  if (!prior || !item || !item.head_oid || prior.head_oid !== item.head_oid) return null;
  if (!SETTLED_ROLLUPS.has(item.ci_rollup) || prior.ci_rollup !== item.ci_rollup) return null;
  if (!Array.isArray(prior.ci_jobs)) return null;
  return prior.ci_jobs;
}

async function fetchCIStatus(base, sha) {
  if (!sha) return { ci_jobs: [] };
  try {
    const { body } = await request(`${base}/commits/${sha}/check-runs?per_page=100`);
    const runs = body.check_runs || [];
    if (runs.length === 0) return { ci_jobs: [] };

    const ci_jobs = [];
    for (const run of runs) {
      if (run.status !== "completed") {
        ci_jobs.push({ name: run.name, status: "pending", url: run.html_url || "" });
      } else if (run.conclusion === "success") {
        ci_jobs.push({ name: run.name, status: "success", url: run.html_url || "" });
      } else if (run.conclusion === "failure" || run.conclusion === "timed_out") {
        ci_jobs.push({ name: run.name, status: "failure", url: run.html_url || "" });
      } else if (run.conclusion === "cancelled") {
        // A cancelled lane is neither green nor a real failure: it needs a
        // rerun, not a fix. Kept distinct so it is not reported as either.
        ci_jobs.push({ name: run.name, status: "cancelled", url: run.html_url || "" });
      } else if (run.conclusion === "action_required") {
        // A first-time contributor's workflows do not run until a maintainer
        // approves them. Nothing happens until someone clicks, so this is
        // kept apart from a lane that is merely still running.
        ci_jobs.push({ name: run.name, status: "action_required", url: run.html_url || "" });
      }
      // skip: skipped, neutral, stale
    }
    return { ci_jobs };
  } catch (e) {
    console.warn(`  Failed to fetch CI for ${sha.slice(0, 7)}: ${e.message}`);
    return { ci_jobs: [] };
  }
}

async function fetchActivity(pr, cachedCI = null) {
  const [org, repo] = pr.url.replace("https://github.com/", "").split("/");
  const base = `https://api.github.com/repos/${org}/${repo}`;
  const activity_fetched_at = new Date().toISOString();

  let commits = [], reviews = [], comments = [], reviewComments = [];

  try {
    const { body: c } = await request(`${base}/pulls/${pr.number}/commits?per_page=100`);
    commits = c;
  } catch (e) { console.warn(`  Failed to fetch commits for #${pr.number}: ${e.message}`); }

  try {
    const { body: r } = await request(`${base}/pulls/${pr.number}/reviews?per_page=100`);
    reviews = r;
  } catch (e) { console.warn(`  Failed to fetch reviews for #${pr.number}: ${e.message}`); }

  try {
    const { body: ic } = await request(`${base}/issues/${pr.number}/comments?per_page=100`);
    comments = ic;
  } catch (e) { console.warn(`  Failed to fetch comments for #${pr.number}: ${e.message}`); }

  try {
    const { body: rc } = await request(`${base}/pulls/${pr.number}/comments?per_page=100`);
    reviewComments = rc;
  } catch (e) { console.warn(`  Failed to fetch review comments for #${pr.number}: ${e.message}`); }

  const last_push = commits.length > 0
    ? commits[commits.length - 1].commit?.committer?.date || commits[commits.length - 1].commit?.author?.date || ""
    : "";

  // CI status from head commit
  const headSha = commits.length > 0 ? commits[commits.length - 1].sha : "";
  const ci = cachedCI ? { ci_jobs: cachedCI } : await fetchCIStatus(base, headSha);

  const activity = [
    ...commits.map(mapCommit),
    ...reviews.filter(r => r.state !== "PENDING" && r.body && r.body.trim()).map(mapReview),
    ...comments.map(mapComment),
    ...reviewComments.map(mapReviewComment),
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return { last_push, activity, activity_fetched_at, ...ci, ...botVerdict(comments, headSha, last_push) };
}

// The repository's review bot posts one "Review state" comment per PR, marked
// `<!-- valkey-reviewer:state -->`, with a bold verdict ("Ready for human
// review." / "Not ready for human review yet.") and usually the head it
// judged. It edits that comment in place as the PR moves.
//
// Only the negative half carries information: nearly every PR is "ready", so
// the positive verdict is a lamp that is always lit and is not surfaced. "Not
// ready" demotes the PR on the review tab. The comment is a soft contract with
// someone else's bot, so this fails open: no marker, an unparseable body, a
// verdict about an older head (named sha not a prefix of the current one), or
// a comment last touched before the latest push all yield "" (no signal).
const BOT_STATE_MARKER = "<!-- valkey-reviewer:state -->";
function botVerdict(comments, headSha, lastPush) {
  const none = { bot_verdict: "" };
  const state = (comments || []).filter((c) => (c.body || "").includes(BOT_STATE_MARKER)).pop();
  if (!state) return none;
  const m = /\*\*\s*(Ready|Not ready)\b[^*]*\*\*/i.exec(state.body);
  if (!m) return none;
  const touched = state.updated_at || state.created_at || "";
  if (lastPush && touched && new Date(touched) < new Date(lastPush)) return none;
  const paragraph = m.input.slice(m.index).split(/\n\s*\n/)[0];
  const named = /\b[0-9a-f]{7,40}\b/i.exec(paragraph);
  if (named && headSha && !headSha.toLowerCase().startsWith(named[0].toLowerCase())) return none;
  return { bot_verdict: /^not/i.test(m[1]) ? "not-ready" : "ready" };
}

// Issues have only comments (no commits/reviews/CI). Fetch them, build a
// comment activity list, and anchor unread on your most recent comment.
async function fetchIssueActivity(issue) {
  const [org, repo] = issue.url.replace("https://github.com/", "").split("/");
  const base = `https://api.github.com/repos/${org}/${repo}`;
  let comments = [];
  try {
    const { body } = await request(`${base}/issues/${issue.number}/comments?per_page=100`);
    comments = body;
  } catch (e) { console.warn(`  Failed to fetch comments for issue #${issue.number}: ${e.message}`); }

  const activity = comments.map(mapComment).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  // Anchor: your latest comment on the issue -> unread = comments after it.
  // Falls back to issue creation (handled downstream) when you've never replied.
  const myEvents = activity.filter(a => a.author === GITHUB_USER);
  const my_last_interaction = myEvents.length > 0 ? myEvents[0].created_at : "";
  return { activity, activity_fetched_at: new Date().toISOString(), my_last_interaction, last_push: my_last_interaction, comments };
}

// Cached fields carried over for an issue or mention whose updated_at has not
// moved. Only a mention carries unread_anchor; an item that moved between the
// two tabs must not keep the other tab's anchor.
function cachedIssueFields(prior, withAnchor) {
  const { activity, activity_fetched_at, my_last_interaction, last_push, unread_anchor } = prior;
  return withAnchor
    ? { activity, activity_fetched_at, my_last_interaction, last_push, unread_anchor }
    : { activity, activity_fetched_at, my_last_interaction, last_push };
}

async function enrichIssuesWithActivity(issues, label, priorByUrl = new Map()) {
  if (issues.length === 0) return issues;
  console.log(`\n  Fetching comments for ${issues.length} ${label}...`);
  const enriched = [];
  let reused = 0;
  for (const issue of issues) {
    const prior = reuseActivity(priorByUrl.get(issue.url), issue);
    if (prior) { reused++; enriched.push({ ...issue, ...cachedIssueFields(prior, false) }); continue; }
    const { activity, activity_fetched_at, my_last_interaction, last_push } = await fetchIssueActivity(issue);
    enriched.push({ ...issue, activity, activity_fetched_at, my_last_interaction, last_push });
  }
  if (reused) console.log(`  ${reused} of ${issues.length} unchanged since the prior run; comments reused.`);
  return enriched;
}

// A mention that is already on another tab carries a better signal there
// (whose move, CI, threads), so it is dropped from the Mentions list.
// Union of the review-requested and reviewed-by searches, by URL, requested
// first so a PR in both keeps the richer (more recently updated) search hit.
function mergeReviewing(requested, reviewed) {
  const seen = new Set();
  return [...requested, ...reviewed].filter((pr) => {
    if (seen.has(pr.url)) return false;
    seen.add(pr.url);
    return true;
  });
}

function dedupeMentions(mentions, ...otherLists) {
  const seen = new Set(otherLists.flat().map(i => i.url));
  return mentions.filter(m => !seen.has(m.url));
}

// Where unread starts for a mention: your latest comment if you replied after
// being mentioned, else one second before the comment that mentioned you, so
// the mention itself reads as new. Falls back to the item's creation when the
// mention is in the body (comments never contain the handle).
function mentionAnchor(activity, user, created) {
  // Whole handle only: @rain must not match @rain-bot.
  const handle = new RegExp(`@${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
  const mentionedAt = (activity || []).filter(a => a.author !== user && handle.test(a.body || "")).map(a => a.created_at).sort().pop() || "";
  const myLast = (activity || []).filter(a => a.author === user).map(a => a.created_at).sort().pop() || "";
  if (myLast && myLast > mentionedAt) return myLast;
  if (mentionedAt) return new Date(new Date(mentionedAt).getTime() - 1000).toISOString();
  return created || "";
}

async function enrichMentionsWithActivity(mentions, priorByUrl = new Map()) {
  if (mentions.length === 0) return mentions;
  console.log(`\n  Fetching comments for ${mentions.length} mentions...`);
  const enriched = [];
  let reused = 0;
  for (const m of mentions) {
    const prior = reuseActivity(priorByUrl.get(m.url), m);
    if (prior && prior.unread_anchor !== undefined) { reused++; enriched.push({ ...m, ...cachedIssueFields(prior, true) }); continue; }
    const { activity, activity_fetched_at, my_last_interaction, comments } = await fetchIssueActivity(m);
    // Scan full bodies: the activity feed keeps only a 200-char preview.
    const full = comments.map(c => ({ author: (c.user || {}).login || "ghost", body: c.body || "", created_at: c.created_at }));
    const unread_anchor = mentionAnchor(full, GITHUB_USER, m.created);
    enriched.push({ ...m, activity, activity_fetched_at, my_last_interaction, last_push: unread_anchor, unread_anchor });
  }
  if (reused) console.log(`  ${reused} of ${mentions.length} unchanged since the prior run; comments reused.`);
  return enriched;
}

const EMPTY_SIGNALS = Object.freeze({
  review_decision: "",
  mergeable: "UNKNOWN",
  ci_rollup: "",
  head_oid: "",
  head_pushed_at: "",
  unresolved_threads: 0,
  threads_awaiting_me: 0,
  threads_awaiting_them: 0,
  threads_bot: 0,
  reviewers: [],
  requested: [],
  waiting_on: [],
  approvals_current: 0,
  approvals_stale: 0,
  changes_requested: 0,
  has_human_reviewer: false,
  my_review: "",
  my_review_stale: false,
  my_last_look: "",
  my_review_requested: false,
});

function isBotActor(node) {
  const a = (node || {}).author || {};
  return a.__typename === "Bot" || /\[bot\]$/.test(a.login || "");
}

// Pure mapper: turns a GraphQL pullRequest node into flat, turn-aware triage
// signals relative to `me`. Kept separate from the network call so it can be
// unit-tested.
//
// GitHub's aggregate fields are sticky across pushes: reviewDecision stays
// APPROVED / CHANGES_REQUESTED after the author pushes, and a review thread
// stays unresolved until a reviewer clicks resolve regardless of who spoke
// last. So the aggregates are kept only for display, and the fields that drive
// triage are derived here from per-review commit oids and per-thread last
// commenters, which is enough to tell whose move it is.
function mapSignals(prNode, me) {
  if (!prNode) return { ...EMPTY_SIGNALS, mergeable: "" };
  const meLower = (me || "").toLowerCase();
  const author = (prNode.author?.login || "").toLowerCase();
  const iAmAuthor = !!meLower && author === meLower;
  const head = prNode.headRefOid || "";
  const headCommit = prNode.commits?.nodes?.[0]?.commit || {};

  // Latest non-COMMENTED review per non-bot, non-author reviewer, with the
  // commit it was given on. A verdict on an older head is "stale": the
  // reviewer owes another look, and an approval no longer clears the PR.
  const latest = new Map();
  // My most recent review of any kind (COMMENTED included) and the head it
  // was on: a look on an older head means the author has pushed since.
  let myLastLook = null;
  for (const r of prNode.reviews?.nodes || []) {
    if (!r || isBotActor(r)) continue;
    const login = r.author?.login || "";
    if (!login || login.toLowerCase() === author) continue;
    if (login.toLowerCase() === meLower && (!myLastLook || (r.submittedAt || "") >= (myLastLook.at || ""))) {
      myLastLook = { oid: r.commit?.oid || "", at: r.submittedAt || "" };
    }
    if (r.state === "COMMENTED" || r.state === "PENDING") {
      if (!latest.has(login.toLowerCase())) latest.set(login.toLowerCase(), { login, state: "COMMENTED", oid: "", at: r.submittedAt || "" });
      continue;
    }
    const prev = latest.get(login.toLowerCase());
    if (!prev || prev.state === "COMMENTED" || (r.submittedAt || "") >= (prev.at || "")) {
      latest.set(login.toLowerCase(), { login, state: r.state, oid: r.commit?.oid || "", at: r.submittedAt || "" });
    }
  }
  const reviewers = [...latest.values()].map(({ login, state, oid, at }) => ({
    login,
    state,
    at,
    stale: state !== "COMMENTED" && !!head && !!oid && oid !== head,
  }));

  const requested = [];
  for (const n of prNode.reviewRequests?.nodes || []) {
    const rr = (n || {}).requestedReviewer || {};
    if (rr.login) requested.push(rr.login);
    else if (rr.slug) requested.push(`team:${rr.slug}`);
  }

  // Who owes a look: current requests without a current-head verdict, plus
  // anyone whose verdict predates the head.
  const verdictAtHead = new Set(
    reviewers.filter((r) => r.state !== "COMMENTED" && !r.stale).map((r) => r.login.toLowerCase())
  );
  const waiting = new Set();
  for (const who of requested) {
    if (!verdictAtHead.has(who.toLowerCase())) waiting.add(who);
  }
  for (const r of reviewers) if (r.stale) waiting.add(r.login);

  // Unresolved threads, split by whose reply is pending. On my own PR every
  // thread is mine to answer; on someone else's PR only threads I opened are
  // my conversations. A thread whose last word is a bot's is counted apart:
  // it is feedback the author has not acknowledged. A push after the bot
  // spoke, or a reaction on its comment, counts as acknowledgement -- Valkey
  // contributors rarely click Resolve -- so those threads are not counted.
  // On my own PR, a reviewer whose thread I answered last owes the next
  // reply, so they join waiting_on.
  const headDate = prNode.commits?.nodes?.[0]?.commit?.committedDate || "";
  let unresolved = 0, awaitingMe = 0, awaitingThem = 0, bot = 0;
  for (const t of prNode.reviewThreads?.nodes || []) {
    if (!t || t.isResolved !== false) continue;
    unresolved++;
    const first = t.opener?.nodes?.[0] || null;
    const last = t.latest?.nodes?.[0] || first;
    if (isBotActor(last)) {
      const acknowledged =
        (last.reactions?.totalCount || 0) > 0 ||
        (!!headDate && !!last.createdAt && new Date(last.createdAt) < new Date(headDate));
      if (!acknowledged) bot++;
      continue;
    }
    const lastLogin = (last?.author?.login || "").toLowerCase();
    const firstLogin = (first?.author?.login || "").toLowerCase();
    if (!meLower) continue;
    if (!iAmAuthor && firstLogin !== meLower && lastLogin !== meLower) continue; // someone else's conversation
    if (lastLogin === meLower) {
      awaitingThem++;
      if (iAmAuthor && first?.author?.login && !isBotActor(first) && firstLogin !== meLower) waiting.add(first.author.login);
    } else {
      awaitingMe++;
    }
  }

  const mine = reviewers.find((r) => r.login.toLowerCase() === meLower);
  const myVerdict = mine && mine.state !== "COMMENTED" ? mine : null;
  const rollup = prNode.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || "";

  return {
    // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null (sticky; display only)
    review_decision: prNode.reviewDecision || "",
    // MERGEABLE | CONFLICTING | UNKNOWN
    mergeable: prNode.mergeable || "UNKNOWN",
    // SUCCESS | FAILURE | ERROR | PENDING | EXPECTED | "" — includes commit
    // statuses (e.g. DCO) that check-runs alone miss.
    ci_rollup: rollup,
    head_oid: head,
    head_pushed_at: headCommit.committedDate || "",
    unresolved_threads: unresolved,
    threads_awaiting_me: awaitingMe,
    threads_awaiting_them: awaitingThem,
    threads_bot: bot,
    reviewers,
    requested,
    waiting_on: [...waiting],
    approvals_current: reviewers.filter((r) => r.state === "APPROVED" && !r.stale).length,
    approvals_stale: reviewers.filter((r) => r.state === "APPROVED" && r.stale).length,
    changes_requested: reviewers.filter((r) => r.state === "CHANGES_REQUESTED" && !r.stale).length,
    has_human_reviewer: reviewers.length > 0 || requested.length > 0,
    my_review: myVerdict ? myVerdict.state : "",
    my_review_stale: !!(myVerdict && myVerdict.stale),
    // "" (never looked) | "current" (looked at this head) | "stale" (author pushed since)
    my_last_look: !myLastLook ? "" : (head && myLastLook.oid && myLastLook.oid !== head ? "stale" : "current"),
    my_review_requested: requested.some((w) => w.toLowerCase() === meLower),
  };
}

// Fields every in-flight PR needs for triage. Shared by the per-PR query
// (fallback) and the aliased batch query below.
const PR_SIGNALS_FRAGMENT = `
fragment Signals on PullRequest {
  reviewDecision
  mergeable
  headRefOid
  author { login }
  reviewRequests(first: 20) {
    nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
  }
  reviews(last: 100) {
    nodes { author { login __typename } state submittedAt commit { oid } }
  }
  reviewThreads(first: 100) {
    nodes {
      isResolved
      opener: comments(first: 1) { nodes { author { login __typename } } }
      latest: comments(last: 1) { nodes { author { login __typename } createdAt reactions { totalCount } } }
    }
  }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
}`;

// Lean variant for project-wide (merger) PRs: no review threads, which the
// merger rules never read. ~70 nodes per PR instead of ~420, so 400+ PRs fit
// inside the 1000-point hourly GraphQL budget of the Actions token.
const PR_SIGNALS_LEAN_FRAGMENT = `
fragment Signals on PullRequest {
  reviewDecision
  mergeable
  headRefOid
  author { login }
  reviewRequests(first: 20) {
    nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
  }
  reviews(last: 50) {
    nodes { author { login __typename } state submittedAt commit { oid } }
  }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
}`;

const PR_SIGNALS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ...Signals }
  }
}
${PR_SIGNALS_FRAGMENT}`;

const SIGNALS_BATCH_SIZE = 25;

function repoParts(pr) {
  const [owner, name] = pr.url.replace("https://github.com/", "").split("/");
  return { owner, name };
}

async function fetchPRSignals(pr) {
  const { owner, name } = repoParts(pr);
  try {
    const data = await graphql(PR_SIGNALS_QUERY, { owner, name, number: pr.number });
    return mapSignals(data?.repository?.pullRequest, GITHUB_USER);
  } catch (e) {
    console.warn(`  Failed to fetch signals for #${pr.number}: ${e.message}`);
    return { ...EMPTY_SIGNALS };
  }
}

// One GraphQL call for up to SIGNALS_BATCH_SIZE PRs, each under its own alias.
// Returns an array of signal objects in input order; a failed batch falls
// back to per-PR fetches so one bad node cannot blank the whole batch.
async function fetchSignalsBatch(prs, fragment = PR_SIGNALS_FRAGMENT, retried = false) {
  const parts = prs.map((pr, i) => {
    const { owner, name } = repoParts(pr);
    return `p${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${pr.number}) { ...Signals } }`;
  });
  const query = `query { ${parts.join("\n")} }\n${fragment}`;
  try {
    const data = await graphql(query, {});
    return prs.map((pr, i) => mapSignals(data?.[`p${i}`]?.pullRequest, GITHUB_USER));
  } catch (e) {
    if (/RATE_LIMIT/i.test(e.message)) {
      // Usually the per-minute secondary limit, not the hourly budget: wait it
      // out once. If it still fails, say so rather than hammer the per-PR path.
      if (!retried) {
        console.warn(`  Signals batch of ${prs.length} hit the GraphQL rate limit; waiting 65s and retrying once.`);
        await sleep(65000);
        return fetchSignalsBatch(prs, fragment, true);
      }
      console.warn(`  Signals batch of ${prs.length} still rate limited; marking them as missing.`);
      return prs.map(() => ({ ...EMPTY_SIGNALS, signals_missing: true }));
    }
    console.warn(`  Signals batch of ${prs.length} failed (${e.message}); retrying one by one.`);
    const out = [];
    for (const pr of prs) out.push(await fetchPRSignals(pr));
    return out;
  }
}

async function enrichWithSignals(prs, label, fragment = PR_SIGNALS_FRAGMENT) {
  if (prs.length === 0) return prs;
  console.log(`\n  Fetching triage signals for ${prs.length} ${label} PRs (${Math.ceil(prs.length / SIGNALS_BATCH_SIZE)} batches)...`);
  const enriched = [];
  for (let i = 0; i < prs.length; i += SIGNALS_BATCH_SIZE) {
    const slice = prs.slice(i, i + SIGNALS_BATCH_SIZE);
    const signals = await fetchSignalsBatch(slice, fragment);
    slice.forEach((pr, j) => enriched.push({ ...pr, ...signals[j] }));
    if (i + SIGNALS_BATCH_SIZE < prs.length) await sleep(750); // stay under the per-minute secondary limit
  }
  const missing = enriched.filter((p) => p.signals_missing).length;
  if (missing) console.warn(`  ${missing} of ${prs.length} ${label} PRs have no signals this run.`);
  return enriched;
}

// Runs after enrichWithSignals: head_oid and ci_rollup on each PR are the CI
// cache key. Activity is reused when updated_at is unchanged; check-runs when
// the head and its settled rollup are unchanged.
async function enrichWithActivity(prs, label, priorByUrl = new Map()) {
  if (prs.length === 0) return prs;
  console.log(`\n  Fetching activity for ${prs.length} ${label} PRs...`);
  const enriched = [];
  let reusedActivity = 0, reusedCI = 0;
  for (const pr of prs) {
    const prior = priorByUrl.get(pr.url);
    const cachedCI = reuseCI(prior, pr);
    if (cachedCI) reusedCI++;
    const cached = reuseActivity(prior, pr);
    let fetched;
    if (cached) {
      reusedActivity++;
      const { last_push, activity, activity_fetched_at, bot_verdict } = cached;
      fetched = { last_push, activity, activity_fetched_at, bot_verdict: bot_verdict || "", ci_jobs: cachedCI || (await fetchCIStatus(apiBase(pr), pr.head_oid)).ci_jobs };
    } else {
      fetched = await fetchActivity(pr, cachedCI);
    }
    // Find the most recent activity event by the dashboard user (reviews, comments, review-comments)
    const myEvents = fetched.activity.filter(a => a.author === GITHUB_USER && a.type !== "commit");
    const my_last_interaction = myEvents.length > 0 ? myEvents[0].created_at : "";
    enriched.push({ ...pr, ...fetched, my_last_interaction });
  }
  if (reusedActivity || reusedCI) {
    console.log(`  Reused from the prior run: activity for ${reusedActivity}, check-runs for ${reusedCI} of ${prs.length}.`);
  }
  return enriched;
}


// ---------------------------------------------------------------------------
// Merger row: project-wide duties for someone with merge rights.
// ---------------------------------------------------------------------------

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

// true / false, or null when the file list could not be read (not cached).
async function touchesWorkflows(pr) {
  const { owner, name } = repoParts(pr);
  try {
    const { body } = await request(`https://api.github.com/repos/${owner}/${name}/pulls/${pr.number}/files?per_page=100`);
    return body.some((f) => (f.filename || "").startsWith(".github/"));
  } catch (e) { return null; }
}

// A PR's file list changes only with its head, so the answer is cached by
// head_oid in merger-cache.json. Entries for heads no longer waiting on a run
// are dropped each run, so the map stays the size of the waiting set.
function pruneTouchesCache(touches, liveHeads) {
  const out = {};
  for (const sha of liveHeads) if (touches && typeof touches[sha] === "boolean") out[sha] = touches[sha];
  return out;
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

// Shape: { version, entries: { <org>: merged-counter state }, touches: { <head_oid>: bool } }.
// Bump when the cached shape changes incompatibly; an old cache is discarded
// and rebuilt (the merged-history scan is minutes, so additive keys do not bump).
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

function monthWindows(fromIso) {
  const windows = [];
  const d = new Date(fromIso); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
  const now = new Date();
  while (d <= now) {
    const next = new Date(d); next.setUTCMonth(next.getUTCMonth() + 1);
    windows.push(`${d.toISOString().slice(0, 10)}..${new Date(next - 1).toISOString().slice(0, 10)}`);
    d.setTime(next.getTime());
  }
  return windows;
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
  const touches = cache.touches || {};
  let touchesFetched = 0, touchesReused = 0;
  for (const pr of enriched) {
    if (!ciWaiting.has(pr.head_oid)) continue;
    if (typeof touches[pr.head_oid] === "boolean") { touchesReused++; }
    else {
      touchesFetched++;
      const v = await touchesWorkflows(pr);
      if (v !== null) touches[pr.head_oid] = v;
    }
    pr.touches_workflows = touches[pr.head_oid] || false;
  }
  cache.touches = pruneTouchesCache(touches, enriched.map((p) => p.head_oid).filter((sha) => ciWaiting.has(sha)));
  lap(`workflow-touch checks done (${touchesReused} cached, ${touchesFetched} fetched)`);
  const { sections, counts } = buildMergerSections(enriched, { committers, ciWaiting, mergeLabels: MERGE_LABELS, me: GITHUB_USER });
  const outDir = path.join(__dirname, "..", "data");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "merger-cache.json"), JSON.stringify(cache));
  console.log(`  Sections: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}; merged by ${GITHUB_USER}: ${mergedTotals.count}${mergedTotals.since ? ` since ${mergedTotals.since.slice(0, 7)}` : ""}.`);
  if (incomplete) console.warn(`  Merger sections are incomplete: ${incomplete} PRs had no signals (rate limit).`);
  return { entries: MERGE_ACCESS, total_open: allOpen.length, incomplete, repos, counts, sections, committers_source: [...committerSources].join(" + "), merged: mergedTotals };
}

function apiBase(pr) {
  const [org, repo] = pr.url.replace("https://github.com/", "").split("/");
  return `https://api.github.com/repos/${org}/${repo}`;
}

async function main() {
  if (ORGS.length === 0) {
    console.error("No orgs configured. Set \"orgs\" in config.json (e.g. [\"my-org\"]).");
    process.exit(1);
  }

  console.log(`Fetching data for ${ORGS.length} org(s): ${ORGS.join(", ")}`);

  const priorRaw = await loadPrior();
  const prior = priorUsable(priorRaw, GITHUB_USER, ORGS) ? priorRaw : null;
  if (priorRaw && !prior) console.warn("  Prior snapshot is for another user or org set; ignoring it.");
  const priorByUrl = priorIndex(prior);
  if (prior) console.log(`  Prior snapshot from ${prior.updated}: ${priorByUrl.size} cached items.`);

  const results = await Promise.all(ORGS.map(fetchForOrg));

  let allReviewItems = [];
  let allOpenItems = [];
  let allClosedItems = [];
  let allReviewedOpenItems = [];
  let allReviewedByItems = [];
  let allMentionItems = [];
  let allAssignedIssueItems = [];
  let allAuthoredIssueItems = [];

  for (const result of results) {
    allReviewItems.push(...result.reviewItems);
    allOpenItems.push(...result.openItems);
    allClosedItems.push(...result.closedItems);
    allReviewedOpenItems.push(...result.reviewedOpenItems);
    allReviewedByItems.push(...result.reviewedByItems);
    allMentionItems.push(...result.mentionItems);
    allAssignedIssueItems.push(...result.assignedIssueItems);
    allAuthoredIssueItems.push(...result.authoredIssueItems);
  }

  // One reviewing list: PRs that asked for my review and PRs I have already
  // reviewed are the same job seen at different stages, so they share a tab
  // and whoseMove() says which stage each is at. A PR can be in both searches
  // (re-requested after a review); the URL dedupes it.
  const reviewing = mergeReviewing(allReviewItems.map(mapPR), allReviewedOpenItems.map(mapPR));
  const openPrs = allOpenItems.map(mapPR);
  const closedPrs = allClosedItems.map(mapPR);
  const reviewedBy = allReviewedByItems.map(mapPR);
  const mentionsAll = allMentionItems.map(mapMention);

  // Enrich every in-flight list with GraphQL triage signals (per-reviewer
  // verdicts against the head commit, who owes a look, thread turns, CI rollup).
  // These change without bumping updated_at, so they are never cached.
  let reviewingEnriched = await enrichWithSignals(reviewing, "reviewing");
  let openPrsEnriched = await enrichWithSignals(openPrs, "your-open");

  // Then activity (commits, reviews, comments) and check-runs, reusing the
  // prior run's copy where the signals say nothing moved.
  reviewingEnriched = await enrichWithActivity(reviewingEnriched, "reviewing", priorByUrl);
  openPrsEnriched = await enrichWithActivity(openPrsEnriched, "your-open", priorByUrl);

  const assignedSet = new Set(allAssignedIssueItems.map((i) => i.html_url));
  const authoredSet = new Set(allAuthoredIssueItems.map((i) => i.html_url));
  const allIssueItems = [...allAssignedIssueItems, ...allAuthoredIssueItems];
  const issuesSeen = new Set();
  const issues = allIssueItems
    .filter((i) => {
      if (issuesSeen.has(i.html_url)) return false;
      issuesSeen.add(i.html_url);
      return true;
    })
    .map((item) => {
      const m = mapMention(item);
      m.is_assigned = assignedSet.has(item.html_url);
      m.is_authored = authoredSet.has(item.html_url);
      return m;
    });

  // Enrich issues with comment activity (PR-style unread/inline threads).
  const issuesEnriched = await enrichIssuesWithActivity(issues, "issues", priorByUrl);

  // Mentions: drop what the other tabs already show, then fetch comments so
  // unread can start at the mention (or at your reply to it).
  const mentions = await enrichMentionsWithActivity(
    dedupeMentions(mentionsAll, reviewingEnriched, openPrsEnriched, issuesEnriched),
    priorByUrl
  );
  console.log(`  Mentions: ${mentionsAll.length} found, ${mentions.length} not already on another tab.`);

  const merger = await fetchMergerData();
  const flakes = await loadFlakeRegistry();

  const data = {
    github_user: GITHUB_USER,
    orgs: ORGS,
    updated: new Date().toISOString(),
    merger,
    flakes,
    reviewing: reviewingEnriched,
    open_prs: openPrsEnriched,
    closed_prs: closedPrs,
    reviewed_by: reviewedBy,
    mentions,
    issues: issuesEnriched,
    counts: {
      reviewing: reviewingEnriched.length,
      open: openPrsEnriched.length,
      closed: closedPrs.length,
      reviewed_by: reviewedBy.length,
      mentions: mentions.length,
      issues: issuesEnriched.length,
    },
  };

  const outDir = path.join(__dirname, "..", "data");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "prs.json");
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));

  console.log(
    `\nDone. ${data.counts.reviewing} reviewing, ${data.counts.open} open, ${data.counts.closed} closed, ${data.counts.reviewed_by} reviewed, ${data.counts.mentions} mentions, ${data.counts.issues} issues. Written to data/prs.json`
  );
  console.log(`Requests: ${stats.rest} REST, ${stats.graphql} GraphQL.`);
}

// Allow importing for tests
if (typeof module !== "undefined") {
  module.exports = { flakeJobEntries, fetchMergerData, monthWindows, isRateLimited, pruneTouchesCache, mapPR, mapMention, dedupeMentions, mentionAnchor, mapComment, mapReview, mapCommit, mapReviewComment, mapSignals, botVerdict, mergeReviewing, fetchActivity, fetchCIStatus, fetchPRSignals, fetchIssueActivity, request, graphql, searchAll, sleep, priorUsable, priorIndex, reuseActivity, reuseCI, MAX_ACTIVITY_AGE_MS };
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
