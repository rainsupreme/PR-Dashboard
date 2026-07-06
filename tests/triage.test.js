const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  ciState, hasMergeLabel, isClearToLand, isActionable, computeTriageScore, sortPRs,
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
  it("stale review request scores on the review tab only", () => {
    const old = pr({ created: "2000-01-01T00:00:00Z" });
    assert.equal(computeTriageScore(old, o("review")), 40);
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
