const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { flakeFor, ciFlakes, ciState } = require("../scripts/utils.js");
const { flakeJobEntries, refreshFlakeIssueStates } = require("../scripts/fetch-prs.js");

// A registry as valkey-daily-dashboard writes it: job-level entries are
// named `<job>: unattributed failure`; test-level ones carry a tcl test title.
const registry = {
  version: 1,
  entries: [
    { id: "sig:rdma", test_name: "test-rdma: unattributed failure", issue: 4964, issue_state: "open", issue_title: "RDMA CI setup fails" },
    { id: "sig:fixed", test_name: "test-freebsd: unattributed failure", issue: 100, issue_state: "closed", fix_pr: 101, fix_sha: "abc123" },
    { id: "sig:closed", test_name: "test-macos-latest: unattributed failure", issue: 200, issue_state: "closed" },
    { id: "sig:unknown", test_name: "test-sanitizer-address: unattributed failure", issue: 300 },
    { id: "sig:test", test_name: "Active defrag - AOF loading in tests/unit/memefficiency.tcl", issue: 3954, issue_state: "open" },
    { id: "sig:noowner", test_name: "test-orphan: unattributed failure" },
  ],
};
const flakes = { source: "x", repo: "valkey-io/valkey", fetched_at: "2026-10-24T00:00:00Z", jobs: flakeJobEntries(registry) };

const job = (name, status = "failure") => ({ name, status, url: "" });
const VALKEY = { url: "https://github.com/valkey-io/valkey/pull/4954" };
const GLIDE = { url: "https://github.com/valkey-io/valkey-glide/pull/12" };

describe("flakeJobEntries", () => {
  it("keeps job-level entries that something tracks, with the job name split out", () => {
    assert.deepEqual(flakes.jobs.map((e) => e.job), ["test-rdma", "test-freebsd", "test-macos-latest", "test-sanitizer-address"]);
    assert.equal(flakes.jobs[0].issue, 4964);
    assert.equal(flakes.jobs[0].issue_title, "RDMA CI setup fails");
    assert.equal(flakes.jobs[1].fix_sha, "abc123");
  });
  it("drops test-level entries and entries nobody owns", () => {
    const ids = flakes.jobs.map((e) => e.id);
    assert.ok(!ids.includes("sig:test"));
    assert.ok(!ids.includes("sig:noowner"));
  });
  it("tolerates a missing or malformed registry", () => {
    assert.deepEqual(flakeJobEntries(null), []);
    assert.deepEqual(flakeJobEntries({}), []);
    assert.deepEqual(flakeJobEntries({ entries: [{ issue: 1 }] }), []);
  });
});

describe("flakeFor", () => {
  it("matches a failed job by exact name while the issue is open", () => {
    assert.equal(flakeFor(job("test-rdma"), flakes, VALKEY).issue, 4964);
    assert.equal(flakeFor(job("test-rdma (extra)"), flakes, VALKEY), null);
  });
  it("applies when the issue state is unknown (never refreshed)", () => {
    assert.equal(flakeFor(job("test-sanitizer-address"), flakes, VALKEY).issue, 300);
  });
  it("does not apply a fixed entry or a closed-without-fix entry", () => {
    assert.equal(flakeFor(job("test-freebsd"), flakes, VALKEY), null);
    assert.equal(flakeFor(job("test-macos-latest"), flakes, VALKEY), null);
  });
  it("only annotates failures", () => {
    for (const st of ["success", "pending", "cancelled", "action_required"]) {
      assert.equal(flakeFor(job("test-rdma", st), flakes, VALKEY), null, st);
    }
  });
  it("is null without a registry", () => {
    assert.equal(flakeFor(job("test-rdma"), null, VALKEY), null);
    assert.equal(flakeFor(job("test-rdma"), { jobs: null }, VALKEY), null);
  });
  it("never crosses repositories: the registry describes one repo", () => {
    assert.equal(flakeFor(job("test-rdma"), flakes, GLIDE), null);
    assert.equal(flakeFor(job("test-rdma"), flakes, { url: "" }), null);
    assert.equal(flakeFor(job("test-rdma"), { ...flakes, repo: "" }, VALKEY), null);
    assert.equal(flakeFor(job("test-rdma"), { ...flakes, repo: "Valkey-IO/Valkey" }, VALKEY).issue, 4964);
  });
});

describe("ciFlakes", () => {
  it("reports every red job tracked", () => {
    const pr = { ...VALKEY, ci_jobs: [job("test-rdma"), job("test-ubuntu", "success")] };
    const r = ciFlakes(pr, flakes);
    assert.equal(r.red, 1);
    assert.equal(r.tracked.length, 1);
    assert.equal(r.all, true);
  });
  it("reports a mix", () => {
    const pr = { ...VALKEY, ci_jobs: [job("test-rdma"), job("test-ubuntu")] };
    const r = ciFlakes(pr, flakes);
    assert.deepEqual([r.red, r.tracked.length, r.all], [2, 1, false]);
  });
  it("is never 'all' with no red jobs", () => {
    assert.equal(ciFlakes({ ...VALKEY, ci_jobs: [job("test-ubuntu", "success")] }, flakes).all, false);
    assert.equal(ciFlakes({}, flakes).all, false);
  });
  it("leaves ciState alone: a tracked flake is still a failure", () => {
    const pr = { ...VALKEY, ci_jobs: [job("test-rdma")] };
    assert.equal(ciFlakes(pr, flakes).all, true);
    assert.equal(ciState(pr), "failure");
  });
  it("a red job on another repo is just a red job", () => {
    const pr = { ...GLIDE, ci_jobs: [job("test-rdma")] };
    assert.deepEqual([ciFlakes(pr, flakes).tracked.length, ciFlakes(pr, flakes).all], [0, false]);
  });
});

describe("refreshFlakeIssueStates", () => {
  it("overwrites the cached state and title with the live issue", async () => {
    const jobs = flakeJobEntries(registry).filter((e) => e.job === "test-rdma");
    assert.equal(jobs[0].issue_state, "open");
    const seen = [];
    await refreshFlakeIssueStates(jobs, "valkey-io/valkey", async (url) => { seen.push(url); return { body: { state: "closed", title: "fixed now" } }; });
    assert.deepEqual(seen, ["https://api.github.com/repos/valkey-io/valkey/issues/4964"]);
    assert.equal(jobs[0].issue_state, "closed");
    assert.equal(jobs[0].issue_title, "fixed now");
    assert.equal(flakeFor(job("test-rdma"), { repo: "valkey-io/valkey", jobs }, VALKEY), null);
  });
  it("keeps the cached state when the lookup fails", async () => {
    const jobs = flakeJobEntries(registry).filter((e) => e.job === "test-rdma");
    const warn = console.warn; console.warn = () => {};
    try {
      await refreshFlakeIssueStates(jobs, "valkey-io/valkey", async () => { throw new Error("HTTP 503"); });
    } finally { console.warn = warn; }
    assert.equal(jobs[0].issue_state, "open");
  });
  it("skips entries with no issue", async () => {
    const jobs = [{ job: "x", issue: null, fix_pr: 7, issue_state: "" }];
    let calls = 0;
    await refreshFlakeIssueStates(jobs, "valkey-io/valkey", async () => { calls++; return { body: {} }; });
    assert.equal(calls, 0);
  });
});
