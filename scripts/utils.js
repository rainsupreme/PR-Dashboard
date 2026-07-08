// Shared utility functions used by both dashboard.js (browser) and tests (Node).
// In the browser, this file is not loaded — dashboard.js defines these inline.
// In tests, require this module directly.

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "";
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function daysOld(dateStr) {
  if (!dateStr) return 0;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return 0;
  return Math.floor((Date.now() - date.getTime()) / 86400000);
}

function escapeAttr(str) {
  return str.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function formatDate(isoStr) {
  if (!isoStr) return "";
  return isoStr.slice(0, 10);
}

function sortPRs(prs, sortBy, opts) {
  if (sortBy === "triage") {
    return [...prs].sort((a, b) => {
      const sb = computeTriageScore(b, opts), sa = computeTriageScore(a, opts);
      if (sb !== sa) return sb - sa;
      return new Date(b.updated) - new Date(a.updated);
    });
  }
  return [...prs].sort((a, b) => {
    if (sortBy === "comments") return b.comments - a.comments;
    if (sortBy === "created") return new Date(b.created) - new Date(a.created);
    return new Date(b.updated) - new Date(a.updated);
  });
}

// Derive a single CI state from the per-job list.
// "failure" if any job failed, else "pending" if any still running,
// else "success" if there is at least one job, else "" (unknown / no CI).
function ciState(pr) {
  const jobs = pr.ci_jobs || [];
  if (jobs.length === 0) return "";
  if (jobs.some((j) => j.status === "failure")) return "failure";
  if (jobs.some((j) => j.status === "pending")) return "pending";
  return "success";
}

function hasMergeLabel(pr, mergeLabels) {
  if (!mergeLabels || mergeLabels.length === 0) return false;
  const set = new Set(mergeLabels);
  return (pr.labels || []).some((l) => set.has(l.name));
}

// "Clear to land": mechanically ready (approved + CI green + no conflict).
// Distinct from the maintainer-applied merge label.
function isClearToLand(pr) {
  return (
    pr.review_decision === "APPROVED" &&
    ciState(pr) === "success" &&
    pr.mergeable === "MERGEABLE"
  );
}

// A PR is "broken" when it has a problem its author must fix. On the review
// tab only CI is known (those PRs aren't GraphQL-enriched), so this degrades
// to CI-only there.
function isBroken(pr) {
  return (
    ciState(pr) === "failure" ||
    pr.mergeable === "CONFLICTING" ||
    pr.review_decision === "CHANGES_REQUESTED"
  );
}

// Whether a PR needs the user's attention now — keeps it bright (undimmed)
// even with no new activity. Semantics differ by tab because the *action*
// differs: on your own PRs the ball is on you (broken = act); on PRs you're
// reviewing the ball is on the author (ready/green = act).
function isActionable(pr, opts) {
  const { mergeLabels, type } = opts || {};
  if (type === "review") {
    // Incoming review: your review is the last mile unless it's broken.
    return ciState(pr) !== "failure";
  }
  if (type === "reviewed-open") {
    // Ready to nudge a committer, or a thread awaiting your re-review.
    if (isClearToLand(pr) && !hasMergeLabel(pr, mergeLabels)) return true;
    if ((pr.unresolved_threads || 0) > 0) return true;
    return false;
  }
  // Authored ("open"): broken-first — the more broken, the more it needs you.
  if (ciState(pr) === "failure") return true;
  if (pr.review_decision === "CHANGES_REQUESTED") return true;
  if (pr.mergeable === "CONFLICTING") return true;
  if ((pr.unresolved_threads || 0) > 0) return true;
  if (isClearToLand(pr) && !hasMergeLabel(pr, mergeLabels)) return true;
  return false;
}

// Triage priority (higher = more urgent), ranked per-tab.
function computeTriageScore(pr, opts) {
  const { mergeLabels, type } = opts || {};
  if (type === "review") return scoreIncomingReview(pr);
  if (type === "reviewed-open") return scoreOutgoingReview(pr, mergeLabels);
  return scoreAuthored(pr, mergeLabels);
}

// Your own PRs — broken-first. The more broken, the more of your work remains.
function scoreAuthored(pr, mergeLabels) {
  const labeled = hasMergeLabel(pr, mergeLabels);
  const ci = ciState(pr);
  const broken = ci === "failure" || pr.mergeable === "CONFLICTING";
  if (labeled && broken) return 100;              // queued for merge but now broken
  if (ci === "failure") return 90;
  if (pr.review_decision === "CHANGES_REQUESTED") return 80;
  if (pr.mergeable === "CONFLICTING") return 70;
  if ((pr.unresolved_threads || 0) > 0) return 60;
  if (isClearToLand(pr) && !labeled) return 50;   // ready -> nudge a maintainer
  if (labeled) return 5;                          // queued + healthy -> just wait
  return 0;
}

// PRs awaiting your review — ready/green-first: your review unblocks merge,
// so the closer to mergeable the higher; a long wait on you bumps it further.
// CI-only + staleness (these PRs are not GraphQL-enriched).
function scoreIncomingReview(pr) {
  let score = ciState(pr) === "failure" ? 20 : 60; // broken = author's turn, can wait
  if (daysOld(pr.created) > 7) score += 25;        // been waiting on you a long time
  return score;
}

// PRs you reviewed — ready-to-merge-first: the closer to landing, the more
// valuable your nudge. Broken PRs are the author's move; already-queued
// healthy PRs just wait.
function scoreOutgoingReview(pr, mergeLabels) {
  const labeled = hasMergeLabel(pr, mergeLabels);
  const ci = ciState(pr);
  if (isBroken(pr)) return 15;                      // ball back with the author
  if (labeled) return 5;                            // queued + healthy -> just waiting
  if (isClearToLand(pr)) return 80;                 // ready + unqueued -> nudge a committer
  if (pr.review_decision === "APPROVED" && ci === "success") return 60; // nearly ready
  if ((pr.unresolved_threads || 0) > 0) return 40;  // may need your re-review
  return 0;
}

function filterUnreadActivity(activity, since) {
  if (!activity || activity.length === 0) return [];
  if (!since) return activity;
  return activity.filter(a => a.created_at > since);
}

// True when the data's updated timestamp is older than thresholdMs.
// Missing/invalid timestamps are treated as NOT stale (nothing to warn about).
function isStale(updatedIso, thresholdMs, now) {
  if (!updatedIso) return false;
  const t = new Date(updatedIso).getTime();
  if (isNaN(t)) return false;
  return (now || Date.now()) - t > thresholdMs;
}

// Compact human age for the stale banner (e.g. "2h", "3d").
function staleAgeLabel(ms) {
  const hours = ms / 3600000;
  if (hours < 24) return `${Math.floor(hours)}h`;
  return `${Math.floor(ms / 86400000)}d`;
}

if (typeof module !== "undefined") {
  module.exports = { timeAgo, daysOld, escapeAttr, formatDate, sortPRs, filterUnreadActivity, ciState, hasMergeLabel, isClearToLand, isBroken, isActionable, computeTriageScore, isStale, staleAgeLabel };
}
