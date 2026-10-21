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

  return { last_push, activity, ...ci, ...botVerdict(comments, headSha, last_push) };
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
  return { activity, my_last_interaction, last_push: my_last_interaction, comments };
}

async function enrichIssuesWithActivity(issues, label) {
  if (issues.length === 0) return issues;
  console.log(`\n  Fetching comments for ${issues.length} ${label}...`);
  const enriched = [];
  for (const issue of issues) {
    const { activity, my_last_interaction, last_push } = await fetchIssueActivity(issue);
    enriched.push({ ...issue, activity, my_last_interaction, last_push });
  }
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

async function enrichMentionsWithActivity(mentions) {
  if (mentions.length === 0) return mentions;
  console.log(`\n  Fetching comments for ${mentions.length} mentions...`);
  const enriched = [];
  for (const m of mentions) {
    const { activity, my_last_interaction, comments } = await fetchIssueActivity(m);
    // Scan full bodies: the activity feed keeps only a 200-char preview.
    const full = comments.map(c => ({ author: (c.user || {}).login || "ghost", body: c.body || "", created_at: c.created_at }));
    const unread_anchor = mentionAnchor(full, GITHUB_USER, m.created);
    enriched.push({ ...m, activity, my_last_interaction, last_push: unread_anchor, unread_anchor });
  }
  return enriched;
}

const EMPTY_SIGNALS = Object.freeze({
  review_decision: "",
  mergeable: "UNKNOWN",
  ci_rollup: "",
  head_oid: "",
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
  const reviewers = [...latest.values()].map(({ login, state, oid }) => ({
    login,
    state,
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

const PR_SIGNALS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
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
    }
  }
}`;

async function fetchPRSignals(pr) {
  const [owner, name] = pr.url.replace("https://github.com/", "").split("/");
  try {
    const data = await graphql(PR_SIGNALS_QUERY, { owner, name, number: pr.number });
    return mapSignals(data?.repository?.pullRequest, GITHUB_USER);
  } catch (e) {
    console.warn(`  Failed to fetch signals for #${pr.number}: ${e.message}`);
    return { ...EMPTY_SIGNALS };
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

  // One reviewing list: PRs that asked for my review and PRs I have already
  // reviewed are the same job seen at different stages, so they share a tab
  // and whoseMove() says which stage each is at. A PR can be in both searches
  // (re-requested after a review); the URL dedupes it.
  const reviewing = mergeReviewing(allReviewItems.map(mapPR), allReviewedOpenItems.map(mapPR));
  const openPrs = allOpenItems.map(mapPR);
  const closedPrs = allClosedItems.map(mapPR);
  const reviewedBy = allReviewedByItems.map(mapPR);
  const mentionsAll = allMentionItems.map(mapMention);

  // Enrich open PRs with activity (commits, reviews, comments)
  let reviewingEnriched = await enrichWithActivity(reviewing, "reviewing");
  let openPrsEnriched = await enrichWithActivity(openPrs, "your-open");

  // Enrich every in-flight list with GraphQL triage signals (per-reviewer
  // verdicts against the head commit, who owes a look, thread turns, CI rollup).
  reviewingEnriched = await enrichWithSignals(reviewingEnriched, "reviewing");
  openPrsEnriched = await enrichWithSignals(openPrsEnriched, "your-open");

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
  const issuesEnriched = await enrichIssuesWithActivity(issues, "issues");

  // Mentions: drop what the other tabs already show, then fetch comments so
  // unread can start at the mention (or at your reply to it).
  const mentions = await enrichMentionsWithActivity(
    dedupeMentions(mentionsAll, reviewingEnriched, openPrsEnriched, issuesEnriched)
  );
  console.log(`  Mentions: ${mentionsAll.length} found, ${mentions.length} not already on another tab.`);

  const data = {
    github_user: GITHUB_USER,
    orgs: ORGS,
    updated: new Date().toISOString(),
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
}

// Allow importing for tests
if (typeof module !== "undefined") {
  module.exports = { mapPR, mapMention, dedupeMentions, mentionAnchor, mapComment, mapReview, mapCommit, mapReviewComment, mapSignals, botVerdict, mergeReviewing, fetchActivity, fetchCIStatus, fetchPRSignals, fetchIssueActivity, request, graphql, searchAll, sleep };
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
