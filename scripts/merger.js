// Merger-role triage: which open PRs in a project need someone with merge
// rights, and why. Pure functions over the triage signals mapSignals()
// produces, so the same rules run in the fetch (to publish sections) and in
// tests. No model, no scoring: each PR lands in at most one section, and the
// sections are duties a merger does in batches.
//
//   ci       first-time contributor whose workflow runs await approval
//   queue    carries a merge label (to-be-merged); shown with its health
//   maint    reviewed only by people without write access; no committer
//            has reviewed, commented or been requested
//   land     approved by a committer on the current head, green, mergeable,
//            and still unmerged DAYS_FORGOTTEN later
//   unstick  committer-approved but conflicting/red, or changes requested
//            and the author has gone quiet for DAYS_SILENT
//
// The context tells the rules who counts as a committer and which heads have
// runs waiting; the PR carries the rest.

const MERGER_SECTIONS = ["ci", "maint", "land", "unstick", "queue"];
const DAYS_FORGOTTEN = 7;
const DAYS_SILENT = 30;

function daysBetween(iso, now) {
  if (!iso) return 0;
  return Math.floor(((now || Date.now()) - new Date(iso).getTime()) / 86400000);
}

function lower(s) { return (s || "").toLowerCase(); }

// ctx: { committers: Set<string> (lowercase logins), ciWaiting: Map<headOid, runCount>,
//        mergeLabels: string[], me: string, now?: number }
function classifyMerger(pr, ctx) {
  const now = ctx.now || Date.now();
  const committers = ctx.committers || new Set();
  const isCommitter = (login) => committers.has(lower(login));
  const reviewers = pr.reviewers || [];
  const requested = pr.requested || [];
  const labels = (pr.labels || []).map((l) => (typeof l === "string" ? l : l.name));
  const labeled = labels.some((l) => (ctx.mergeLabels || []).includes(l));
  const head = pr.head_oid || "";
  const roll = pr.ci_rollup || "";
  const conflict = pr.mergeable === "CONFLICTING";
  const mine = lower(pr.author) === lower(ctx.me);

  const waitingRuns = ctx.ciWaiting ? ctx.ciWaiting.get(head) || 0 : 0;
  if (waitingRuns > 0) {
    const gh = pr.touches_workflows ? "⚠ touches .github/" : "no .github/ changes";
    return { section: "ci", reason: `CI awaiting approval · ${waitingRuns} run${waitingRuns > 1 ? "s" : ""} · ${gh}` };
  }

  if (labeled) {
    const state = roll === "SUCCESS" ? "green" : conflict ? "conflicts" : roll === "FAILURE" || roll === "ERROR" ? "CI red" : "CI pending";
    return { section: "queue", reason: `queued · ${state}`, broken: state !== "green" };
  }

  if (pr.draft) return null;

  const committerEngaged =
    reviewers.some((r) => isCommitter(r.login)) ||
    requested.some((w) => w.startsWith("team:") || isCommitter(w));
  const community = reviewers.filter((r) => !isCommitter(r.login));
  if (!mine && community.length > 0 && !committerEngaged) {
    const states = [...new Set(community.map((r) => r.state.toLowerCase().replace("_", " ")))].sort();
    const names = community.map((r) => `@${r.login}`).join(", ");
    return { section: "maint", reason: `reviewed by ${names} (${states.join("/")}) · no committer engaged` };
  }

  const committerApprovals = reviewers.filter((r) => r.state === "APPROVED" && isCommitter(r.login));
  const currentApprovals = committerApprovals.filter((r) => !r.stale);
  const currentChangesRequested = reviewers.some((r) => r.state === "CHANGES_REQUESTED" && !r.stale);

  if (!mine && currentApprovals.length > 0 && !currentChangesRequested && roll === "SUCCESS" && pr.mergeable === "MERGEABLE") {
    const oldest = Math.max(...currentApprovals.map((r) => daysBetween(r.at, now)));
    if (oldest >= DAYS_FORGOTTEN) {
      const names = currentApprovals.map((r) => `@${r.login}`).join(", ");
      return { section: "land", reason: `approved by ${names} ${oldest}d ago · green · mergeable · not merged`, age_days: oldest };
    }
    return null;
  }

  if (committerApprovals.length > 0 && (conflict || roll === "FAILURE" || roll === "ERROR")) {
    const names = committerApprovals.map((r) => `@${r.login}`).join(", ");
    return { section: "unstick", reason: `approved by ${names} but ${conflict ? "conflicts" : "CI red"} · author's move` };
  }

  const changesRequested = reviewers.filter((r) => r.state === "CHANGES_REQUESTED");
  const authorPushedSince = changesRequested.some((r) => pr.head_pushed_at && r.at && pr.head_pushed_at > r.at);
  const idle = daysBetween(pr.updated, now);
  if (changesRequested.length > 0 && !authorPushedSince && idle > DAYS_SILENT) {
    const names = changesRequested.map((r) => `@${r.login}`).join(", ");
    return { section: "unstick", reason: `changes requested by ${names} · author silent ${idle}d` };
  }

  return null;
}

// Classify a whole list; returns { sections: {ci: [...], ...}, counts }. Each
// PR in a section carries merger_section / merger_reason for the renderer.
function buildMergerSections(prs, ctx) {
  const sections = Object.fromEntries(MERGER_SECTIONS.map((s) => [s, []]));
  for (const pr of prs) {
    const c = classifyMerger(pr, ctx);
    if (!c) continue;
    sections[c.section].push({ ...pr, merger_section: c.section, merger_reason: c.reason, merger_broken: !!c.broken });
  }
  for (const s of MERGER_SECTIONS) sections[s].sort((a, b) => new Date(a.created) - new Date(b.created));
  const counts = Object.fromEntries(MERGER_SECTIONS.map((s) => [s, sections[s].length]));
  return { sections, counts };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { MERGER_SECTIONS, DAYS_FORGOTTEN, DAYS_SILENT, classifyMerger, buildMergerSections };
}
