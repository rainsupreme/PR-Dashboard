const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  ciState, hasMergeLabel, isClearToLand, isBroken, isActionable, computeTriageScore, sortPRs,
} = require("../scripts/utils.js");
const { mapSignals, mapPR } = require("../scripts/fetch-prs.js");

const MERGE = ["to_be_merged"];

// Helpers to build PR fixtures
const pr = (o = {}) => ({
  url: "https://github.com/valkey-io/valkey/pull/1",
  number: 1,
  updated: "2024-01-01T00:00:00Z",
  created: "2024-01-01T00:00:00Z",
  ci_jobs: [],
  labels: [],
  ...o,
});
const jobs = (...statuses) => statuses.map((s, i) => ({ name: `job${i}`, status: s, url: "" }));

describe("mapSignals", () => {
  it("maps a full node", () => {
    const s = mapSignals({
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }, { isResolved: false }] },
    });
    assert.equal(s.review_decision, "APPROVED");
    assert.equal(s.mergeable, "MERGEABLE");
    assert.equal(s.unresolved_threads, 2);
  });

  it("defaults gracefully on null / empty", () => {
    assert.deepEqual(mapSignals(null), { review_decision: "", mergeable: "", unresolved_threads: 0 });
    const s = mapSignals({});
    assert.equal(s.review_decision, "");
    assert.equal(s.mergeable, "UNKNOWN");
    assert.equal(s.unresolved_threads, 0);
  });
});

describe("mapPR labels", () => {
  const base = {
    title: "t", number: 1,
    repository_url: "https://api.github.com/repos/valkey-io/valkey",
    html_url: "https://github.com/valkey-io/valkey/pull/1",
    user: { login: "x", avatar_url: "" },
    created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z",
  };
  it("captures label name + color", () => {
    const r = mapPR({ ...base, labels: [{ name: "to_be_merged", color: "0e8a16" }] });
    assert.deepEqual(r.labels, [{ name: "to_be_merged", color: "0e8a16" }]);
  });
  it("handles no labels", () => {
    assert.deepEqual(mapPR(base).labels, []);
  });
});

describe("ciState", () => {
  it("failure wins over pending/success", () => {
    assert.equal(ciState(pr({ ci_jobs: jobs("success", "failure", "pending") })), "failure");
  });
  it("pending when running and no failure", () => {
    assert.equal(ciState(pr({ ci_jobs: jobs("success", "pending") })), "pending");
  });
  it("success when all green", () => {
    assert.equal(ciState(pr({ ci_jobs: jobs("success", "success") })), "success");
  });
  it("empty when no jobs", () => {
    assert.equal(ciState(pr({ ci_jobs: [] })), "");
  });
});

describe("hasMergeLabel", () => {
  it("true when a configured label is present", () => {
    assert.equal(hasMergeLabel(pr({ labels: [{ name: "to_be_merged" }] }), MERGE), true);
  });
  it("false otherwise", () => {
    assert.equal(hasMergeLabel(pr({ labels: [{ name: "bug" }] }), MERGE), false);
    assert.equal(hasMergeLabel(pr({ labels: [{ name: "to_be_merged" }] }), []), false);
  });
});

describe("isClearToLand", () => {
  it("true only when approved + green + mergeable", () => {
    assert.equal(isClearToLand(pr({ review_decision: "APPROVED", mergeable: "MERGEABLE", ci_jobs: jobs("success") })), true);
  });
  it("false if any leg missing", () => {
    assert.equal(isClearToLand(pr({ review_decision: "APPROVED", mergeable: "MERGEABLE", ci_jobs: jobs("failure") })), false);
    assert.equal(isClearToLand(pr({ review_decision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", ci_jobs: jobs("success") })), false);
    assert.equal(isClearToLand(pr({ review_decision: "APPROVED", mergeable: "CONFLICTING", ci_jobs: jobs("success") })), false);
  });
});

describe("isActionable", () => {
  const opts = { mergeLabels: MERGE };
  it("flags CI failure", () => {
    assert.equal(isActionable(pr({ ci_jobs: jobs("failure") }), opts), true);
  });
  it("flags changes requested, conflict, unresolved threads", () => {
    assert.equal(isActionable(pr({ review_decision: "CHANGES_REQUESTED" }), opts), true);
    assert.equal(isActionable(pr({ mergeable: "CONFLICTING" }), opts), true);
    assert.equal(isActionable(pr({ unresolved_threads: 2 }), opts), true);
  });
  it("flags clear-to-land that is NOT yet labeled (nudge action)", () => {
    const ready = pr({ review_decision: "APPROVED", mergeable: "MERGEABLE", ci_jobs: jobs("success") });
    assert.equal(isActionable(ready, opts), true);
  });
  it("does NOT flag clear-to-land already queued by a maintainer", () => {
    const queued = pr({ review_decision: "APPROVED", mergeable: "MERGEABLE", ci_jobs: jobs("success"), labels: [{ name: "to_be_merged" }] });
    assert.equal(isActionable(queued, opts), false);
  });
  it("does NOT flag a quiet awaiting-review PR", () => {
    assert.equal(isActionable(pr({ review_decision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", ci_jobs: jobs("success") }), opts), false);
  });
});

describe("computeTriageScore tiers", () => {
  const o = (type) => ({ mergeLabels: MERGE, type });
  it("queued-but-broken is most urgent", () => {
    const s = computeTriageScore(pr({ labels: [{ name: "to_be_merged" }], ci_jobs: jobs("failure") }), o("open"));
    assert.equal(s, 100);
  });
  it("orders CI fail > changes > conflict > threads > ready-unlabeled", () => {
    const ciFail = computeTriageScore(pr({ ci_jobs: jobs("failure") }), o("open"));
    const changes = computeTriageScore(pr({ review_decision: "CHANGES_REQUESTED" }), o("open"));
    const conflict = computeTriageScore(pr({ mergeable: "CONFLICTING" }), o("open"));
    const threads = computeTriageScore(pr({ unresolved_threads: 1 }), o("open"));
    const ready = computeTriageScore(pr({ review_decision: "APPROVED", mergeable: "MERGEABLE", ci_jobs: jobs("success") }), o("open"));
    assert.ok(ciFail > changes && changes > conflict && conflict > threads && threads > ready);
  });
  it("authored ladder ignores staleness (that's a review-tab concept)", () => {
    const old = pr({ created: "2000-01-01T00:00:00Z" });
    assert.equal(computeTriageScore(old, o("open")), 0);
  });
  it("queued + healthy sinks to the bottom", () => {
    const queued = pr({ review_decision: "APPROVED", mergeable: "MERGEABLE", ci_jobs: jobs("success"), labels: [{ name: "to_be_merged" }] });
    assert.equal(computeTriageScore(queued, o("open")), 5);
  });
});

describe("sortPRs triage mode", () => {
  it("orders by urgency then recency, and is non-destructive", () => {
    const list = [
      pr({ number: 1, updated: "2024-01-05T00:00:00Z" }), // baseline 0
      pr({ number: 2, ci_jobs: jobs("failure") }),         // 90
      pr({ number: 3, mergeable: "CONFLICTING" }),         // 70
    ];
    const copy = JSON.stringify(list);
    const sorted = sortPRs(list, "triage", { type: "open", mergeLabels: MERGE });
    assert.deepEqual(sorted.map(p => p.number), [2, 3, 1]);
    assert.equal(JSON.stringify(list), copy); // original untouched
  });
  it("still supports chronological modes", () => {
    const list = [pr({ number: 1, updated: "2024-01-01T00:00:00Z" }), pr({ number: 2, updated: "2024-02-01T00:00:00Z" })];
    assert.deepEqual(sortPRs(list, "updated").map(p => p.number), [2, 1]);
  });
});

describe("incoming review scoring (review tab, ready-first)", () => {
  const o = { mergeLabels: MERGE, type: "review" };
  it("green/clean outranks broken", () => {
    assert.ok(
      computeTriageScore(pr({ ci_jobs: jobs("success") }), o) >
      computeTriageScore(pr({ ci_jobs: jobs("failure") }), o)
    );
  });
  it("a long wait on you bumps above a fresh green PR", () => {
    const fresh = computeTriageScore(pr({ ci_jobs: jobs("success"), created: new Date().toISOString() }), o);
    const stale = computeTriageScore(pr({ ci_jobs: jobs("success"), created: "2000-01-01T00:00:00Z" }), o);
    assert.ok(stale > fresh);
  });
  it("green+stale tops broken+stale", () => {
    const g = computeTriageScore(pr({ ci_jobs: jobs("success"), created: "2000-01-01T00:00:00Z" }), o);
    const b = computeTriageScore(pr({ ci_jobs: jobs("failure"), created: "2000-01-01T00:00:00Z" }), o);
    assert.ok(g > b);
  });
});

describe("outgoing review scoring (reviewed-open tab, ready-to-merge-first)", () => {
  const o = { mergeLabels: MERGE, type: "reviewed-open" };
  const ready = pr({ review_decision: "APPROVED", mergeable: "MERGEABLE", ci_jobs: jobs("success") });
  it("ready + unqueued (nudge a committer) is highest", () => {
    assert.equal(computeTriageScore(ready, o), 80);
  });
  it("orders nudge > broken > queued-healthy", () => {
    const broken = computeTriageScore(pr({ review_decision: "CHANGES_REQUESTED", ci_jobs: jobs("success") }), o);
    const queued = computeTriageScore(pr({ ...ready, labels: [{ name: "to_be_merged" }] }), o);
    assert.ok(computeTriageScore(ready, o) > broken && broken > queued);
  });
});

describe("per-tab isActionable", () => {
  it("review tab: green actionable, CI-failing not", () => {
    assert.equal(isActionable(pr({ ci_jobs: jobs("success") }), { type: "review", mergeLabels: MERGE }), true);
    assert.equal(isActionable(pr({ ci_jobs: jobs("failure") }), { type: "review", mergeLabels: MERGE }), false);
  });
  it("reviewed-open: ready-unqueued & threads actionable; queued/broken not", () => {
    const o = { type: "reviewed-open", mergeLabels: MERGE };
    assert.equal(isActionable(pr({ review_decision: "APPROVED", mergeable: "MERGEABLE", ci_jobs: jobs("success") }), o), true);
    assert.equal(isActionable(pr({ unresolved_threads: 1 }), o), true);
    assert.equal(isActionable(pr({ review_decision: "APPROVED", mergeable: "MERGEABLE", ci_jobs: jobs("success"), labels: [{ name: "to_be_merged" }] }), o), false);
    assert.equal(isActionable(pr({ ci_jobs: jobs("failure") }), o), false);
  });
});

// (1) sortPRs("triage") end-to-end for the review + reviewed-open tabs
describe("sortPRs triage — review tab (ready-first)", () => {
  const o = { type: "review", mergeLabels: MERGE };
  it("orders green+stale > green+fresh > CI-failing", () => {
    const list = [
      pr({ number: 1, ci_jobs: jobs("failure"), created: new Date().toISOString() }),   // 20
      pr({ number: 2, ci_jobs: jobs("success"), created: new Date().toISOString() }),   // 60
      pr({ number: 3, ci_jobs: jobs("success"), created: "2000-01-01T00:00:00Z" }),      // 85
    ];
    assert.deepEqual(sortPRs(list, "triage", o).map(p => p.number), [3, 2, 1]);
  });
});

describe("sortPRs triage — reviewed-open tab (nudge-first)", () => {
  const o = { type: "reviewed-open", mergeLabels: MERGE };
  it("orders nudge > broken > queued-healthy", () => {
    const ready = { review_decision: "APPROVED", mergeable: "MERGEABLE", ci_jobs: jobs("success") };
    const list = [
      pr({ number: 1, ...ready, labels: [{ name: "to_be_merged" }] }),      // 5 queued-healthy
      pr({ number: 2, review_decision: "CHANGES_REQUESTED", ci_jobs: jobs("success") }), // 15 broken
      pr({ number: 3, ...ready }),                                            // 80 nudge
    ];
    assert.deepEqual(sortPRs(list, "triage", o).map(p => p.number), [3, 2, 1]);
  });
});

// (2) Pending CI: not ready, not broken, and scored the same as green on review
describe("pending CI semantics", () => {
  const p = pr({ review_decision: "APPROVED", mergeable: "MERGEABLE", ci_jobs: jobs("pending") });
  it("ciState reports pending", () => {
    assert.equal(ciState(p), "pending");
  });
  it("pending is neither clear-to-land nor broken", () => {
    assert.equal(isClearToLand(p), false); // needs success, not pending
    assert.equal(isBroken(p), false);      // pending is not a failure
  });
  it("review tab scores pending same as green (not failing)", () => {
    const pending = computeTriageScore(pr({ ci_jobs: jobs("pending"), created: new Date().toISOString() }), { type: "review" });
    const green = computeTriageScore(pr({ ci_jobs: jobs("success"), created: new Date().toISOString() }), { type: "review" });
    assert.equal(pending, green);
    assert.equal(pending, 60);
  });
  it("authored tab scores a pending-only PR as baseline", () => {
    assert.equal(computeTriageScore(pr({ ci_jobs: jobs("pending") }), { type: "open", mergeLabels: MERGE }), 0);
  });
});

// (3) Explicit assertions for the outgoing 60 (nearly-ready) and 40 (threads) tiers
describe("outgoing review scoring — nearly-ready and threads tiers", () => {
  const o = { type: "reviewed-open", mergeLabels: MERGE };
  it("approved + green + mergeable UNKNOWN scores 60 (nearly ready)", () => {
    assert.equal(computeTriageScore(pr({ review_decision: "APPROVED", mergeable: "UNKNOWN", ci_jobs: jobs("success") }), o), 60);
  });
  it("unresolved threads (not broken/approved/labelled) scores 40", () => {
    assert.equal(computeTriageScore(pr({ review_decision: "REVIEW_REQUIRED", ci_jobs: jobs("success"), unresolved_threads: 2 }), o), 40);
  });
});

// (4) mapPR handles string-form labels (GitHub returns either shape)
describe("mapPR string-form labels", () => {
  const base = {
    title: "t", number: 1,
    repository_url: "https://api.github.com/repos/valkey-io/valkey",
    html_url: "https://github.com/valkey-io/valkey/pull/1",
    user: { login: "x", avatar_url: "" },
    created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z",
  };
  it("normalizes string labels to {name,color:''}", () => {
    assert.deepEqual(mapPR({ ...base, labels: ["to_be_merged"] }).labels, [{ name: "to_be_merged", color: "" }]);
  });
});

// (5) daysOld > 7 boundary in the review-tab stale bump
describe("review stale bump boundary (strict > 7)", () => {
  const o = { type: "review" };
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  it("exactly 7 days => no bump (60)", () => {
    assert.equal(computeTriageScore(pr({ ci_jobs: jobs("success"), created: daysAgo(7) }), o), 60);
  });
  it("8 days => bump (85)", () => {
    assert.equal(computeTriageScore(pr({ ci_jobs: jobs("success"), created: daysAgo(8) }), o), 85);
  });
});
