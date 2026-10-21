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

// Derive a single CI state from the per-job list plus the GraphQL rollup.
// "failure" if any job failed, or the rollup is red with nothing cancelled
// (a commit status such as DCO that check-runs alone cannot see); else
// "cancelled" if a lane was cancelled (needs a rerun, not a fix); else
// "pending" if anything is still running; else "success"; else "" (no CI).
function ciState(pr) {
  const jobs = pr.ci_jobs || [];
  const rollup = pr.ci_rollup || "";
  const has = (s) => jobs.some((j) => j.status === s);
  if (has("failure")) return "failure";
  if ((rollup === "FAILURE" || rollup === "ERROR") && !has("cancelled")) return "failure";
  if (has("cancelled")) return "cancelled";
  // Workflows waiting for a maintainer to approve the run (first-time
  // contributor). Not pending: nothing is running until someone clicks.
  if (has("action_required")) return "action_required";
  if (has("pending") || rollup === "PENDING" || rollup === "EXPECTED") return "pending";
  if (jobs.length > 0 || rollup === "SUCCESS") return "success";
  return "";
}

function hasMergeLabel(pr, mergeLabels) {
  if (!mergeLabels || mergeLabels.length === 0) return false;
  const set = new Set(mergeLabels);
  return (pr.labels || []).some((l) => set.has(l.name));
}

// Whether the dashboard user can merge in this PR's repo. `mergeAccess` lists
// orgs ("valkey-io") and/or repos ("valkey-io/valkey") from config.json.
function canMerge(pr, mergeAccess) {
  if (!mergeAccess || mergeAccess.length === 0) return false;
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\//.exec(pr.url || "");
  if (!m) return false;
  const org = m[1].toLowerCase(), repo = `${m[1]}/${m[2]}`.toLowerCase();
  return mergeAccess.some((a) => { const x = String(a).toLowerCase(); return x === org || x === repo; });
}

// "Clear to land": approved by someone on the *current* head, no standing
// request for changes on it, CI green and no conflict. Uses the per-reviewer
// verdicts rather than GitHub's reviewDecision, which stays APPROVED after
// the author pushes. Distinct from the maintainer-applied merge label.
function isClearToLand(pr) {
  return (
    (pr.approvals_current || 0) > 0 &&
    (pr.changes_requested || 0) === 0 &&
    ciState(pr) === "success" &&
    pr.mergeable === "MERGEABLE"
  );
}

// A PR is "broken" when it has a problem its author must fix.
function isBroken(pr) {
  return (
    ciState(pr) === "failure" ||
    pr.mergeable === "CONFLICTING" ||
    (pr.changes_requested || 0) > 0
  );
}

// Whose move is it on this PR, relative to the dashboard user?
//
// Returns { owner, action, who, score, actionable }:
//   owner      "me" | "them" | "nobody" | "committer" | "queued" | "idle"
//   action     short label for the chip ("re-review", "find a reviewer", ...)
//   who        logins the PR is waiting on (owner === "them")
//   score      triage rank, higher = more urgent
//   actionable keep the row bright even with no new activity
//
// The ladder differs by tab because the user's relationship to the PR does:
// on an authored PR the user is the author, on the reviewing tab a reviewer. The
// opts.canMerge flag (or opts.mergeAccess, an org/repo list resolved per PR)
// turns "ready to merge" from a nudge into the user's own move. Time is not an
// input to ownership; it is shown beside the chip and left to the user to
// judge.
function whoseMove(pr, opts) {
  const { mergeLabels, type, mergeAccess } = opts || {};
  const mayMerge = opts && opts.canMerge !== undefined ? !!opts.canMerge : canMerge(pr, mergeAccess);
  const labeled = hasMergeLabel(pr, mergeLabels);
  const ci = ciState(pr);
  const conflict = pr.mergeable === "CONFLICTING";
  const waiting = pr.waiting_on || [];
  const mv = (owner, action, score, actionable, who) => ({ owner, action, who: who || [], score, actionable });

  if (type === "reviewing") {
    // Reviewer's ladder. First the states where my look would be wasted
    // because the author has something to do first -- a first look and a
    // re-look are the same here -- then what I owe, most specific first.
    if (pr.draft) return mv("them", "draft", 2, false, [pr.author]);
    if (labeled && !isBroken(pr)) return mv("queued", "queued for merge", 5, false);
    // A reply in my own thread is cheap and does not need green CI, so it
    // outranks the author's blockers.
    if ((pr.threads_awaiting_me || 0) > 0) return mv("me", `reply in ${pr.threads_awaiting_me} thread${pr.threads_awaiting_me > 1 ? "s" : ""}`, 70, true);
    if (conflict) return mv("them", "author rebasing", 25, false, [pr.author]);
    if (ci === "failure") return mv("them", "author fixing CI", 20, false, [pr.author]);
    // A first-time contributor's CI waits for a maintainer to approve the
    // run. Nothing moves until someone does; if I can, that is my move.
    if (ci === "action_required") {
      return mayMerge ? mv("me", "approve CI run", 50, true) : mv("committer", "CI awaits approval", 30, false);
    }
    // Someone else already asked for changes on this head: their round first.
    if (pr.my_review !== "CHANGES_REQUESTED" && (pr.changes_requested || 0) > 0) return mv("them", "addressing another review", 18, false, [pr.author]);
    // Bot feedback the author has not touched (no reply, reaction, resolve or
    // push since) says the PR is not ready for a human yet.
    if ((pr.threads_bot || 0) > 0) return mv("them", `address ${pr.threads_bot} bot thread${pr.threads_bot > 1 ? "s" : ""}`, 16, false, [pr.author]);
    if (pr.bot_verdict === "not-ready") return mv("them", "review bot: not ready", 14, false, [pr.author]);

    // Clear of the author's blockers: what do I owe?
    const age = daysOld(pr.created) > 7 ? 25 : 0;
    if (pr.my_review_requested) {
      // Re-requested after I reviewed = the author says it is ready for me
      // again. A first request is the plain review.
      if (pr.my_review || pr.my_last_look) return mv("me", "re-review requested", 85, true);
      return mv("me", "review", 60 + age, true);
    }
    if (pr.my_review === "CHANGES_REQUESTED" && pr.my_review_stale) return mv("me", "re-review: author pushed", 85, true);
    if (pr.my_review === "APPROVED" && pr.my_review_stale) return mv("me", "re-check: approved an older head", 65, true);
    if (!pr.my_review && pr.my_last_look === "stale") return mv("me", "re-look: author pushed since your comments", 62, true);
    if (!pr.my_review && !pr.my_last_look) return mv("me", "review", 60 + age, true);
    // A nudge is cheaper than a review, so it sits just under a first look.
    if (isClearToLand(pr) && !labeled) {
      return mayMerge ? mv("me", "merge", 80, true) : mv("committer", "nudge a committer", 58, true);
    }
    if (pr.my_review === "CHANGES_REQUESTED") return mv("them", "author's move", 15, false, [pr.author]);
    if (ci === "cancelled") return mv("them", "CI cancelled, needs rerun", 12, false, [pr.author]);
    if (waiting.length > 0) return mv("them", "waiting on", 10, false, waiting);
    if (!pr.my_review && pr.my_last_look === "current") return mv("them", "awaiting author's reply", 10, false, [pr.author]);
    if ((pr.approvals_current || 0) > 0 && ci !== "success") return mv("idle", "approved, CI running", 8, false);
    return mv("idle", "", 0, false);
  }

  // Authored ("open"): what remains for the author to do, most broken first.
  if (pr.draft) return mv("me", "draft", 5, false);
  if (labeled && (ci === "failure" || conflict)) return mv("me", "queued but broken", 100, true);
  if (ci === "failure") return mv("me", "fix CI", 90, true);
  if ((pr.changes_requested || 0) > 0) return mv("me", "address requested changes", 80, true);
  if (conflict) return mv("me", "rebase", 70, true);
  if ((pr.threads_awaiting_me || 0) > 0) return mv("me", `reply in ${pr.threads_awaiting_me} thread${pr.threads_awaiting_me > 1 ? "s" : ""}`, 60, true);
  if (!pr.has_human_reviewer && !labeled) return mv("nobody", "find a reviewer", 55, true);
  if (isClearToLand(pr) && !labeled) {
    return mayMerge ? mv("me", "merge", 50, true) : mv("committer", "nudge a committer", 50, true);
  }
  if (ci === "cancelled") return mv("me", "rerun cancelled CI", 45, true);
  if (labeled) return mv("queued", "queued for merge", 5, false);
  if (waiting.length > 0) return mv("them", "waiting on", 10, false, waiting);
  if ((pr.approvals_current || 0) > 0 && ci !== "success") return mv("idle", "approved, CI running", 8, false);
  return mv("idle", "", 0, false);
}

// Whether a PR needs the user's attention now — keeps it bright (undimmed)
// even with no new activity.
function isActionable(pr, opts) {
  return whoseMove(pr, opts).actionable;
}

// Triage priority (higher = more urgent), ranked per-tab.
function computeTriageScore(pr, opts) {
  return whoseMove(pr, opts).score;
}

// How many of these PRs are the user's move. Drives the stat card's big
// number: the card is lit only while this is above zero. `isPinned(pr)` adds
// rows the user pinned by hand; a pinned row that is also actionable counts once.
function countActionable(prs, opts, isPinned) {
  return (prs || []).reduce((n, pr) => n + ((isActionable(pr, opts) || (isPinned && isPinned(pr))) ? 1 : 0), 0);
}

// Local read/pin marks live in localStorage as { read_at, pinned_at } per URL.
// Earlier versions stored the bare read timestamp; accept both shapes.
function normalizeMarker(v) {
  if (!v) return {};
  if (typeof v === "string") return { read_at: v };
  const m = {};
  if (v.read_at) m.read_at = v.read_at;
  if (v.pinned_at) m.pinned_at = v.pinned_at;
  return m;
}

// The latest thing the user did on an item, from its activity feed (comments,
// reviews, commits) plus their own pushes. Empty when they never acted.
function myLastAction(item, user) {
  const mine = (item.activity || []).filter(a => a.author === user).map(a => a.created_at);
  if (item.author === user && item.last_push) mine.push(item.last_push);
  return mine.sort().pop() || "";
}

// A pin is a promise to act. It clears itself once the user has acted on the
// item after pinning it; other people's activity never clears it.
function pinStillHolds(marker, item, user) {
  const m = normalizeMarker(marker);
  if (!m.pinned_at) return false;
  const acted = myLastAction(item, user);
  return !(acted && acted > m.pinned_at);
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

// Age of the data for the header, always shown (e.g. "just now", "12 min ago",
// "2h 05m ago", "3d ago").
function dataAgeLabel(ms) {
  if (!(ms >= 0)) return "";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ${String(min % 60).padStart(2, "0")}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

if (typeof module !== "undefined") {
  module.exports = { timeAgo, daysOld, escapeAttr, formatDate, sortPRs, filterUnreadActivity, ciState, hasMergeLabel, canMerge, isClearToLand, isBroken, whoseMove, isActionable, computeTriageScore, countActionable, normalizeMarker, myLastAction, pinStillHolds, isStale, staleAgeLabel, dataAgeLabel };
}
