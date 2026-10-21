const { describe, it } = require("node:test");
const assert = require("node:assert");
const { rateLimitPolicy, MAX_RETRIES, SECONDARY_WAIT_SEC, MAX_WAIT_SEC } = require("../scripts/github.js");

const SECONDARY_BODY = JSON.stringify({ message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." });
const PRIMARY_BODY = JSON.stringify({ message: "API rate limit exceeded for user ID 1." });
const NOW = 1_700_000_000;

describe("rateLimitPolicy", () => {
  it("honors retry-after when the server names a wait", () => {
    const v = rateLimitPolicy(403, { "retry-after": "17" }, SECONDARY_BODY, MAX_RETRIES, NOW);
    assert.deepEqual(v, { retry: true, waitSec: 17, reason: "retry-after" });
  });

  it("waits a full minute for a secondary limit with no retry-after, not an exponential few seconds", () => {
    const v = rateLimitPolicy(403, {}, SECONDARY_BODY, MAX_RETRIES, NOW);
    assert.equal(v.retry, true);
    assert.equal(v.waitSec, SECONDARY_WAIT_SEC);
  });

  it("waits until x-ratelimit-reset when the primary budget is spent", () => {
    const v = rateLimitPolicy(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW + 42) }, PRIMARY_BODY, MAX_RETRIES, NOW);
    assert.equal(v.retry, true);
    assert.equal(v.waitSec, 43);
  });

  it("caps the wait so a far-off reset cannot stall the run for an hour", () => {
    const v = rateLimitPolicy(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW + 3600) }, PRIMARY_BODY, MAX_RETRIES, NOW);
    assert.equal(v.waitSec, MAX_WAIT_SEC);
  });

  it("does not retry a plain 403 that is not a rate limit", () => {
    const v = rateLimitPolicy(403, { "x-ratelimit-remaining": "4999" }, JSON.stringify({ message: "Resource not accessible by integration" }), MAX_RETRIES, NOW);
    assert.equal(v.retry, false);
  });

  it("treats a bare 429 as retryable with backoff", () => {
    const v = rateLimitPolicy(429, {}, "", MAX_RETRIES, NOW);
    assert.equal(v.retry, true);
    assert.equal(v.reason, "backoff");
    assert.equal(v.waitSec, 2);
  });

  it("gives up when retries are exhausted", () => {
    const v = rateLimitPolicy(403, {}, SECONDARY_BODY, 0, NOW);
    assert.deepEqual(v, { retry: false, reason: "out of retries" });
  });
});
