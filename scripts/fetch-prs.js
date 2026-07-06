#!/usr/bin/env node
const https = require("https");
const fs = require("fs");
const path = require("path");

const configPath = path.join(__dirname, "..", "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const GITHUB_USER = process.env.DASHBOARD_USER || config.github_user;
const ORGS = config.orgs || (config.org ? [config.org] : []);
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
      } else if (run.conclusion === "failure") {
        ci_jobs.push({ name: run.name, status: "failure", url: run.html_url || "" });
      }
      // skip: skipped, neutral, cancelled
    }
    return { ci_jobs };
  } catch (e) {
    console.warn(`  Failed to fetch CI for ${sha.slice(0, 7)}: ${e.message}`);
    return { ci_jobs: [] };
  }
}

async function fetchActivity(pr) {
  const [org, repo] = pr.url.replace("https://github.com/", "").split("/");
  const base = `https://api.github.com/repos/${org}/${repo}`;

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
  const ci = await fetchCIStatus(base, headSha);

  const activity = [
    ...commits.map(mapCommit),
    ...reviews.filter(r => r.state !== "PENDING" && r.body && r.body.trim()).map(mapReview),
    ...comments.map(mapComment),
    ...reviewComments.map(mapReviewComment),
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return { last_push, activity, ...ci };
}

// Pure mapper: turns a GraphQL pullRequest node into flat triage signals.
// Kept separate from the network call so it can be unit-tested.
function mapSignals(prNode) {
  if (!prNode) return { review_decision: "", mergeable: "", unresolved_threads: 0 };
  const threads = prNode.reviewThreads?.nodes || [];
  const unresolved = threads.filter((t) => t && t.isResolved === false).length;
  return {
    // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
    review_decision: prNode.reviewDecision || "",
    // MERGEABLE | CONFLICTING | UNKNOWN
    mergeable: prNode.mergeable || "UNKNOWN",
    unresolved_threads: unresolved,
  };
}

const PR_SIGNALS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewDecision
      mergeable
      reviewThreads(first: 100) { nodes { isResolved } }
    }
  }
}`;

async function fetchPRSignals(pr) {
  const [owner, name] = pr.url.replace("https://github.com/", "").split("/");
  try {
    const data = await graphql(PR_SIGNALS_QUERY, { owner, name, number: pr.number });
    return mapSignals(data?.repository?.pullRequest);
  } catch (e) {
    console.warn(`  Failed to fetch signals for #${pr.number}: ${e.message}`);
    return { review_decision: "", mergeable: "UNKNOWN", unresolved_threads: 0 };
  }
}

async function enrichWithSignals(prs, label) {
  if (prs.length === 0) return prs;
  console.log(`\n  Fetching triage signals for ${prs.length} ${label} PRs...`);
  const enriched = [];
  for (const pr of prs) {
    const signals = await fetchPRSignals(pr);
    enriched.push({ ...pr, ...signals });
  }
  return enriched;
}

async function enrichWithActivity(prs, label) {
  if (prs.length === 0) return prs;
  console.log(`\n  Fetching activity for ${prs.length} ${label} PRs...`);
  const enriched = [];
  for (const pr of prs) {
    const { last_push, activity, ci_jobs } = await fetchActivity(pr);
    // Find the most recent activity event by the dashboard user (reviews, comments, review-comments)
    const myEvents = activity.filter(a => a.author === GITHUB_USER && a.type !== "commit");
    const my_last_interaction = myEvents.length > 0 ? myEvents[0].created_at : "";
    enriched.push({ ...pr, last_push, activity, ci_jobs, my_last_interaction });
  }
  return enriched;
}

async function main() {
  if (ORGS.length === 0) {
    console.error("No orgs configured. Set \"orgs\" in config.json (e.g. [\"my-org\"]).");
    process.exit(1);
  }

  console.log(`Fetching data for ${ORGS.length} org(s): ${ORGS.join(", ")}`);

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

  const toReview = allReviewItems.map(mapPR);
  const openPrs = allOpenItems.map(mapPR);
  const closedPrs = allClosedItems.map(mapPR);
  const reviewedOpen = allReviewedOpenItems.map(mapPR);
  const reviewedBy = allReviewedByItems.map(mapPR);
  const mentions = allMentionItems.map(mapMention);

  // Enrich open PRs with activity (commits, reviews, comments)
  const toReviewEnriched = await enrichWithActivity(toReview, "to-review");
  let openPrsEnriched = await enrichWithActivity(openPrs, "your-open");
  let reviewedOpenEnriched = await enrichWithActivity(reviewedOpen, "reviewed-open");

  // Enrich the two "in-flight" lists with GraphQL triage signals
  // (review decision, mergeable/conflict state, unresolved review threads).
  openPrsEnriched = await enrichWithSignals(openPrsEnriched, "your-open");
  reviewedOpenEnriched = await enrichWithSignals(reviewedOpenEnriched, "reviewed-open");

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

  const data = {
    github_user: GITHUB_USER,
    orgs: ORGS,
    updated: new Date().toISOString(),
    to_review: toReviewEnriched,
    open_prs: openPrsEnriched,
    closed_prs: closedPrs,
    reviewed_open: reviewedOpenEnriched,
    reviewed_by: reviewedBy,
    mentions,
    issues,
    counts: {
      to_review: toReviewEnriched.length,
      open: openPrsEnriched.length,
      closed: closedPrs.length,
      reviewed_open: reviewedOpenEnriched.length,
      reviewed_by: reviewedBy.length,
      mentions: mentions.length,
      issues: issues.length,
    },
  };

  const outDir = path.join(__dirname, "..", "data");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "prs.json");
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));

  console.log(
    `\nDone. ${data.counts.to_review} to review, ${data.counts.open} open, ${data.counts.closed} closed, ${data.counts.reviewed_by} reviewed, ${data.counts.mentions} mentions, ${data.counts.issues} issues. Written to data/prs.json`
  );
}

// Allow importing for tests
if (typeof module !== "undefined") {
  module.exports = { mapPR, mapMention, mapComment, mapReview, mapCommit, mapReviewComment, mapSignals, fetchActivity, fetchCIStatus, fetchPRSignals, request, graphql, searchAll, sleep };
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
