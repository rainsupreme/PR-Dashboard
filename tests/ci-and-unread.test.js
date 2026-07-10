const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { filterUnreadActivity } = require("../scripts/utils.js");
const { fetchCIStatus } = require("../scripts/fetch-prs.js");

// Replicate getUnreadActivity logic from dashboard.js for testing
function getUnreadActivity(pr, githubUser, readMarkers = {}) {
  if (!pr.activity || pr.activity.length === 0) return [];
  let since;
  if (readMarkers[pr.url]) {
    since = readMarkers[pr.url];
  } else if (githubUser && pr.author !== githubUser) {
    since = pr.my_last_interaction || pr.created;
  } else {
    since = pr.last_push || pr.created;
  }
  return filterUnreadActivity(pr.activity, since);
}

describe("getUnreadActivity context-aware logic", () => {
  const activity = [
    { created_at: "2026-06-20T10:00:00Z", type: "comment", author: "alice" },
    { created_at: "2026-06-19T08:00:00Z", type: "review", author: "rainsupreme" },
    { created_at: "2026-06-18T12:00:00Z", type: "comment", author: "bob" },
    { created_at: "2026-06-17T09:00:00Z", type: "commit", author: "alice" },
  ];

  it("my PR: uses last_push as anchor", () => {
    const pr = { url: "https://x", author: "rainsupreme", last_push: "2026-06-19T00:00:00Z", created: "2026-06-15T00:00:00Z", activity };
    const unread = getUnreadActivity(pr, "rainsupreme");
    // Only activity after last_push: alice's comment on 6/20 and my review on 6/19T08
    assert.equal(unread.length, 2);
  });

  it("others PR: uses my_last_interaction as anchor", () => {
    const pr = { url: "https://x", author: "alice", last_push: "2026-06-17T00:00:00Z", created: "2026-06-15T00:00:00Z", my_last_interaction: "2026-06-19T08:00:00Z", activity };
    const unread = getUnreadActivity(pr, "rainsupreme");
    // Only activity after my last interaction: alice's comment on 6/20
    assert.equal(unread.length, 1);
    assert.equal(unread[0].author, "alice");
  });

  it("others PR with no interaction: uses PR created date", () => {
    const pr = { url: "https://x", author: "alice", last_push: "2026-06-17T00:00:00Z", created: "2026-06-15T00:00:00Z", my_last_interaction: "", activity };
    const unread = getUnreadActivity(pr, "rainsupreme");
    // All activity after created date
    assert.equal(unread.length, 4);
  });

  it("read marker overrides all other anchors", () => {
    const pr = { url: "https://x", author: "alice", last_push: "2026-06-17T00:00:00Z", created: "2026-06-15T00:00:00Z", my_last_interaction: "2026-06-19T08:00:00Z", activity };
    const markers = { "https://x": "2026-06-20T00:00:00Z" };
    const unread = getUnreadActivity(pr, "rainsupreme", markers);
    // Only alice's comment on 6/20T10:00 is after the marker
    assert.equal(unread.length, 1);
  });

  it("no githubUser falls back to last_push logic", () => {
    const pr = { url: "https://x", author: "alice", last_push: "2026-06-19T00:00:00Z", created: "2026-06-15T00:00:00Z", activity };
    const unread = getUnreadActivity(pr, "");
    assert.equal(unread.length, 2);
  });
});

describe("my_last_interaction computation", () => {
  it("finds most recent non-commit event by user", () => {
    const activity = [
      { created_at: "2026-06-20T10:00:00Z", type: "comment", author: "alice" },
      { created_at: "2026-06-19T08:00:00Z", type: "review", author: "rainsupreme" },
      { created_at: "2026-06-18T12:00:00Z", type: "commit", author: "rainsupreme" },
      { created_at: "2026-06-17T09:00:00Z", type: "comment", author: "rainsupreme" },
    ];
    const myEvents = activity.filter(a => a.author === "rainsupreme" && a.type !== "commit");
    const my_last_interaction = myEvents.length > 0 ? myEvents[0].created_at : "";
    assert.equal(my_last_interaction, "2026-06-19T08:00:00Z");
  });

  it("returns empty string when user has no non-commit activity", () => {
    const activity = [
      { created_at: "2026-06-20T10:00:00Z", type: "comment", author: "alice" },
      { created_at: "2026-06-18T12:00:00Z", type: "commit", author: "rainsupreme" },
    ];
    const myEvents = activity.filter(a => a.author === "rainsupreme" && a.type !== "commit");
    const my_last_interaction = myEvents.length > 0 ? myEvents[0].created_at : "";
    assert.equal(my_last_interaction, "");
  });

  it("returns empty string for empty activity", () => {
    const activity = [];
    const myEvents = activity.filter(a => a.author === "rainsupreme" && a.type !== "commit");
    const my_last_interaction = myEvents.length > 0 ? myEvents[0].created_at : "";
    assert.equal(my_last_interaction, "");
  });
});

describe("fetchCIStatus", () => {
  it("returns empty ci_jobs for null sha", async () => {
    const result = await fetchCIStatus("https://api.github.com/repos/x/y", "");
    assert.deepEqual(result, { ci_jobs: [] });
  });

  it("returns empty ci_jobs for null sha (explicit null)", async () => {
    const result = await fetchCIStatus("https://api.github.com/repos/x/y", null);
    assert.deepEqual(result, { ci_jobs: [] });
  });
});

describe("issue unread anchor (comments after your last reply)", () => {
  const comments = [
    { created_at: "2026-06-28T10:00:00Z", type: "comment", author: "alice" },
    { created_at: "2026-07-01T09:00:00Z", type: "comment", author: "rainsupreme" }, // my last reply
    { created_at: "2026-07-03T12:00:00Z", type: "comment", author: "bob" },         // after -> unread
  ];

  it("assigned issue (someone else authored): unread = comments after my last reply", () => {
    const issue = { url: "https://x/1", author: "alice", created: "2026-06-01T00:00:00Z",
      my_last_interaction: "2026-07-01T09:00:00Z", last_push: "2026-07-01T09:00:00Z", activity: comments };
    const unread = getUnreadActivity(issue, "rainsupreme");
    assert.equal(unread.length, 1);
    assert.equal(unread[0].author, "bob");
  });

  it("issue I authored: anchor still my last reply (via last_push)", () => {
    const issue = { url: "https://x/2", author: "rainsupreme", created: "2026-06-01T00:00:00Z",
      my_last_interaction: "2026-07-01T09:00:00Z", last_push: "2026-07-01T09:00:00Z", activity: comments };
    const unread = getUnreadActivity(issue, "rainsupreme");
    assert.equal(unread.length, 1);
    assert.equal(unread[0].author, "bob");
  });

  it("never replied: anchors to issue creation, all later comments unread", () => {
    const issue = { url: "https://x/3", author: "alice", created: "2026-06-20T00:00:00Z",
      my_last_interaction: "", last_push: "", activity: [{ created_at: "2026-06-25T00:00:00Z", type: "comment", author: "carol" }] };
    const unread = getUnreadActivity(issue, "rainsupreme");
    assert.equal(unread.length, 1);
  });

  it("read marker overrides the reply anchor", () => {
    const issue = { url: "https://x/4", author: "alice", created: "2026-06-01T00:00:00Z",
      my_last_interaction: "2026-07-01T09:00:00Z", last_push: "2026-07-01T09:00:00Z", activity: comments };
    const unread = getUnreadActivity(issue, "rainsupreme", { "https://x/4": "2026-07-04T00:00:00Z" });
    assert.equal(unread.length, 0); // nothing after the marker
  });
});
