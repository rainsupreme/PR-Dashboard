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

// Whether a PR has something the user can act on. Used to keep items bright
// (undimmed) even when there is no *new* activity.
function isActionable(pr, opts) {
  const { mergeLabels } = opts || {};
  if (ciState(pr) === "failure") return true;
  if (pr.review_decision === "CHANGES_REQUESTED") return true;
  if (pr.mergeable === "CONFLICTING") return true;
  if ((pr.unresolved_threads || 0) > 0) return true;
  // Mechanically ready but NOT yet queued by a maintainer -> your nudge action.
  if (isClearToLand(pr) && !hasMergeLabel(pr, mergeLabels)) return true;
  return false;
}

// Triage priority (higher = more urgent). Tiers:
//   queued-but-broken  > CI failing > changes requested > conflict
//   > unresolved threads > ready-to-nudge > stale review > unread > baseline
// A healthy PR already queued by a maintainer sinks to the bottom ("just wait").
function computeTriageScore(pr, opts) {
  const { mergeLabels, type } = opts || {};
  const labeled = hasMergeLabel(pr, mergeLabels);
  const ci = ciState(pr);
  const broken = ci === "failure" || pr.mergeable === "CONFLICTING";

  // Queued by a maintainer but now broken -> most urgent.
  if (labeled && broken) return 100;
  if (ci === "failure") return 90;
  if (pr.review_decision === "CHANGES_REQUESTED") return 80;
  if (pr.mergeable === "CONFLICTING") return 70;
  if ((pr.unresolved_threads || 0) > 0) return 60;
  // Ready to land but not yet queued -> nudge a maintainer.
  if (isClearToLand(pr) && !labeled) return 50;
  // Stale review request (only meaningful on the review tab).
  if (type === "review" && daysOld(pr.created) > 7) return 40;
  // Queued and healthy -> just wait, lowest actionable relevance.
  if (labeled) return 5;
  return 0;
}

function filterUnreadActivity(activity, since) {
  if (!activity || activity.length === 0) return [];
  if (!since) return activity;
  return activity.filter(a => a.created_at > since);
}

if (typeof module !== "undefined") {
  module.exports = { timeAgo, daysOld, escapeAttr, formatDate, sortPRs, filterUnreadActivity, ciState, hasMergeLabel, isClearToLand, isActionable, computeTriageScore };
}
