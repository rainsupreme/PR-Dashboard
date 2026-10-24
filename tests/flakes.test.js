const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { flakeFor, ciFlakes, ciState } = require("../scripts/utils.js");
const { flakeJobEntries } = require("../scripts/fetch-prs.js");

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
const flakes = { source: "x", fetched_at: "2026-10-24T00:00:00Z", jobs: flakeJobEntries(registry) };

const job = (name, status = "failure") => ({ name, status, url: "" });

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
    assert.equal(flakeFor(job("test-rdma"), flakes).issue, 4964);
    assert.equal(flakeFor(job("test-rdma (extra)"), flakes), null);
  });
  it("applies when the issue state is unknown (never refreshed)", () => {
    assert.equal(flakeFor(job("test-sanitizer-address"), flakes).issue, 300);
  });
  it("does not apply a fixed entry or a closed-without-fix entry", () => {
    assert.equal(flakeFor(job("test-freebsd"), flakes), null);
    assert.equal(flakeFor(job("test-macos-latest"), flakes), null);
  });
  it("only annotates failures", () => {
    for (const st of ["success", "pending", "cancelled", "action_required"]) {
      assert.equal(flakeFor(job("test-rdma", st), flakes), null, st);
    }
  });
  it("is null without a registry", () => {
    assert.equal(flakeFor(job("test-rdma"), null), null);
    assert.equal(flakeFor(job("test-rdma"), { jobs: null }), null);
  });
});

describe("ciFlakes", () => {
  it("reports every red job tracked", () => {
    const pr = { ci_jobs: [job("test-rdma"), job("test-ubuntu", "success")] };
    const r = ciFlakes(pr, flakes);
    assert.equal(r.red, 1);
    assert.equal(r.tracked.length, 1);
    assert.equal(r.all, true);
  });
  it("reports a mix", () => {
    const pr = { ci_jobs: [job("test-rdma"), job("test-ubuntu")] };
    const r = ciFlakes(pr, flakes);
    assert.deepEqual([r.red, r.tracked.length, r.all], [2, 1, false]);
  });
  it("is never 'all' with no red jobs", () => {
    assert.equal(ciFlakes({ ci_jobs: [job("test-ubuntu", "success")] }, flakes).all, false);
    assert.equal(ciFlakes({}, flakes).all, false);
  });
  it("leaves ciState alone: a tracked flake is still a failure", () => {
    const pr = { ci_jobs: [job("test-rdma")] };
    assert.equal(ciFlakes(pr, flakes).all, true);
    assert.equal(ciState(pr), "failure");
  });
});
