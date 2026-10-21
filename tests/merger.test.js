const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { classifyMerger, buildMergerSections, DAYS_FORGOTTEN, DAYS_SILENT } = require("../scripts/merger.js");

const NOW = new Date("2026-10-21T00:00:00Z").getTime();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const ctx = (over) => ({
  committers: new Set(["alice", "bob"]),
  ciWaiting: new Map(),
  mergeLabels: ["to-be-merged"],
  me: "rain",
  now: NOW,
  ...over,
});
const pr = (over) => ({
  number: 1, url: "https://github.com/o/r/pull/1", author: "contributor", draft: false,
  created: daysAgo(40), updated: daysAgo(1), head_oid: "h2", head_pushed_at: daysAgo(10),
  mergeable: "MERGEABLE", ci_rollup: "SUCCESS", labels: [], reviewers: [], requested: [],
  ...over,
});
const rev = (login, state, days, stale = false) => ({ login, state, at: daysAgo(days), stale });

describe("classifyMerger: Let CI run", () => {
  it("fires when runs await approval on the head, naming .github/ exposure", () => {
    const c = classifyMerger(pr({ head_oid: "h2" }), ctx({ ciWaiting: new Map([["h2", 9]]) }));
    assert.equal(c.section, "ci");
    assert.match(c.reason, /9 runs · no \.github\/ changes/);
    const w = classifyMerger(pr({ touches_workflows: true }), ctx({ ciWaiting: new Map([["h2", 1]]) }));
    assert.match(w.reason, /1 run · ⚠ touches \.github\//);
  });
  it("outranks everything else, including drafts and the queue", () => {
    const c = classifyMerger(pr({ draft: true, labels: ["to-be-merged"] }), ctx({ ciWaiting: new Map([["h2", 2]]) }));
    assert.equal(c.section, "ci");
  });
});

describe("classifyMerger: queue", () => {
  it("labelled PRs land in queue with their health, green or not", () => {
    assert.deepEqual(classifyMerger(pr({ labels: ["to-be-merged"] }), ctx()), { section: "queue", reason: "queued · green", broken: false });
    const red = classifyMerger(pr({ labels: [{ name: "to-be-merged" }], ci_rollup: "FAILURE" }), ctx());
    assert.equal(red.reason, "queued · CI red"); assert.equal(red.broken, true);
    assert.equal(classifyMerger(pr({ labels: ["to-be-merged"], mergeable: "CONFLICTING", ci_rollup: "" }), ctx()).reason, "queued · conflicts");
  });
});

describe("classifyMerger: drafts and nothing-to-do", () => {
  it("drafts are skipped (unless CI is waiting)", () => {
    assert.equal(classifyMerger(pr({ draft: true, reviewers: [rev("zed", "APPROVED", 3)] }), ctx()), null);
  });
  it("a PR nobody has reviewed is not the merger's problem here", () => {
    assert.equal(classifyMerger(pr(), ctx()), null);
  });
  it("a PR a committer is already on, but not ready, is theirs", () => {
    assert.equal(classifyMerger(pr({ reviewers: [rev("alice", "COMMENTED", 2)] }), ctx()), null);
    assert.equal(classifyMerger(pr({ requested: ["bob"] }), ctx()), null);
  });
});

describe("classifyMerger: Needs a maintainer", () => {
  it("community review with no committer engaged", () => {
    const c = classifyMerger(pr({ reviewers: [rev("zed", "APPROVED", 5), rev("yan", "COMMENTED", 3)] }), ctx());
    assert.equal(c.section, "maint");
    assert.equal(c.reason, "reviewed by @zed, @yan (approved/commented) · no committer engaged");
  });
  it("a committer request, a team request, or a committer review all count as engaged", () => {
    const base = { reviewers: [rev("zed", "APPROVED", 5)] };
    assert.equal(classifyMerger(pr({ ...base, requested: ["alice"] }), ctx()), null);
    assert.equal(classifyMerger(pr({ ...base, requested: ["team:core"] }), ctx()), null);
    assert.equal(classifyMerger(pr({ reviewers: [rev("zed", "APPROVED", 5), rev("bob", "COMMENTED", 1)] }), ctx()), null);
  });
  it("committer logins match case-insensitively", () => {
    assert.equal(classifyMerger(pr({ reviewers: [rev("Alice", "COMMENTED", 1), rev("zed", "APPROVED", 2)] }), ctx()), null);
  });
  it("never on my own PR: I cannot be the maintainer who approves it", () => {
    assert.equal(classifyMerger(pr({ author: "rain", reviewers: [rev("zed", "APPROVED", 5)] }), ctx()), null);
  });
});

describe("classifyMerger: To Land (forgotten landings)", () => {
  it("committer-approved on the head, green, mergeable, unmerged for DAYS_FORGOTTEN", () => {
    const c = classifyMerger(pr({ reviewers: [rev("alice", "APPROVED", DAYS_FORGOTTEN)] }), ctx());
    assert.equal(c.section, "land");
    assert.equal(c.reason, `approved by @alice ${DAYS_FORGOTTEN}d ago · green · mergeable · not merged`);
    assert.equal(c.age_days, DAYS_FORGOTTEN);
  });
  it("a fresh approval is not forgotten yet", () => {
    assert.equal(classifyMerger(pr({ reviewers: [rev("alice", "APPROVED", DAYS_FORGOTTEN - 1)] }), ctx()), null);
  });
  it("a stale approval, a current changes-request, red CI or conflicts disqualify it", () => {
    assert.notEqual((classifyMerger(pr({ reviewers: [rev("alice", "APPROVED", 20, true)] }), ctx()) || {}).section, "land");
    assert.equal(classifyMerger(pr({ reviewers: [rev("alice", "APPROVED", 20), rev("bob", "CHANGES_REQUESTED", 2)] }), ctx()), null);
    assert.notEqual((classifyMerger(pr({ reviewers: [rev("alice", "APPROVED", 20)], ci_rollup: "PENDING" }), ctx()) || {}).section, "land");
  });
  it("a community approval alone is 'maint', not 'land'", () => {
    assert.equal(classifyMerger(pr({ reviewers: [rev("zed", "APPROVED", 20)] }), ctx()).section, "maint");
  });
});

describe("classifyMerger: Unstick", () => {
  it("committer-approved but conflicting or red is the author's move, surfaced", () => {
    const c = classifyMerger(pr({ reviewers: [rev("alice", "APPROVED", 20, true)], mergeable: "CONFLICTING" }), ctx());
    assert.equal(c.section, "unstick");
    assert.equal(c.reason, "approved by @alice but conflicts · author's move");
    assert.match(classifyMerger(pr({ reviewers: [rev("bob", "APPROVED", 2)], ci_rollup: "FAILURE" }), ctx()).reason, /CI red/);
  });
  it("changes requested and the author silent past DAYS_SILENT", () => {
    const c = classifyMerger(pr({ reviewers: [rev("alice", "CHANGES_REQUESTED", 50)], head_pushed_at: daysAgo(60), updated: daysAgo(DAYS_SILENT + 1) }), ctx());
    assert.equal(c.section, "unstick");
    assert.equal(c.reason, `changes requested by @alice · author silent ${DAYS_SILENT + 1}d`);
  });
  it("not when the author has pushed since the request, or is still active", () => {
    assert.equal(classifyMerger(pr({ reviewers: [rev("alice", "CHANGES_REQUESTED", 50)], head_pushed_at: daysAgo(40), updated: daysAgo(40) }), ctx()), null);
    assert.equal(classifyMerger(pr({ reviewers: [rev("alice", "CHANGES_REQUESTED", 50)], head_pushed_at: daysAgo(60), updated: daysAgo(3) }), ctx()), null);
  });
});

describe("buildMergerSections", () => {
  it("puts each PR in at most one section, oldest first, with counts", () => {
    const prs = [
      pr({ number: 1, created: daysAgo(10), reviewers: [rev("zed", "APPROVED", 5)] }),
      pr({ number: 2, created: daysAgo(90), reviewers: [rev("yan", "COMMENTED", 5)] }),
      pr({ number: 3, created: daysAgo(5), reviewers: [rev("alice", "APPROVED", 9)] }),
      pr({ number: 4, head_oid: "h9" }),
      pr({ number: 5 }),
    ];
    const { sections, counts } = buildMergerSections(prs, ctx({ ciWaiting: new Map([["h9", 3]]) }));
    assert.deepEqual(counts, { ci: 1, maint: 2, land: 1, unstick: 0, queue: 0 });
    assert.deepEqual(sections.maint.map((p) => p.number), [2, 1]);
    assert.equal(sections.land[0].merger_section, "land");
    assert.match(sections.ci[0].merger_reason, /3 runs/);
  });
});
