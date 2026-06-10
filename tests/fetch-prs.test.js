const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { mapPR, mapMention, mapComment, mapReview, mapCommit } = require("../scripts/fetch-prs.js");

describe("mapPR", () => {
  const baseItem = {
    title: "Fix memory leak",
    number: 42,
    repository_url: "https://api.github.com/repos/valkey-io/valkey",
    html_url: "https://github.com/valkey-io/valkey/pull/42",
    user: { login: "dev123", avatar_url: "https://avatars.githubusercontent.com/u/1" },
    created_at: "2024-03-15T10:30:00Z",
    updated_at: "2024-03-16T14:00:00Z",
    closed_at: null,
    comments: 5,
    draft: false,
    pull_request: { merged_at: null },
  };

  it("extracts repo name from repository_url", () => {
    assert.equal(mapPR(baseItem).repo, "valkey");
  });

  it("preserves full ISO timestamps", () => {
    const result = mapPR(baseItem);
    assert.equal(result.created, "2024-03-15T10:30:00Z");
    assert.equal(result.updated, "2024-03-16T14:00:00Z");
    assert.equal(result.closed, "");
  });

  it("maps closed_at when present", () => {
    const closed = { ...baseItem, closed_at: "2024-03-17T09:00:00Z" };
    assert.equal(mapPR(closed).closed, "2024-03-17T09:00:00Z");
  });

  it("detects merged PRs", () => {
    const merged = { ...baseItem, pull_request: { merged_at: "2024-03-17T09:00:00Z" } };
    assert.equal(mapPR(merged).merged, true);
    assert.equal(mapPR(baseItem).merged, false);
  });

  it("detects draft PRs", () => {
    const draft = { ...baseItem, draft: true };
    assert.equal(mapPR(draft).draft, true);
    assert.equal(mapPR(baseItem).draft, false);
  });

  it("handles missing user gracefully", () => {
    const noUser = { ...baseItem, user: null };
    const result = mapPR(noUser);
    assert.equal(result.author, "ghost");
    assert.equal(result.avatar, "");
  });

  it("maps all expected fields", () => {
    const result = mapPR(baseItem);
    assert.equal(result.title, "Fix memory leak");
    assert.equal(result.number, 42);
    assert.equal(result.url, "https://github.com/valkey-io/valkey/pull/42");
    assert.equal(result.author, "dev123");
    assert.equal(result.comments, 5);
  });
});

describe("mapMention", () => {
  const baseItem = {
    title: "Add HEXPIRE support",
    number: 100,
    repository_url: "https://api.github.com/repos/valkey-io/valkey",
    html_url: "https://github.com/valkey-io/valkey/issues/100",
    user: { login: "contributor", avatar_url: "https://avatars.githubusercontent.com/u/2" },
    created_at: "2024-04-01T08:00:00Z",
    updated_at: "2024-04-02T12:00:00Z",
    state: "open",
    pull_request: undefined,
  };

  it("detects issues vs PRs", () => {
    assert.equal(mapMention(baseItem).is_pr, false);
    const pr = { ...baseItem, pull_request: { url: "..." } };
    assert.equal(mapMention(pr).is_pr, true);
  });

  it("preserves full ISO timestamps", () => {
    const result = mapMention(baseItem);
    assert.equal(result.created, "2024-04-01T08:00:00Z");
    assert.equal(result.updated, "2024-04-02T12:00:00Z");
  });

  it("extracts repo name", () => {
    assert.equal(mapMention(baseItem).repo, "valkey");
  });

  it("maps state field", () => {
    assert.equal(mapMention(baseItem).state, "open");
  });

  it("handles missing user", () => {
    const noUser = { ...baseItem, user: null };
    assert.equal(mapMention(noUser).author, "ghost");
  });
});

describe("mapComment", () => {
  const baseComment = {
    user: { login: "reviewer1", avatar_url: "https://avatars.githubusercontent.com/u/3" },
    body: "Looks good, just one nit on line 42.",
    created_at: "2024-05-10T14:30:00Z",
  };

  it("maps comment fields correctly", () => {
    const result = mapComment(baseComment);
    assert.equal(result.author, "reviewer1");
    assert.equal(result.type, "comment");
    assert.equal(result.created_at, "2024-05-10T14:30:00Z");
    assert.ok(result.body.includes("one nit"));
  });

  it("truncates long bodies to 200 chars", () => {
    const long = { ...baseComment, body: "x".repeat(500) };
    assert.equal(mapComment(long).body.length, 200);
  });

  it("handles missing user", () => {
    const noUser = { ...baseComment, user: null };
    assert.equal(mapComment(noUser).author, "ghost");
  });

  it("handles null body", () => {
    const noBody = { ...baseComment, body: null };
    assert.equal(mapComment(noBody).body, "");
  });
});

describe("mapReview", () => {
  const baseReview = {
    user: { login: "approver", avatar_url: "https://avatars.githubusercontent.com/u/4" },
    body: "LGTM!",
    submitted_at: "2024-05-11T09:00:00Z",
    state: "APPROVED",
  };

  it("maps review fields correctly", () => {
    const result = mapReview(baseReview);
    assert.equal(result.author, "approver");
    assert.equal(result.type, "review");
    assert.equal(result.state, "APPROVED");
    assert.equal(result.created_at, "2024-05-11T09:00:00Z");
  });

  it("maps CHANGES_REQUESTED state", () => {
    const changes = { ...baseReview, state: "CHANGES_REQUESTED" };
    assert.equal(mapReview(changes).state, "CHANGES_REQUESTED");
  });

  it("handles missing user", () => {
    const noUser = { ...baseReview, user: null };
    assert.equal(mapReview(noUser).author, "ghost");
  });
});

describe("mapCommit", () => {
  const baseCommit = {
    author: { login: "dev123", avatar_url: "https://avatars.githubusercontent.com/u/1" },
    committer: { login: "dev123", avatar_url: "https://avatars.githubusercontent.com/u/1" },
    commit: {
      message: "Fix memory leak in hash table resize\n\nThis addresses the OOM issue.",
      author: { name: "Dev", date: "2024-05-09T16:00:00Z" },
      committer: { name: "Dev", date: "2024-05-09T16:00:00Z" },
    },
  };

  it("uses first line of commit message as body", () => {
    const result = mapCommit(baseCommit);
    assert.equal(result.body, "Fix memory leak in hash table resize");
    assert.equal(result.type, "commit");
  });

  it("uses committer date as created_at", () => {
    assert.equal(mapCommit(baseCommit).created_at, "2024-05-09T16:00:00Z");
  });

  it("falls back to author login from commit when no top-level author", () => {
    const noAuthor = { ...baseCommit, author: null, committer: null };
    assert.equal(mapCommit(noAuthor).author, "Dev");
  });

  it("handles completely missing author info", () => {
    const bare = { commit: { message: "test", author: null, committer: null } };
    assert.equal(mapCommit(bare).author, "ghost");
  });
});
