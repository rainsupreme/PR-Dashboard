const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { priorUsable, priorIndex, reuseActivity, reuseCI, MAX_ACTIVITY_AGE_MS } = require("../scripts/fetch-prs.js");

const NOW = Date.parse("2026-10-21T12:00:00Z");
const fetchedAt = (agoMs) => new Date(NOW - agoMs).toISOString();

describe("priorUsable", () => {
  const prior = { github_user: "rain", orgs: ["valkey-io", "other"] };
  it("accepts the same user and org set in any order", () => {
    assert.equal(priorUsable(prior, "rain", ["other", "valkey-io"]), true);
  });
  it("rejects another user, another org set, and garbage", () => {
    assert.equal(priorUsable(prior, "someone", ["valkey-io", "other"]), false);
    assert.equal(priorUsable(prior, "rain", ["valkey-io"]), false);
    assert.equal(priorUsable(null, "rain", []), false);
    assert.equal(priorUsable("nope", "rain", []), false);
  });
});

describe("priorIndex", () => {
  it("indexes every in-flight list by url and tolerates missing lists", () => {
    const idx = priorIndex({ reviewing: [{ url: "a" }], open_prs: [{ url: "b" }], issues: [{ url: "c" }], mentions: [{ url: "d" }] });
    assert.deepEqual([...idx.keys()], ["a", "b", "c", "d"]);
    assert.equal(priorIndex({ reviewing: [{ url: "a" }] }).size, 1);
    assert.equal(priorIndex(null).size, 0);
  });
});

describe("reuseActivity", () => {
  const item = { url: "u", updated: "2026-10-21T10:00:00Z" };
  const prior = { url: "u", updated: "2026-10-21T10:00:00Z", activity: [], activity_fetched_at: fetchedAt(60 * 60 * 1000) };

  it("reuses when updated_at is unchanged and the cache is fresh", () => {
    assert.equal(reuseActivity(prior, item, NOW), prior);
  });
  it("misses when updated_at moved", () => {
    assert.equal(reuseActivity(prior, { ...item, updated: "2026-10-21T11:00:00Z" }, NOW), null);
  });
  it("misses on a snapshot from before the cache stamp existed", () => {
    const { activity_fetched_at, ...legacy } = prior;
    assert.equal(reuseActivity(legacy, item, NOW), null);
  });
  it("misses once the cached activity is older than the age bound", () => {
    const old = { ...prior, activity_fetched_at: fetchedAt(MAX_ACTIVITY_AGE_MS + 1) };
    assert.equal(reuseActivity(old, item, NOW), null);
    const edge = { ...prior, activity_fetched_at: fetchedAt(MAX_ACTIVITY_AGE_MS) };
    assert.equal(reuseActivity(edge, item, NOW), edge);
  });
  it("misses with no prior, or a prior without activity", () => {
    assert.equal(reuseActivity(undefined, item, NOW), null);
    assert.equal(reuseActivity({ ...prior, activity: undefined }, item, NOW), null);
  });
});

describe("reuseCI", () => {
  const jobs = [{ name: "build", status: "success", url: "" }];
  const prior = { head_oid: "abc", ci_rollup: "SUCCESS", ci_jobs: jobs };

  it("reuses check-runs for the same head with the same settled rollup", () => {
    assert.equal(reuseCI(prior, { head_oid: "abc", ci_rollup: "SUCCESS" }), jobs);
    assert.equal(reuseCI({ ...prior, ci_rollup: "FAILURE" }, { head_oid: "abc", ci_rollup: "FAILURE" }), jobs);
  });
  it("misses on a new head", () => {
    assert.equal(reuseCI(prior, { head_oid: "def", ci_rollup: "SUCCESS" }), null);
  });
  it("misses while CI is running or has no rollup (a rerun passes through PENDING)", () => {
    assert.equal(reuseCI({ ...prior, ci_rollup: "PENDING" }, { head_oid: "abc", ci_rollup: "PENDING" }), null);
    assert.equal(reuseCI({ ...prior, ci_rollup: "" }, { head_oid: "abc", ci_rollup: "" }), null);
  });
  it("misses when the rollup changed, even between settled states", () => {
    assert.equal(reuseCI(prior, { head_oid: "abc", ci_rollup: "FAILURE" }), null);
  });
  it("misses with no prior, no head, or no cached jobs", () => {
    assert.equal(reuseCI(undefined, { head_oid: "abc", ci_rollup: "SUCCESS" }), null);
    assert.equal(reuseCI(prior, { head_oid: "", ci_rollup: "SUCCESS" }), null);
    assert.equal(reuseCI({ ...prior, ci_jobs: undefined }, { head_oid: "abc", ci_rollup: "SUCCESS" }), null);
  });
});

describe("isRateLimited", () => {
  const { isRateLimited } = require("../scripts/fetch-prs.js");
  it("treats 429, Retry-After, an exhausted budget, and a rate-limit body as rate limits", () => {
    assert.equal(isRateLimited(429, {}, ""), true);
    assert.equal(isRateLimited(403, { "retry-after": "60" }, ""), true);
    assert.equal(isRateLimited(403, { "x-ratelimit-remaining": "0" }, ""), true);
    assert.equal(isRateLimited(403, {}, '{"message":"API rate limit exceeded for installation"}'), true);
    assert.equal(isRateLimited(403, {}, '{"message":"You have exceeded a secondary rate limit."}'), true);
  });
  it("does not retry a permission 403 or any other status", () => {
    assert.equal(isRateLimited(403, { "x-ratelimit-remaining": "4990" }, '{"message":"Resource not accessible by integration"}'), false);
    assert.equal(isRateLimited(403, {}, '{"message":"Must have push access to view repository collaborators."}'), false);
    assert.equal(isRateLimited(404, {}, ""), false);
    assert.equal(isRateLimited(200, {}, ""), false);
  });
});
