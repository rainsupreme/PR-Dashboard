// The data contract between scripts/fetch-prs.js (writes data/prs.json) and
// scripts/dashboard.js (reads it). The renderers reach into records by field
// name with no schema in between, so a renamed or dropped field fails only at
// render time, in a browser. This test pins the field sets the renderers read
// and runs recorded API shapes through the mappers to prove each record carries
// them. Add to a list here when a renderer starts reading a new field.
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { mapPR, mapMention, mapComment, mapReview, mapCommit, mapReviewComment, mapSignals, EMPTY_SIGNALS, mentionAnchor } = require("../scripts/mappers.js");
const { buildMergerSections } = require("../scripts/merger.js");

const ME = "rain";

// What renderPR(), whoseMove() and the card counts read on a PR row.
const PR_ROW_FIELDS = [
  "title", "number", "repo", "url", "author", "avatar", "created", "updated", "closed", "comments", "draft", "merged", "labels",
  "mergeable", "ci_rollup", "head_oid", "approvals_current", "approvals_stale", "changes_requested", "waiting_on", "reviewers", "requested",
  "threads_awaiting_me", "threads_awaiting_them", "threads_bot", "has_human_reviewer", "my_review", "my_review_stale", "my_last_look", "my_review_requested",
  "last_push", "activity", "ci_jobs", "my_last_interaction", "bot_verdict",
];
// What renderMention() / renderIssue() read beyond the common item fields.
const MENTION_ROW_FIELDS = ["title", "number", "repo", "url", "author", "avatar", "created", "updated", "is_pr", "state", "activity", "my_last_interaction", "last_push", "unread_anchor"];
const ISSUE_ROW_FIELDS = ["title", "number", "repo", "url", "author", "avatar", "created", "updated", "is_assigned", "is_authored", "activity", "my_last_interaction", "last_push"];
// What renderActivityItem() and the unread filters read on one activity entry.
const ACTIVITY_ITEM_FIELDS = ["type", "author", "avatar", "body", "created_at"];
// What renderPR(pr, "merger") reads on top of a PR row.
const MERGER_ROW_FIELDS = ["merger_section", "merger_reason", "merger_broken"];

// Recorded shapes, trimmed to the fields the mappers touch.
const searchItem = {
  title: "Fix defrag crash", number: 4968, html_url: "https://github.com/valkey-io/valkey/pull/4968",
  repository_url: "https://api.github.com/repos/valkey-io/valkey",
  user: { login: "taham0", avatar_url: "https://avatars.githubusercontent.com/u/1" },
  created_at: "2026-10-15T10:00:00Z", updated_at: "2026-10-20T10:00:00Z", closed_at: null, comments: 3, draft: false,
  pull_request: { merged_at: null }, labels: [{ name: "bug", color: "d73a4a" }],
};
const graphqlNode = {
  reviewDecision: "APPROVED", mergeable: "MERGEABLE", headRefOid: "abc1234", author: { login: "taham0" },
  reviewRequests: { nodes: [] },
  reviews: { nodes: [{ author: { login: "alice", __typename: "User" }, state: "APPROVED", commit: { oid: "abc1234" }, submittedAt: "2026-10-19T00:00:00Z" }] },
  reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" }, committedDate: "2026-10-18T00:00:00Z" } }] },
};
const restCommit = { sha: "abc1234", author: { login: "taham0", avatar_url: "a" }, commit: { message: "Fix defrag crash\n\nbody", committer: { date: "2026-10-18T00:00:00Z" } } };
const restReview = { user: { login: "alice", avatar_url: "a" }, state: "APPROVED", body: "LGTM", submitted_at: "2026-10-19T00:00:00Z", html_url: "https://x/r" };
const restComment = { user: { login: "bob", avatar_url: "a" }, body: "ping", created_at: "2026-10-19T01:00:00Z", html_url: "https://x/c" };
const restReviewComment = { user: { login: "alice", avatar_url: "a" }, body: "nit", created_at: "2026-10-19T02:00:00Z", html_url: "https://x/rc", path: "src/defrag.c" };

// Mirror of what enrichWithActivity() adds; fetchActivity() itself talks to the
// network and is not exercised here, so its output shape is pinned by name.
function activityEnrichment(activity) {
  const myEvents = activity.filter((a) => a.author === ME && a.type !== "commit");
  return { last_push: "2026-10-18T00:00:00Z", activity, ci_jobs: [], my_last_interaction: myEvents.length ? myEvents[0].created_at : "", bot_verdict: "" };
}

function assertHasFields(record, fields, what) {
  const missing = fields.filter((f) => !Object.prototype.hasOwnProperty.call(record, f));
  assert.deepEqual(missing, [], `${what} is missing fields the renderer reads: ${missing.join(", ")}`);
}

describe("data contract: PR rows", () => {
  it("search item + signals + activity carries every field renderPR reads", () => {
    const activity = [mapCommit(restCommit), mapReview(restReview), mapComment(restComment), mapReviewComment(restReviewComment)];
    const pr = { ...mapPR(searchItem), ...mapSignals(graphqlNode, ME), ...activityEnrichment(activity) };
    assertHasFields(pr, PR_ROW_FIELDS, "PR row");
    assert.equal(pr.repo, "valkey");
    assert.deepEqual(pr.labels, [{ name: "bug", color: "d73a4a" }]);
    assert.equal(pr.approvals_current, 1);
  });

  it("a PR whose signals fetch failed still carries every field (EMPTY_SIGNALS is the fallback)", () => {
    const pr = { ...mapPR(searchItem), ...EMPTY_SIGNALS, ...activityEnrichment([]) };
    assertHasFields(pr, PR_ROW_FIELDS, "PR row without signals");
  });

  it("every activity mapper yields the fields renderActivityItem reads", () => {
    for (const [name, item] of [["commit", mapCommit(restCommit)], ["review", mapReview(restReview)], ["comment", mapComment(restComment)], ["review_comment", mapReviewComment(restReviewComment)]]) {
      assertHasFields(item, ACTIVITY_ITEM_FIELDS, `activity item (${name})`);
      assert.ok(item.created_at, `${name} has a timestamp (unread filtering sorts on it)`);
    }
    assert.equal(mapCommit(restCommit).body, "Fix defrag crash", "commit body is the first line only");
  });
});

describe("data contract: mention and issue rows", () => {
  const issueItem = { ...searchItem, pull_request: undefined, html_url: "https://github.com/valkey-io/valkey/issues/42", number: 42, state: "open" };

  it("mention rows carry the mention fields plus the anchor the unread logic reads", () => {
    const activity = [mapComment({ ...restComment, body: `@${ME} look` })];
    const anchor = mentionAnchor(activity, ME, issueItem.created_at);
    const m = { ...mapMention(issueItem), activity, my_last_interaction: "", last_push: anchor, unread_anchor: anchor };
    assertHasFields(m, MENTION_ROW_FIELDS, "mention row");
    assert.equal(m.is_pr, false);
  });

  it("issue rows carry the assignment flags main() attaches", () => {
    const i = { ...mapMention(issueItem), is_assigned: true, is_authored: false, activity: [], my_last_interaction: "", last_push: "" };
    assertHasFields(i, ISSUE_ROW_FIELDS, "issue row");
  });
});

describe("data contract: merger rows", () => {
  it("a sectioned PR carries the merger fields renderPR(pr, 'merger') reads, on top of the PR row", () => {
    const pr = { ...mapPR(searchItem), ...mapSignals(graphqlNode, ME), ...activityEnrichment([]) };
    const { sections } = buildMergerSections([pr], { committers: new Set(), ciWaiting: new Map([["abc1234", 3]]), mergeLabels: ["to-be-merged"], me: ME });
    assert.equal(sections.ci.length, 1);
    assertHasFields(sections.ci[0], [...PR_ROW_FIELDS, ...MERGER_ROW_FIELDS], "merger row");
    assert.match(sections.ci[0].merger_reason, /CI awaiting approval · 3 runs/);
  });
});
