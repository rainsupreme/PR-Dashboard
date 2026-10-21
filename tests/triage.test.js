const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  ciState, hasMergeLabel, canMerge, isClearToLand, isBroken, whoseMove, isActionable, computeTriageScore, countActionable, normalizeMarker, myLastAction, pinStillHolds, sortPRs,
} = require("../scripts/utils.js");
const { mapSignals, mapPR, dedupeMentions, mentionAnchor, botVerdict, mergeReviewing } = require("../scripts/fetch-prs.js");

const MERGE = ["to-be-merged"];
const ME = "rainsupreme";

// Helpers to build PR fixtures
const pr = (o = {}) => ({
  url: "https://github.com/valkey-io/valkey/pull/1",
  number: 1,
  author: "someone",
  updated: "2024-01-01T00:00:00Z",
  created: "2024-01-01T00:00:00Z",
  ci_jobs: [],
  labels: [],
  waiting_on: [],
  has_human_reviewer: true,
  ...o,
});
const jobs = (...statuses) => statuses.map((s, i) => ({ name: `job${i}`, status: s, url: "" }));
const user = (login) => ({ login, __typename: "User" });
const bot = (login) => ({ login, __typename: "Bot" });
const review = (login, state, oid, at = "2024-01-01T00:00:00Z") => ({ author: user(login), state, submittedAt: at, commit: { oid } });
const thread = (opener, latest, resolved = false, latestExtra = {}) => ({
  isResolved: resolved,
  opener: { nodes: [{ author: opener }] },
  latest: { nodes: [{ author: latest, ...latestExtra }] },
});
const node = (o = {}) => ({
  reviewDecision: "REVIEW_REQUIRED",
  mergeable: "MERGEABLE",
  headRefOid: "head",
  author: user("author"),
  reviewRequests: { nodes: [] },
  reviews: { nodes: [] },
  reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  ...o,
});
const requests = (...logins) => ({ nodes: logins.map((l) => ({ requestedReviewer: l.startsWith("team:") ? { __typename: "Team", slug: l.slice(5) } : { __typename: "User", login: l } })) });

describe("mapSignals: verdicts against the head", () => {
  it("an approval on the current head counts; GitHub's sticky reviewDecision is display-only", () => {
    const s = mapSignals(node({ reviewDecision: "APPROVED", reviews: { nodes: [review("alice", "APPROVED", "head")] } }), ME);
    assert.equal(s.approvals_current, 1);
    assert.equal(s.approvals_stale, 0);
    assert.deepEqual(s.waiting_on, []);
    assert.equal(s.review_decision, "APPROVED");
  });
  it("an approval on an older head is stale and puts the reviewer back in waiting_on (PR 4107 / 4490)", () => {
    const s = mapSignals(node({ reviewDecision: "APPROVED", reviews: { nodes: [review("zhulipeng", "APPROVED", "old")] } }), ME);
    assert.equal(s.approvals_current, 0);
    assert.equal(s.approvals_stale, 1);
    assert.deepEqual(s.waiting_on, ["zhulipeng"]);
  });
  it("my CHANGES_REQUESTED followed by an author push is my re-review (PR 2242)", () => {
    const s = mapSignals(node({
      reviewDecision: "CHANGES_REQUESTED",
      reviews: { nodes: [review("Nikhil-Manglore", "APPROVED", "8b09884"), review(ME, "CHANGES_REQUESTED", "8b09884", "2026-08-05T00:00:00Z")] },
      headRefOid: "f444b16",
    }), ME);
    assert.equal(s.my_review, "CHANGES_REQUESTED");
    assert.equal(s.my_review_stale, true);
    assert.equal(s.changes_requested, 0); // not standing against the current head
    assert.deepEqual(s.waiting_on.sort(), ["Nikhil-Manglore", ME].sort());
  });
  it("my COMMENTED-only look on an older head means the author pushed since (PR 3603)", () => {
    const s = mapSignals(node({ reviews: { nodes: [review(ME, "COMMENTED", "old")] } }), ME);
    assert.equal(s.my_review, "");
    assert.equal(s.my_last_look, "stale");
    assert.equal(mapSignals(node({ reviews: { nodes: [review(ME, "COMMENTED", "head")] } }), ME).my_last_look, "current");
    assert.equal(mapSignals(node(), ME).my_last_look, "");
  });
  it("only the latest verdict per reviewer stands", () => {
    const s = mapSignals(node({ reviews: { nodes: [
      review("alice", "CHANGES_REQUESTED", "head", "2024-01-01T00:00:00Z"),
      review("alice", "APPROVED", "head", "2024-01-02T00:00:00Z"),
    ] } }), ME);
    assert.equal(s.approvals_current, 1);
    assert.equal(s.changes_requested, 0);
  });
  it("COMMENTED reviews make someone a reviewer but carry no verdict", () => {
    const s = mapSignals(node({ reviews: { nodes: [review("alice", "COMMENTED", "head")] } }), ME);
    assert.equal(s.has_human_reviewer, true);
    assert.deepEqual(s.reviewers, [{ login: "alice", state: "COMMENTED", stale: false }]);
    assert.deepEqual(s.waiting_on, []);
  });
  it("bot reviews and the author's own reviews are ignored", () => {
    const s = mapSignals(node({ reviews: { nodes: [
      { author: bot("coderabbitai[bot]"), state: "COMMENTED", submittedAt: "", commit: { oid: "head" } },
      { author: user("valkey-review-bot"), state: "COMMENTED", submittedAt: "", commit: { oid: "head" } },
      review("author", "COMMENTED", "head"),
    ] } }), ME);
    // valkey-review-bot has a User typename, so it is a human as far as the API says.
    assert.deepEqual(s.reviewers.map((r) => r.login), ["valkey-review-bot"]);
  });
});

describe("mapSignals: review requests", () => {
  it("a requested user with no verdict owes the first look (PR 4179 / 4223)", () => {
    const s = mapSignals(node({ reviewRequests: requests("roshkhatri") }), ME);
    assert.deepEqual(s.waiting_on, ["roshkhatri"]);
    assert.equal(s.has_human_reviewer, true);
    assert.equal(s.my_review_requested, false);
  });
  it("a request for me is flagged", () => {
    const s = mapSignals(node({ reviewRequests: requests(ME) }), ME);
    assert.equal(s.my_review_requested, true);
  });
  it("teams are carried as team:<slug>", () => {
    const s = mapSignals(node({ reviewRequests: requests("team:core") }), ME);
    assert.deepEqual(s.requested, ["team:core"]);
    assert.deepEqual(s.waiting_on, ["team:core"]);
  });
  it("no reviews and no requests means nobody has engaged (PR 3739 / 4294 / 4715)", () => {
    assert.equal(mapSignals(node(), ME).has_human_reviewer, false);
  });
});

describe("mapSignals: thread turns", () => {
  it("on my own PR, a thread where someone else spoke last awaits me; one where I spoke last awaits them (PR 4642)", () => {
    const s = mapSignals(node({ author: user(ME), reviewThreads: { nodes: [
      thread(user("alice"), user("alice")),
      thread(user("alice"), user(ME)),
      thread(user("alice"), user("alice"), true),
    ] } }), ME);
    assert.equal(s.unresolved_threads, 2);
    assert.equal(s.threads_awaiting_me, 1);
    assert.equal(s.threads_awaiting_them, 1);
  });
  it("on someone else's PR, only my own conversations count (PR 4895)", () => {
    const s = mapSignals(node({ reviewThreads: { nodes: [
      thread(user(ME), user("author")),      // author replied to me -> awaiting me
      thread(user(ME), user(ME)),            // I spoke last -> awaiting them
      thread(user("bob"), user("author")),   // bob's conversation -> not mine
    ] } }), ME);
    assert.equal(s.unresolved_threads, 3);
    assert.equal(s.threads_awaiting_me, 1);
    assert.equal(s.threads_awaiting_them, 1);
  });
  it("on my own PR, a reviewer whose thread I answered last owes the next reply (PR 4895)", () => {
    const s = mapSignals(node({ author: user(ME), reviewThreads: { nodes: [thread(user("Baraa-Hasheesh"), user(ME))] } }), ME);
    assert.deepEqual(s.waiting_on, ["Baraa-Hasheesh"]);
    assert.equal(s.threads_awaiting_them, 1);
  });
  it("a thread whose last word is a bot's is counted apart (PR 4118)", () => {
    const s = mapSignals(node({ author: user(ME), reviewThreads: { nodes: [thread(bot("valkey-review-bot[bot]"), bot("valkey-review-bot[bot]"))] } }), ME);
    assert.equal(s.threads_bot, 1);
    assert.equal(s.threads_awaiting_me, 0);
  });
  it("a bot thread the author acknowledged -- pushed after it, or reacted to it -- is not counted", () => {
    const pushed = { nodes: [{ commit: { committedDate: "2024-02-01T00:00:00Z", statusCheckRollup: { state: "SUCCESS" } } }] };
    const before = thread(bot("coderabbitai[bot]"), bot("coderabbitai[bot]"), false, { createdAt: "2024-01-15T00:00:00Z" });
    const after = thread(bot("coderabbitai[bot]"), bot("coderabbitai[bot]"), false, { createdAt: "2024-02-15T00:00:00Z" });
    const reacted = thread(bot("coderabbitai[bot]"), bot("coderabbitai[bot]"), false, { createdAt: "2024-02-15T00:00:00Z", reactions: { totalCount: 1 } });
    const s = mapSignals(node({ commits: pushed, reviewThreads: { nodes: [before, after, reacted] } }), ME);
    assert.equal(s.unresolved_threads, 3);
    assert.equal(s.threads_bot, 1);
  });
  it("with no head date, every unanswered bot thread counts (fail toward showing it)", () => {
    const t = thread(bot("coderabbitai[bot]"), bot("coderabbitai[bot]"), false, { createdAt: "2024-01-15T00:00:00Z" });
    assert.equal(mapSignals(node({ commits: { nodes: [] }, reviewThreads: { nodes: [t] } }), ME).threads_bot, 1);
  });
});

describe("mapSignals: CI rollup and defaults", () => {
  it("carries the rollup state", () => {
    assert.equal(mapSignals(node({ commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } }), ME).ci_rollup, "FAILURE");
  });
  it("defaults gracefully on null / empty", () => {
    const empty = mapSignals(null, ME);
    assert.equal(empty.review_decision, "");
    assert.equal(empty.has_human_reviewer, false);
    assert.deepEqual(empty.waiting_on, []);
    const s = mapSignals({}, ME);
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
    const r = mapPR({ ...base, labels: [{ name: "to-be-merged", color: "0e8a16" }] });
    assert.deepEqual(r.labels, [{ name: "to-be-merged", color: "0e8a16" }]);
  });
  it("handles no labels", () => {
    assert.deepEqual(mapPR(base).labels, []);
  });
  it("normalizes string labels to {name,color:''}", () => {
    assert.deepEqual(mapPR({ ...base, labels: ["to-be-merged"] }).labels, [{ name: "to-be-merged", color: "" }]);
  });
});

describe("botVerdict: the review bot's Review state comment", () => {
  const MARK = "<!-- valkey-reviewer:state -->";
  const c = (body, created = "2024-02-01T00:00:00Z", updated) => ({ body, created_at: created, updated_at: updated || created });
  const HEAD = "d036c4585aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  it("reads the bold verdict; only 'not ready' is a demotion", () => {
    assert.equal(botVerdict([c(`${MARK}\n### Review state\n\n**Not ready for human review yet.** Draft PR.`)], HEAD, "").bot_verdict, "not-ready");
    assert.equal(botVerdict([c(`${MARK}\n### Review state\n\n**Ready for human review.** No findings.`)], HEAD, "").bot_verdict, "ready");
  });
  it("ignores every other comment and fails open without the marker or a verdict", () => {
    assert.equal(botVerdict([c("Looks good"), c(`${MARK} nothing bold here`)], HEAD, "").bot_verdict, "");
    assert.equal(botVerdict([], HEAD, "").bot_verdict, "");
    assert.equal(botVerdict(undefined, HEAD, "").bot_verdict, "");
  });
  it("a verdict about an older head is no signal; one naming the current head counts", () => {
    const old = c(`${MARK}\n**Not ready for human review yet.** I checked 1234567 and found gaps.`);
    assert.equal(botVerdict([old], HEAD, "").bot_verdict, "");
    const cur = c(`${MARK}\n**Not ready for human review yet.** I re-checked d036c45 and the test is still missing.`);
    assert.equal(botVerdict([cur], HEAD, "").bot_verdict, "not-ready");
  });
  it("a verdict last touched before the latest push is stale; the bot's in-place edit refreshes it", () => {
    const stale = c(`${MARK}\n**Not ready for human review yet.**`, "2024-01-01T00:00:00Z");
    assert.equal(botVerdict([stale], HEAD, "2024-02-01T00:00:00Z").bot_verdict, "");
    const edited = c(`${MARK}\n**Not ready for human review yet.**`, "2024-01-01T00:00:00Z", "2024-02-02T00:00:00Z");
    assert.equal(botVerdict([edited], HEAD, "2024-02-01T00:00:00Z").bot_verdict, "not-ready");
  });
  it("the last state comment wins when there are several", () => {
    const list = [c(`${MARK}\n**Not ready for human review yet.**`), c(`${MARK}\n**Ready for human review.**`)];
    assert.equal(botVerdict(list, HEAD, "").bot_verdict, "ready");
  });
});

describe("mergeReviewing: one list from the requested and reviewed searches", () => {
  const p = (n, extra = {}) => ({ url: `https://github.com/o/r/pull/${n}`, number: n, ...extra });
  it("unions by URL, requested first, and keeps the requested copy of a PR in both", () => {
    const out = mergeReviewing([p(1, { from: "req" }), p(2)], [p(2, { from: "rev" }), p(1, { from: "rev" }), p(3)]);
    assert.deepEqual(out.map((x) => x.number), [1, 2, 3]);
    assert.equal(out[0].from, "req");
  });
  it("tolerates an empty side", () => {
    assert.deepEqual(mergeReviewing([], [p(5)]).map((x) => x.number), [5]);
    assert.deepEqual(mergeReviewing([p(5)], []).map((x) => x.number), [5]);
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
  it("empty when no jobs and no rollup", () => {
    assert.equal(ciState(pr({ ci_jobs: [] })), "");
  });
  it("a cancelled lane is 'cancelled', not green and not a failure, even though the rollup says FAILURE (PR 4642)", () => {
    assert.equal(ciState(pr({ ci_jobs: jobs("success", "cancelled"), ci_rollup: "FAILURE" })), "cancelled");
  });
  it("a red rollup with all check-runs green is a failed commit status (e.g. DCO)", () => {
    assert.equal(ciState(pr({ ci_jobs: jobs("success"), ci_rollup: "FAILURE" })), "failure");
  });
  it("a run awaiting maintainer approval is its own state, under cancelled and above pending", () => {
    assert.equal(ciState(pr({ ci_jobs: jobs("action_required", "pending") })), "action_required");
    assert.equal(ciState(pr({ ci_jobs: jobs("action_required", "cancelled") })), "cancelled");
    assert.equal(ciState(pr({ ci_jobs: jobs("action_required", "failure") })), "failure");
  });
  it("falls back to the rollup when there are no check-runs", () => {
    assert.equal(ciState(pr({ ci_rollup: "SUCCESS" })), "success");
    assert.equal(ciState(pr({ ci_rollup: "PENDING" })), "pending");
  });
});

describe("hasMergeLabel / canMerge", () => {
  it("merge label matches a configured name", () => {
    assert.equal(hasMergeLabel(pr({ labels: [{ name: "to-be-merged" }] }), MERGE), true);
    assert.equal(hasMergeLabel(pr({ labels: [{ name: "bug" }] }), MERGE), false);
    assert.equal(hasMergeLabel(pr({ labels: [{ name: "to-be-merged" }] }), []), false);
  });
  it("merge access matches by org or by org/repo, case-insensitively", () => {
    assert.equal(canMerge(pr(), ["valkey-io"]), true);
    assert.equal(canMerge(pr(), ["Valkey-IO/valkey"]), true);
    assert.equal(canMerge(pr(), ["valkey-io/valkey-glide"]), false);
    assert.equal(canMerge(pr(), []), false);
    assert.equal(canMerge(pr(), undefined), false);
  });
});

const READY = { approvals_current: 1, mergeable: "MERGEABLE", ci_jobs: jobs("success") };

describe("isClearToLand / isBroken", () => {
  it("clear only when approved on the current head + green + mergeable + no standing changes-requested", () => {
    assert.equal(isClearToLand(pr(READY)), true);
    assert.equal(isClearToLand(pr({ ...READY, ci_jobs: jobs("failure") })), false);
    assert.equal(isClearToLand(pr({ ...READY, approvals_current: 0, approvals_stale: 1 })), false);
    assert.equal(isClearToLand(pr({ ...READY, mergeable: "CONFLICTING" })), false);
    assert.equal(isClearToLand(pr({ ...READY, changes_requested: 1 })), false);
  });
  it("a stale APPROVED reviewDecision alone does not make a PR clear", () => {
    assert.equal(isClearToLand(pr({ review_decision: "APPROVED", mergeable: "MERGEABLE", ci_jobs: jobs("success") })), false);
  });
  it("broken = CI red, conflict, or changes requested on the current head", () => {
    assert.equal(isBroken(pr({ ci_jobs: jobs("failure") })), true);
    assert.equal(isBroken(pr({ mergeable: "CONFLICTING" })), true);
    assert.equal(isBroken(pr({ changes_requested: 1 })), true);
    assert.equal(isBroken(pr({ review_decision: "CHANGES_REQUESTED" })), false); // sticky aggregate, ignored
  });
});

describe("whoseMove — authored tab", () => {
  const o = { mergeLabels: MERGE, type: "open" };
  it("ladder: queued-broken > CI > changes > conflict > threads > find-reviewer > ready > cancelled", () => {
    const s = (x) => computeTriageScore(pr(x), o);
    const ladder = [
      s({ labels: [{ name: "to-be-merged" }], ci_jobs: jobs("failure") }),
      s({ ci_jobs: jobs("failure") }),
      s({ changes_requested: 1 }),
      s({ mergeable: "CONFLICTING" }),
      s({ threads_awaiting_me: 1 }),
      s({ has_human_reviewer: false }),
      s(READY),
      s({ ci_jobs: jobs("cancelled") }),
    ];
    for (let i = 1; i < ladder.length; i++) assert.ok(ladder[i - 1] > ladder[i], `tier ${i - 1} (${ladder[i - 1]}) should outrank tier ${i} (${ladder[i]})`);
  });
  it("a PR nobody has picked up is MY move to find a reviewer, and stays bright", () => {
    const m = whoseMove(pr({ has_human_reviewer: false }), o);
    assert.equal(m.owner, "nobody");
    assert.equal(m.actionable, true);
  });
  it("a thread where I spoke last is not my move", () => {
    const m = whoseMove(pr({ threads_awaiting_them: 2 }), o);
    assert.equal(m.owner, "idle");
    assert.equal(m.actionable, false);
  });
  it("a reviewer who owes a look is their move, named, and not actionable", () => {
    const m = whoseMove(pr({ waiting_on: ["roshkhatri"] }), o);
    assert.equal(m.owner, "them");
    assert.deepEqual(m.who, ["roshkhatri"]);
    assert.equal(m.actionable, false);
  });
  it("ready to land: merge it if I can, otherwise nudge a committer", () => {
    assert.equal(whoseMove(pr(READY), { ...o, canMerge: true }).owner, "me");
    assert.equal(whoseMove(pr(READY), { ...o, canMerge: true }).action, "merge");
    assert.equal(whoseMove(pr(READY), { ...o, canMerge: false }).owner, "committer");
    assert.equal(whoseMove(pr(READY), { ...o, mergeAccess: ["valkey-io"] }).owner, "me");
  });
  it("a stale approval is not ready: the approver owes a re-look (PR 4107 / 4490)", () => {
    const m = whoseMove(pr({ approvals_stale: 1, waiting_on: ["zhulipeng"], mergeable: "MERGEABLE", ci_jobs: jobs("success") }), o);
    assert.equal(m.owner, "them");
  });
  it("drafts sink to the bottom and are not actionable, even with conflicts (PR 3990)", () => {
    const m = whoseMove(pr({ draft: true, mergeable: "CONFLICTING" }), o);
    assert.equal(m.action, "draft");
    assert.equal(m.score, 5);
    assert.equal(m.actionable, false);
  });
  it("queued + healthy just waits", () => {
    const m = whoseMove(pr({ ...READY, labels: [{ name: "to-be-merged" }] }), o);
    assert.equal(m.owner, "queued");
    assert.equal(m.score, 5);
    assert.equal(m.actionable, false);
  });
  it("a cancelled lane is my move to rerun", () => {
    assert.equal(whoseMove(pr({ ci_jobs: jobs("cancelled") }), o).action, "rerun cancelled CI");
  });
  it("staleness is not an input to ownership on the authored tab", () => {
    assert.equal(computeTriageScore(pr({ created: "2000-01-01T00:00:00Z" }), o), 0);
  });
});

describe("whoseMove — reviewing tab (one list: requests and PRs I reviewed)", () => {
  const o = { mergeLabels: MERGE, type: "reviewing" };
  // A PR I have never looked at and that was requested of me.
  const FIRST = { my_review_requested: true, ci_jobs: jobs("success"), created: new Date().toISOString() };

  describe("what the author must do first", () => {
    it("green/clean first request is my move; CI red or conflicts are the author's and can wait", () => {
      assert.equal(whoseMove(pr(FIRST), o).owner, "me");
      assert.equal(whoseMove(pr(FIRST), o).action, "review");
      assert.equal(whoseMove(pr({ ...FIRST, ci_jobs: jobs("failure") }), o).owner, "them");
      assert.equal(whoseMove(pr({ ...FIRST, mergeable: "CONFLICTING" }), o).actionable, false);
    });
    it("a draft is not ready for me even when requested (PR 3990)", () => {
      const m = whoseMove(pr({ ...FIRST, draft: true }), o);
      assert.equal(m.owner, "them");
      assert.equal(m.actionable, false);
    });
    it("another reviewer's standing changes-requested means the author's round comes first", () => {
      const m = whoseMove(pr({ ...FIRST, changes_requested: 1 }), o);
      assert.equal(m.owner, "them");
      assert.equal(m.action, "addressing another review");
    });
    it("but my own standing changes-requested does not hide my re-review (PR 2242 / 3724)", () => {
      const m = whoseMove(pr({ my_review: "CHANGES_REQUESTED", my_review_stale: true, changes_requested: 1 }), o);
      assert.equal(m.owner, "me");
      assert.equal(m.action, "re-review: author pushed");
    });
    it("unacknowledged bot threads say the author has not looked yet: their move, named, not mine", () => {
      const m = whoseMove(pr({ ...FIRST, threads_bot: 3 }), o);
      assert.equal(m.owner, "them");
      assert.equal(m.action, "address 3 bot threads");
      assert.deepEqual(m.who, ["someone"]);
      assert.equal(m.actionable, false);
    });
    it("the review bot's 'not ready' verdict demotes; its 'ready' verdict changes nothing", () => {
      assert.equal(whoseMove(pr({ ...FIRST, bot_verdict: "not-ready" }), o).owner, "them");
      assert.equal(whoseMove(pr({ ...FIRST, bot_verdict: "ready" }), o).owner, "me");
      assert.equal(whoseMove(pr({ ...FIRST, bot_verdict: "ready" }), o).score, whoseMove(pr(FIRST), o).score);
    });
    it("blockers rank: conflict > CI red > other reviewer's changes > bot threads > bot verdict", () => {
      const sc = (x) => whoseMove(pr({ ...FIRST, ...x }), o).score;
      assert.ok(sc({ mergeable: "CONFLICTING" }) > sc({ ci_jobs: jobs("failure") }));
      assert.ok(sc({ ci_jobs: jobs("failure") }) > sc({ changes_requested: 1 }));
      assert.ok(sc({ changes_requested: 1 }) > sc({ threads_bot: 1 }));
      assert.ok(sc({ threads_bot: 1 }) > sc({ bot_verdict: "not-ready" }));
    });
    it("a first-timer's CI awaiting approval is my move if I can approve runs, else a committer's", () => {
      const held = { ...FIRST, ci_jobs: jobs("action_required") };
      assert.equal(whoseMove(pr(held), { ...o, canMerge: true }).action, "approve CI run");
      assert.equal(whoseMove(pr(held), { ...o, canMerge: true }).actionable, true);
      assert.equal(whoseMove(pr(held), { ...o, canMerge: false }).owner, "committer");
      assert.equal(whoseMove(pr(held), { ...o, canMerge: false }).actionable, false);
    });
    it("a reply in my own thread outranks the author's blockers (PR 4871)", () => {
      const m = whoseMove(pr({ threads_awaiting_me: 1, ci_jobs: jobs("failure") }), o);
      assert.equal(m.owner, "me");
      assert.equal(m.score, 70);
    });
  });

  describe("what I owe", () => {
    it("a first request is the plain review; a re-request after my look is the author saying ready again", () => {
      assert.equal(whoseMove(pr(FIRST), o).score, 60);
      assert.equal(whoseMove(pr({ ...FIRST, my_last_look: "current" }), o).action, "re-review requested");
      assert.equal(whoseMove(pr({ ...FIRST, my_review: "CHANGES_REQUESTED" }), o).score, 85);
    });
    it("a long wait on a first request bumps above a fresh one; the boundary is strictly > 7 days", () => {
      const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
      assert.equal(computeTriageScore(pr({ ...FIRST, created: daysAgo(7) }), o), 60);
      assert.equal(computeTriageScore(pr({ ...FIRST, created: daysAgo(8) }), o), 85);
    });
    it("pending CI scores the same as green on a first request", () => {
      assert.equal(computeTriageScore(pr({ ...FIRST, ci_jobs: jobs("pending") }), o), computeTriageScore(pr(FIRST), o));
    });
    it("my changes-requested with no push since is the author's move", () => {
      const m = whoseMove(pr({ my_review: "CHANGES_REQUESTED", my_review_stale: false, changes_requested: 1 }), o);
      assert.equal(m.owner, "them");
      assert.equal(m.actionable, false);
    });
    it("I spoke last in my thread: not my move (PR 4856)", () => {
      assert.equal(whoseMove(pr({ my_last_look: "current", threads_awaiting_them: 1 }), o).actionable, false);
    });
    it("a red or conflicting head is the author's move even when I owe a re-review (PR 2238 / 2241)", () => {
      const m = whoseMove(pr({ my_review: "CHANGES_REQUESTED", my_review_stale: true, ci_jobs: jobs("failure") }), o);
      assert.equal(m.owner, "them");
      assert.equal(m.actionable, false);
    });
    it("the author pushed after my comment-only look: re-look (PR 3603)", () => {
      const m = whoseMove(pr({ my_last_look: "stale" }), o);
      assert.equal(m.owner, "me");
      assert.ok(m.score < 65);
    });
    it("I approved an older head: re-check, below a fresh re-review", () => {
      const m = whoseMove(pr({ my_review: "APPROVED", my_review_stale: true, approvals_stale: 1 }), o);
      assert.equal(m.owner, "me");
      assert.ok(m.score < 85 && m.score > 15);
    });
    it("ready to land: merge (80) if I can, nudge a committer (58, just under a first look) if not", () => {
      const mine = { ...READY, my_review: "APPROVED", my_review_stale: false };
      assert.equal(whoseMove(pr(mine), { ...o, canMerge: true }).score, 80);
      assert.equal(whoseMove(pr(mine), { ...o, canMerge: true }).action, "merge");
      assert.equal(whoseMove(pr(mine), { ...o, canMerge: false }).score, 58);
      assert.equal(whoseMove(pr(mine), { ...o, canMerge: false }).owner, "committer");
    });
    it("someone else approved a PR I never looked at: still my first look, not a merge", () => {
      assert.equal(whoseMove(pr({ ...READY, my_review_requested: true }), { ...o, canMerge: true }).action, "review");
    });
    it("broken is the author's move, below everything of mine", () => {
      assert.equal(whoseMove(pr({ my_last_look: "current", ci_jobs: jobs("failure") }), o).score, 20);
      assert.equal(whoseMove(pr({ my_last_look: "current", mergeable: "CONFLICTING" }), o).actionable, false);
    });
    it("queued + healthy sinks; queued + broken is still the author's move", () => {
      assert.equal(whoseMove(pr({ ...READY, labels: [{ name: "to-be-merged" }] }), o).score, 5);
      assert.equal(whoseMove(pr({ labels: [{ name: "to-be-merged" }], ci_jobs: jobs("failure"), my_last_look: "current" }), o).owner, "them");
    });
    it("approved + green + mergeable UNKNOWN is not ready", () => {
      assert.equal(whoseMove(pr({ approvals_current: 1, mergeable: "UNKNOWN", ci_jobs: jobs("success"), my_review: "APPROVED" }), o).owner, "idle");
    });
  });
});

describe("isActionable is whoseMove().actionable", () => {
  it("agrees across tabs", () => {
    for (const type of ["open", "reviewing"]) {
      const o = { mergeLabels: MERGE, type };
      for (const x of [{}, READY, { ci_jobs: jobs("failure") }, { threads_awaiting_me: 1 }, { has_human_reviewer: false }]) {
        assert.equal(isActionable(pr(x), o), whoseMove(pr(x), o).actionable, `${type} ${JSON.stringify(x)}`);
      }
    }
  });
});

describe("countActionable: the stat card's big number", () => {
  it("counts only PRs that are the user's move, per tab", () => {
    const o = { mergeLabels: MERGE, type: "open" };
    const prs = [
      pr({ ci_jobs: jobs("failure") }),            // fix CI: mine
      pr({ has_human_reviewer: false }),           // find a reviewer: mine
      pr({ waiting_on: ["alice"] }),               // their move
      pr({ draft: true }),                         // draft: not actionable
      pr(READY),                                   // nudge a committer: mine
    ];
    assert.equal(countActionable(prs, o), 3);
    assert.equal(countActionable(prs, o), prs.filter(p => isActionable(p, o)).length);
  });
  it("is 0 for an empty or missing list, so a card can go dark", () => {
    assert.equal(countActionable([], { type: "reviewing" }), 0);
    assert.equal(countActionable(undefined, { type: "reviewing" }), 0);
  });
  it("an incoming review request counts unless the author is blocked", () => {
    const o = { type: "reviewing" };
    const r = { my_review_requested: true };
    assert.equal(countActionable([pr(r), pr({ ...r, ci_jobs: jobs("failure") }), pr({ ...r, mergeable: "CONFLICTING" }), pr({ ...r, threads_bot: 2 })], o), 1);
  });
});

describe("dedupeMentions", () => {
  it("drops mentions already shown on another tab, keeps the rest in order", () => {
    const m = [{ url: "u/1" }, { url: "u/2" }, { url: "u/3" }];
    assert.deepEqual(dedupeMentions(m, [{ url: "u/2" }], [], [{ url: "u/9" }]), [{ url: "u/1" }, { url: "u/3" }]);
    assert.deepEqual(dedupeMentions(m), m);
  });
});

describe("mentionAnchor: where unread starts for a mention", () => {
  const c = (author, body, created_at) => ({ author, body, created_at });
  it("starts one second before the comment that mentioned you, so the mention is new", () => {
    const a = [c("bob", "hi", "2026-10-01T10:00:00Z"), c("bob", "ping @rain", "2026-10-02T10:00:00Z"), c("eve", "later", "2026-10-03T10:00:00Z")];
    assert.equal(mentionAnchor(a, "rain", "2026-09-01T00:00:00Z"), "2026-10-02T09:59:59.000Z");
  });
  it("moves to your reply once you answered after the mention", () => {
    const a = [c("bob", "ping @rain", "2026-10-02T10:00:00Z"), c("rain", "done", "2026-10-02T11:00:00Z"), c("bob", "thanks", "2026-10-02T12:00:00Z")];
    assert.equal(mentionAnchor(a, "rain", ""), "2026-10-02T11:00:00Z");
  });
  it("a reply from before the mention does not count as answering it", () => {
    const a = [c("rain", "early", "2026-10-01T10:00:00Z"), c("bob", "ping @Rain", "2026-10-02T10:00:00Z")];
    assert.equal(mentionAnchor(a, "rain", ""), "2026-10-02T09:59:59.000Z");
  });
  it("uses the latest mention when mentioned more than once", () => {
    const a = [c("bob", "@rain one", "2026-10-02T10:00:00Z"), c("rain", "ok", "2026-10-02T11:00:00Z"), c("eve", "@rain again", "2026-10-05T10:00:00Z")];
    assert.equal(mentionAnchor(a, "rain", ""), "2026-10-05T09:59:59.000Z");
  });
  it("falls back to creation when the mention is in the body, not a comment", () => {
    assert.equal(mentionAnchor([c("bob", "no handle", "2026-10-02T10:00:00Z")], "rain", "2026-09-01T00:00:00Z"), "2026-09-01T00:00:00Z");
    assert.equal(mentionAnchor([], "rain", ""), "");
  });
  it("matches the whole handle only: @rain-bot is not @rain", () => {
    const a = [c("bob", "thanks @rain-bot", "2026-10-02T10:00:00Z")];
    assert.equal(mentionAnchor(a, "rain", "2026-09-01T00:00:00Z"), "2026-09-01T00:00:00Z");
  });
  it("does not treat your own comment containing your handle as a mention", () => {
    const a = [c("rain", "cc @rain-bot and @rain", "2026-10-02T10:00:00Z")];
    assert.equal(mentionAnchor(a, "rain", "2026-09-01T00:00:00Z"), "2026-10-02T10:00:00Z");
  });
});

describe("local marks: normalizeMarker", () => {
  it("accepts the old bare-timestamp shape and the new object shape", () => {
    assert.deepEqual(normalizeMarker("2026-10-01T00:00:00Z"), { read_at: "2026-10-01T00:00:00Z" });
    assert.deepEqual(normalizeMarker({ read_at: "a", pinned_at: "b" }), { read_at: "a", pinned_at: "b" });
    assert.deepEqual(normalizeMarker({ pinned_at: "b", junk: 1 }), { pinned_at: "b" });
    assert.deepEqual(normalizeMarker(null), {});
  });
});

describe("local marks: pins clear on your own action only", () => {
  const act = (author, created_at, type = "comment") => ({ author, created_at, type });
  it("myLastAction is your latest comment/review/commit, or your push on your own PR", () => {
    const pr = { author: "bob", activity: [act("rain", "2026-10-02T00:00:00Z"), act("bob", "2026-10-05T00:00:00Z"), act("rain", "2026-10-03T00:00:00Z", "review")] };
    assert.equal(myLastAction(pr, "rain"), "2026-10-03T00:00:00Z");
    assert.equal(myLastAction({ author: "rain", last_push: "2026-10-09T00:00:00Z", activity: [] }, "rain"), "2026-10-09T00:00:00Z");
    assert.equal(myLastAction({ author: "bob", last_push: "2026-10-09T00:00:00Z", activity: [] }, "rain"), "");
  });
  it("holds while only other people act", () => {
    const pr = { author: "bob", activity: [act("bob", "2026-10-06T00:00:00Z"), act("eve", "2026-10-07T00:00:00Z")] };
    assert.equal(pinStillHolds({ pinned_at: "2026-10-05T00:00:00Z" }, pr, "rain"), true);
  });
  it("clears once you act after pinning, not before", () => {
    const before = { author: "bob", activity: [act("rain", "2026-10-04T00:00:00Z")] };
    const after = { author: "bob", activity: [act("rain", "2026-10-06T00:00:00Z")] };
    assert.equal(pinStillHolds({ pinned_at: "2026-10-05T00:00:00Z" }, before, "rain"), true);
    assert.equal(pinStillHolds({ pinned_at: "2026-10-05T00:00:00Z" }, after, "rain"), false);
  });
  it("is false for an unpinned marker", () => {
    assert.equal(pinStillHolds({ read_at: "2026-10-05T00:00:00Z" }, { activity: [] }, "rain"), false);
    assert.equal(pinStillHolds(undefined, { activity: [] }, "rain"), false);
  });
});

describe("countActionable with pins", () => {
  it("adds pinned rows and counts a pinned actionable row once", () => {
    const o = { mergeLabels: MERGE, type: "open" };
    const prs = [pr({ ci_jobs: jobs("failure"), url: "u/1" }), pr({ waiting_on: ["alice"], url: "u/2" }), pr({ waiting_on: ["alice"], url: "u/3" })];
    const pinned = new Set(["u/1", "u/2"]);
    assert.equal(countActionable(prs, o), 1);
    assert.equal(countActionable(prs, o, p => pinned.has(p.url)), 2);
  });
});

describe("sortPRs triage mode", () => {
  it("orders by urgency then recency, and is non-destructive", () => {
    const list = [
      pr({ number: 1, updated: "2024-01-05T00:00:00Z" }),       // idle 0
      pr({ number: 2, ci_jobs: jobs("failure") }),               // 90
      pr({ number: 3, mergeable: "CONFLICTING" }),               // 70
      pr({ number: 4, has_human_reviewer: false }),              // 55
      pr({ number: 5, waiting_on: ["x"] }),                      // 10
    ];
    const copy = JSON.stringify(list);
    const sorted = sortPRs(list, "triage", { type: "open", mergeLabels: MERGE });
    assert.deepEqual(sorted.map(p => p.number), [2, 3, 4, 5, 1]);
    assert.equal(JSON.stringify(list), copy);
  });
  it("reviewing: my re-review > first look > nudge > author's move > queued", () => {
    const list = [
      pr({ number: 1, ...READY, my_review: "APPROVED", labels: [{ name: "to-be-merged" }] }),
      pr({ number: 2, my_review: "CHANGES_REQUESTED", changes_requested: 1, ci_jobs: jobs("success") }),
      pr({ number: 3, ...READY, my_review: "APPROVED" }),
      pr({ number: 4, my_review: "CHANGES_REQUESTED", my_review_stale: true }),
      pr({ number: 5, my_review_requested: true, ci_jobs: jobs("success"), created: new Date().toISOString() }),
    ];
    assert.deepEqual(sortPRs(list, "triage", { type: "reviewing", mergeLabels: MERGE }).map(p => p.number), [4, 5, 3, 2, 1]);
  });
  it("still supports chronological modes", () => {
    const list = [pr({ number: 1, updated: "2024-01-01T00:00:00Z" }), pr({ number: 2, updated: "2024-02-01T00:00:00Z" })];
    assert.deepEqual(sortPRs(list, "updated").map(p => p.number), [2, 1]);
  });
});
