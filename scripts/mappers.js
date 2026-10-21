// Pure mappers: GitHub API shapes -> the flat records data/prs.json carries.
// No network, no config: everything here is unit-testable with fixtures.

function mapPR(item) {
  const repoFull = item.repository_url.split("/");
  const repo = repoFull[repoFull.length - 1];
  const user = item.user || {};

  return {
    title: item.title,
    number: item.number,
    repo,
    url: item.html_url,
    author: user.login || "ghost",
    avatar: user.avatar_url || "",
    created: item.created_at,
    updated: item.updated_at,
    closed: item.closed_at || "",
    comments: item.comments || 0,
    draft: item.draft || false,
    merged: item.pull_request?.merged_at != null,
    labels: (item.labels || []).map((l) => ({
      name: typeof l === "string" ? l : l.name,
      color: typeof l === "string" ? "" : l.color || "",
    })),
  };
}

function mapMention(item) {
  const repoFull = item.repository_url.split("/");
  const repo = repoFull[repoFull.length - 1];
  const user = item.user || {};

  return {
    title: item.title,
    number: item.number,
    repo,
    url: item.html_url,
    author: user.login || "ghost",
    avatar: user.avatar_url || "",
    created: item.created_at,
    updated: item.updated_at,
    is_pr: !!item.pull_request,
    state: item.state,
  };
}
function mapComment(item) {
  const user = item.user || {};
  return {
    author: user.login || "ghost",
    avatar: user.avatar_url || "",
    body: (item.body || "").slice(0, 200),
    created_at: item.created_at,
    type: "comment",
  };
}

function mapReview(item) {
  const user = item.user || {};
  return {
    author: user.login || "ghost",
    avatar: user.avatar_url || "",
    body: (item.body || "").slice(0, 200),
    created_at: item.submitted_at,
    type: "review",
    state: item.state, // APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED
  };
}

function mapCommit(item) {
  const author = item.author || item.committer || {};
  return {
    author: author.login || (item.commit?.author?.name) || "ghost",
    avatar: author.avatar_url || "",
    body: (item.commit?.message || "").split("\n")[0].slice(0, 200),
    created_at: item.commit?.committer?.date || item.commit?.author?.date || "",
    type: "commit",
  };
}

function mapReviewComment(item) {
  const user = item.user || {};
  const path = item.path ? item.path.split("/").pop() : "";
  const prefix = path ? `${path}: ` : "";
  return {
    author: user.login || "ghost",
    avatar: user.avatar_url || "",
    body: (prefix + (item.body || "")).slice(0, 200),
    created_at: item.created_at,
    type: "review-comment",
  };
}
// The repository's review bot posts one "Review state" comment per PR, marked
// `<!-- valkey-reviewer:state -->`, with a bold verdict ("Ready for human
// review." / "Not ready for human review yet.") and usually the head it
// judged. It edits that comment in place as the PR moves.
//
// Only the negative half carries information: nearly every PR is "ready", so
// the positive verdict is a lamp that is always lit and is not surfaced. "Not
// ready" demotes the PR on the review tab. The comment is a soft contract with
// someone else's bot, so this fails open: no marker, an unparseable body, a
// verdict about an older head (named sha not a prefix of the current one), or
// a comment last touched before the latest push all yield "" (no signal).
const BOT_STATE_MARKER = "<!-- valkey-reviewer:state -->";
function botVerdict(comments, headSha, lastPush) {
  const none = { bot_verdict: "" };
  const state = (comments || []).filter((c) => (c.body || "").includes(BOT_STATE_MARKER)).pop();
  if (!state) return none;
  const m = /\*\*\s*(Ready|Not ready)\b[^*]*\*\*/i.exec(state.body);
  if (!m) return none;
  const touched = state.updated_at || state.created_at || "";
  if (lastPush && touched && new Date(touched) < new Date(lastPush)) return none;
  const paragraph = m.input.slice(m.index).split(/\n\s*\n/)[0];
  const named = /\b[0-9a-f]{7,40}\b/i.exec(paragraph);
  if (named && headSha && !headSha.toLowerCase().startsWith(named[0].toLowerCase())) return none;
  return { bot_verdict: /^not/i.test(m[1]) ? "not-ready" : "ready" };
}

// Union of the review-requested and reviewed-by searches, by URL, requested
// first so a PR in both keeps the richer (more recently updated) search hit.
function mergeReviewing(requested, reviewed) {
  const seen = new Set();
  return [...requested, ...reviewed].filter((pr) => {
    if (seen.has(pr.url)) return false;
    seen.add(pr.url);
    return true;
  });
}

// A mention that is already on another tab carries a better signal there
// (whose move, CI, threads), so it is dropped from the Mentions list.
function dedupeMentions(mentions, ...otherLists) {
  const seen = new Set(otherLists.flat().map(i => i.url));
  return mentions.filter(m => !seen.has(m.url));
}

// Where unread starts for a mention: your latest comment if you replied after
// being mentioned, else one second before the comment that mentioned you, so
// the mention itself reads as new. Falls back to the item's creation when the
// mention is in the body (comments never contain the handle).
function mentionAnchor(activity, user, created) {
  // Whole handle only: @rain must not match @rain-bot.
  const handle = new RegExp(`@${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
  const mentionedAt = (activity || []).filter(a => a.author !== user && handle.test(a.body || "")).map(a => a.created_at).sort().pop() || "";
  const myLast = (activity || []).filter(a => a.author === user).map(a => a.created_at).sort().pop() || "";
  if (myLast && myLast > mentionedAt) return myLast;
  if (mentionedAt) return new Date(new Date(mentionedAt).getTime() - 1000).toISOString();
  return created || "";
}
const EMPTY_SIGNALS = Object.freeze({
  review_decision: "",
  mergeable: "UNKNOWN",
  ci_rollup: "",
  head_oid: "",
  head_pushed_at: "",
  unresolved_threads: 0,
  threads_awaiting_me: 0,
  threads_awaiting_them: 0,
  threads_bot: 0,
  reviewers: [],
  requested: [],
  waiting_on: [],
  approvals_current: 0,
  approvals_stale: 0,
  changes_requested: 0,
  has_human_reviewer: false,
  my_review: "",
  my_review_stale: false,
  my_last_look: "",
  my_review_requested: false,
});

function isBotActor(node) {
  const a = (node || {}).author || {};
  return a.__typename === "Bot" || /\[bot\]$/.test(a.login || "");
}

// Pure mapper: turns a GraphQL pullRequest node into flat, turn-aware triage
// signals relative to `me`. Kept separate from the network call so it can be
// unit-tested.
//
// GitHub's aggregate fields are sticky across pushes: reviewDecision stays
// APPROVED / CHANGES_REQUESTED after the author pushes, and a review thread
// stays unresolved until a reviewer clicks resolve regardless of who spoke
// last. So the aggregates are kept only for display, and the fields that drive
// triage are derived here from per-review commit oids and per-thread last
// commenters, which is enough to tell whose move it is.
function mapSignals(prNode, me) {
  if (!prNode) return { ...EMPTY_SIGNALS, mergeable: "" };
  const meLower = (me || "").toLowerCase();
  const author = (prNode.author?.login || "").toLowerCase();
  const iAmAuthor = !!meLower && author === meLower;
  const head = prNode.headRefOid || "";
  const headCommit = prNode.commits?.nodes?.[0]?.commit || {};

  // Latest non-COMMENTED review per non-bot, non-author reviewer, with the
  // commit it was given on. A verdict on an older head is "stale": the
  // reviewer owes another look, and an approval no longer clears the PR.
  const latest = new Map();
  // My most recent review of any kind (COMMENTED included) and the head it
  // was on: a look on an older head means the author has pushed since.
  let myLastLook = null;
  for (const r of prNode.reviews?.nodes || []) {
    if (!r || isBotActor(r)) continue;
    const login = r.author?.login || "";
    if (!login || login.toLowerCase() === author) continue;
    if (login.toLowerCase() === meLower && (!myLastLook || (r.submittedAt || "") >= (myLastLook.at || ""))) {
      myLastLook = { oid: r.commit?.oid || "", at: r.submittedAt || "" };
    }
    if (r.state === "COMMENTED" || r.state === "PENDING") {
      if (!latest.has(login.toLowerCase())) latest.set(login.toLowerCase(), { login, state: "COMMENTED", oid: "", at: r.submittedAt || "" });
      continue;
    }
    const prev = latest.get(login.toLowerCase());
    if (!prev || prev.state === "COMMENTED" || (r.submittedAt || "") >= (prev.at || "")) {
      latest.set(login.toLowerCase(), { login, state: r.state, oid: r.commit?.oid || "", at: r.submittedAt || "" });
    }
  }
  const reviewers = [...latest.values()].map(({ login, state, oid, at }) => ({
    login,
    state,
    at,
    stale: state !== "COMMENTED" && !!head && !!oid && oid !== head,
  }));

  const requested = [];
  for (const n of prNode.reviewRequests?.nodes || []) {
    const rr = (n || {}).requestedReviewer || {};
    if (rr.login) requested.push(rr.login);
    else if (rr.slug) requested.push(`team:${rr.slug}`);
  }

  // Who owes a look: current requests without a current-head verdict, plus
  // anyone whose verdict predates the head.
  const verdictAtHead = new Set(
    reviewers.filter((r) => r.state !== "COMMENTED" && !r.stale).map((r) => r.login.toLowerCase())
  );
  const waiting = new Set();
  for (const who of requested) {
    if (!verdictAtHead.has(who.toLowerCase())) waiting.add(who);
  }
  for (const r of reviewers) if (r.stale) waiting.add(r.login);

  // Unresolved threads, split by whose reply is pending. On my own PR every
  // thread is mine to answer; on someone else's PR only threads I opened are
  // my conversations. A thread whose last word is a bot's is counted apart:
  // it is feedback the author has not acknowledged. A push after the bot
  // spoke, or a reaction on its comment, counts as acknowledgement -- Valkey
  // contributors rarely click Resolve -- so those threads are not counted.
  // On my own PR, a reviewer whose thread I answered last owes the next
  // reply, so they join waiting_on.
  const headDate = prNode.commits?.nodes?.[0]?.commit?.committedDate || "";
  let unresolved = 0, awaitingMe = 0, awaitingThem = 0, bot = 0;
  for (const t of prNode.reviewThreads?.nodes || []) {
    if (!t || t.isResolved !== false) continue;
    unresolved++;
    const first = t.opener?.nodes?.[0] || null;
    const last = t.latest?.nodes?.[0] || first;
    if (isBotActor(last)) {
      const acknowledged =
        (last.reactions?.totalCount || 0) > 0 ||
        (!!headDate && !!last.createdAt && new Date(last.createdAt) < new Date(headDate));
      if (!acknowledged) bot++;
      continue;
    }
    const lastLogin = (last?.author?.login || "").toLowerCase();
    const firstLogin = (first?.author?.login || "").toLowerCase();
    if (!meLower) continue;
    if (!iAmAuthor && firstLogin !== meLower && lastLogin !== meLower) continue; // someone else's conversation
    if (lastLogin === meLower) {
      awaitingThem++;
      if (iAmAuthor && first?.author?.login && !isBotActor(first) && firstLogin !== meLower) waiting.add(first.author.login);
    } else {
      awaitingMe++;
    }
  }

  const mine = reviewers.find((r) => r.login.toLowerCase() === meLower);
  const myVerdict = mine && mine.state !== "COMMENTED" ? mine : null;
  const rollup = prNode.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || "";

  return {
    // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null (sticky; display only)
    review_decision: prNode.reviewDecision || "",
    // MERGEABLE | CONFLICTING | UNKNOWN
    mergeable: prNode.mergeable || "UNKNOWN",
    // SUCCESS | FAILURE | ERROR | PENDING | EXPECTED | "" — includes commit
    // statuses (e.g. DCO) that check-runs alone miss.
    ci_rollup: rollup,
    head_oid: head,
    head_pushed_at: headCommit.committedDate || "",
    unresolved_threads: unresolved,
    threads_awaiting_me: awaitingMe,
    threads_awaiting_them: awaitingThem,
    threads_bot: bot,
    reviewers,
    requested,
    waiting_on: [...waiting],
    approvals_current: reviewers.filter((r) => r.state === "APPROVED" && !r.stale).length,
    approvals_stale: reviewers.filter((r) => r.state === "APPROVED" && r.stale).length,
    changes_requested: reviewers.filter((r) => r.state === "CHANGES_REQUESTED" && !r.stale).length,
    has_human_reviewer: reviewers.length > 0 || requested.length > 0,
    my_review: myVerdict ? myVerdict.state : "",
    my_review_stale: !!(myVerdict && myVerdict.stale),
    // "" (never looked) | "current" (looked at this head) | "stale" (author pushed since)
    my_last_look: !myLastLook ? "" : (head && myLastLook.oid && myLastLook.oid !== head ? "stale" : "current"),
    my_review_requested: requested.some((w) => w.toLowerCase() === meLower),
  };
}

function repoParts(pr) {
  const [owner, name] = pr.url.replace("https://github.com/", "").split("/");
  return { owner, name };
}
function monthWindows(fromIso) {
  const windows = [];
  const d = new Date(fromIso); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
  const now = new Date();
  while (d <= now) {
    const next = new Date(d); next.setUTCMonth(next.getUTCMonth() + 1);
    windows.push(`${d.toISOString().slice(0, 10)}..${new Date(next - 1).toISOString().slice(0, 10)}`);
    d.setTime(next.getTime());
  }
  return windows;
}

module.exports = { mapPR, mapMention, mapComment, mapReview, mapCommit, mapReviewComment, BOT_STATE_MARKER, botVerdict, mergeReviewing, dedupeMentions, mentionAnchor, EMPTY_SIGNALS, isBotActor, mapSignals, repoParts, monthWindows };
