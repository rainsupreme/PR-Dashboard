const fs = require("fs");
const path = require("path");
const { request, searchAll } = require("./github.js");
const { GITHUB_USER, ORGS } = require("./settings.js");
const mappers = require("./mappers.js");
const { mapPR, mapMention, mapComment, mapReview, mapCommit, mapReviewComment, botVerdict, mergeReviewing, dedupeMentions, mentionAnchor } = mappers;
const { enrichWithSignals } = require("./signals.js");
const { fetchMergerData } = require("./merger-fetch.js");

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

  const merger = await fetchMergerData();

  const data = {
    github_user: GITHUB_USER,
    orgs: ORGS,
    updated: new Date().toISOString(),
    merger,
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

// Re-exported so existing tests and tooling keep one import point.
if (typeof module !== "undefined") {
  module.exports = { ...mappers, fetchMergerData, fetchActivity, fetchCIStatus, fetchIssueActivity, request, searchAll };
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
