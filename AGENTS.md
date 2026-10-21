# PersonalDashboard

A GitHub Pages PR dashboard for tracking pull requests across the **valkey-io** organization.

## Overview

Displays:
- PRs awaiting your review
- Your open/in-progress PRs
- Done (merged/closed) PRs with filtering

The stat cards' tab labels are To Review / To Unblock / Unread Mentions /
Unread Issues / Reviewed / Done (each names what its big number counts); the count is set in the self-hosted Big Shoulders
Display (`fonts/`). The cards are a dark board: the big number is the tab's
*your move* count (`countActionable()` in `scripts/utils.js`; unread for Issues
and Mentions; the plain total for Reviewed and Done), the caption holds the total,
and `updateCards()` in `scripts/dashboard.js` toggles a `lit` class only while
the number is above zero. Color applies only to lit cards (see README).

## Files

| File | Description |
|------|-------------|
| `config.json` | User/org configuration — edit this to personalize your fork |
| `index.html` | Main dashboard — all tabs with filters |
| `data/prs.json` | PR data fetched from GitHub API (refreshed at deploy time) |
| `scripts/fetch-prs.js` | Node script that queries GitHub Search API and writes `data/prs.json` |
| `.github/workflows/update.yml` | GitHub Actions workflow — builds + deploys via Pages |
| `AGENTS.md` | This file |

## Architecture

- **GitHub Pages via `deploy-pages` action** — no commit-back, artifact-based deployment
- **Data separated from markup** — `data/prs.json` is fetched at runtime via `fetch()`
- **Refresh cadence** — the hourly `schedule:` is the floor (GitHub throttles it to 3-6 h on quiet repos); `contrib/systemd/` holds an optional user timer that runs `gh workflow run update.yml` every 15 min on top of it; the workflow also runs on push and manual dispatch
- **Incremental fetch** — the fetcher loads the deployed `data/prs.json` (`PRIOR_DATA_URL`, or a local `data/prs.json`) as the prior run; `reuseActivity()` keeps an item's activity when its search `updated_at` is unchanged and the cached copy (`activity_fetched_at`) is under 6 h old, `reuseCI()` keeps `ci_jobs` when `head_oid` and a settled `ci_rollup` are unchanged; GraphQL signals are never cached. Signals are fetched before activity so they can key the CI cache
- **Live page** — `scripts/dashboard.js` polls `data/prs.json` every 2 min and on `visibilitychange`; a new `updated` is swapped in by `applyData()` without a reload (filters, repo chips, open activity sections preserved; `buildRepoCheckboxes()` is idempotent and only appends new repos). The header always shows the data age (`dataAgeLabel()` in `scripts/utils.js`, ticked every 30 s); the stale banner threshold is `config.json` `stale_after_minutes` (default 6 h for schedule-only installs, 45 here with the timer), re-evaluated on every poll and tick
- **Future-proofed `data/` directory** — additional data files can be added later
- **No external dependencies** — no frameworks, no CDN calls
- **Self-hosted font** — `fonts/BigShouldersDisplay-Bold.woff2` (OFL, latin subset) for the PR-number column; no webfont CDN
- **Dark mode** — respects `prefers-color-scheme`
- **Mobile responsive** — stat cards stack on narrow viewports

## Data Source

GitHub Search API (authenticated via `GITHUB_TOKEN` in Actions), per org:
- `review-requested:<user> is:pr is:open org:<org>`
- `author:<user> is:pr is:open org:<org>`
- `author:<user> is:pr is:closed org:<org>`
- `reviewed-by:<user> is:pr is:open org:<org> -author:<user>`
- `reviewed-by:<user> is:pr is:closed org:<org> -author:<user>`
- `mentions:<user> is:open org:<org> -author:<user>`
- `assignee:<user> is:issue is:open org:<org>`
- `author:<user> is:issue is:open org:<org>`

All queries are paginated (up to 1000 results per query).

The `review-requested` and `reviewed-by ... is:open` searches are unioned by URL
(`mergeReviewing()`) into one `reviewing` list: a PR asked of you and a PR you
already reviewed are the same job at different stages, and `whoseMove()` says
which. There is no manual "mark reviewed"; declining a review is done on GitHub
by removing yourself as reviewer, which the next fetch reflects.

In-flight PRs (reviewing, your open) are then enriched per PR:
REST for commits / reviews / comments / check-runs (activity feed + CI dots), and
one GraphQL query (`PR_SIGNALS_QUERY`) for `headRefOid`, per-review commit oids,
review requests, each unresolved thread's opener and last commenter, and the
status-check rollup. `mapSignals()` in `scripts/fetch-prs.js` turns that into
flat turn-aware fields (`waiting_on`, `approvals_current`, `approvals_stale`,
`changes_requested`, `threads_awaiting_me`, `threads_bot`, `my_review`,
`my_review_stale`, `my_last_look`, ...); `whoseMove()` in `scripts/utils.js`
ranks them per tab. GitHub's `reviewDecision` is kept for display only: it is
sticky across pushes.

`threads_bot` counts unresolved threads whose last word is a bot's and that the
author has not acknowledged: the thread's last comment carries `createdAt` and
`reactions.totalCount`, and the head commit carries `committedDate`, so a push
after the bot spoke or a reaction on its comment drops the thread from the
count. `botVerdict()` in `scripts/fetch-prs.js` reads the Valkey review bot's
`<!-- valkey-reviewer:state -->` issue comment from the REST comments already
fetched for the activity feed and sets `bot_verdict` to `not-ready` / `ready` /
`""`; it fails open (no marker, no bold verdict, a named sha that is not a
prefix of the head, or an edit older than `last_push` all give `""`). Only
`not-ready` is used by `whoseMove()`. `fetchCIStatus()` maps a check-run
conclusion of `action_required` to its own `ci_jobs[].status`, and `ciState()`
reports it as `"action_required"` (below `cancelled`, above `pending`).

Mentions come from one `mentions:<user> is:open` search per org. `dedupeMentions()`
drops any already on To Review / Reviewing / Authored / Issues, and the survivors
get issue-comment activity; `mentionAnchor()` sets `unread_anchor` to your latest
reply after the mention, else one second before the mentioning comment, else the
item's creation (body mentions). `getUnreadActivity()` in `scripts/dashboard.js`
honors `unread_anchor` ahead of its author-based defaults.

Local marks live in localStorage under `dashboard-read-markers` as
`{ url: { read_at, pinned_at } }` (`normalizeMarker()` also accepts the older
bare-timestamp value). `rowRail()` renders the per-row controls (read/unread,
pin); a document-level click handler applies them and re-renders every tab. The
header reset also removes the legacy `dashboard-overrides` key from the days when
tab moves were a local override. `pinStillHolds()` clears a pin once `myLastAction()` (the user's latest
comment/review/commit, or push on their own PR) is later than `pinned_at`; the
prune pass at load applies it and drops marks for closed items. `countActionable()`
takes an `isPinned` predicate so pinned rows light the card. Below 600px `.pr-item`
switches to a grid (`ava num title rail` header row, then chips/meta/ci/activity
full-width) with `.pr-content`/`.pr-title-row` as `display: contents`, so the row
markup is the same at every width.

## Merger row

`config.merge_access` (orgs or `owner/repo`) turns on `fetchMergerData()` in
`scripts/fetch-prs.js`: one search per entry for all open PRs, the lean signals
fragment (no review threads) in batches of 25, `actions/runs?status=action_required`
per repo keyed by head sha, collaborators-with-push per repo (403 without push
access; the merge-history set of mergers is the fallback and complement), and
`.github/` file checks only for PRs whose runs are waiting. `buildMergerSections()`
in `scripts/merger.js` (pure, tested in `tests/merger.test.js`) assigns each PR to
at most one of ci / maint / land / unstick / queue with a `merger_reason`. Only
section members are published under `data.merger`; the dashboard renders them
with `renderPR(pr, "merger")`, which uses the reason as the move chip and gives
the row a pin-only rail (no activity feed, so no read mark).

The all-time Merged counter lives in `data/merger-cache.json` (version
`MERGER_CACHE_VERSION`; bump to force a rescan). CI reads the previous copy from
the deployed Pages site (`GITHUB_REPOSITORY` or `DASHBOARD_PAGES_URL`), then
fetches merges since `last_merged_at`, deduped by the boundary-day `seen` keys.
Budget per refresh is ~35 GraphQL points and ~260 REST calls; the one-time
history scan is ~120 points.

## Setup

1. Push this repo to GitHub
2. Enable GitHub Pages (Settings > Pages > Source: **GitHub Actions**)
3. The `GITHUB_TOKEN` is automatically available to Actions — no secrets needed
4. The workflow runs on push and manual dispatch; install the `contrib/systemd/` timer on an always-on machine for the 15-minute cadence (README, "Refresh cadence")

## Fork & Personalize

To create your own dashboard:

1. Fork this repository
2. Edit `config.json` — set your organization(s):
   ```json
   {
     "orgs": ["your-org", "another-org"],
     "title": "PR Dashboard"
   }
   ```
3. Enable GitHub Pages in your fork (Settings > Pages > Source: **GitHub Actions**)
4. Push — the workflow runs automatically and deploys your personalized dashboard

The GitHub username is **auto-detected** from the repository owner — no need to configure it.
The `github_user` field in `config.json` is only used as a fallback for local development.

## Local Development

Open `index.html` via a local server (needed for `fetch()` to work):
```
npx serve .
```

To manually refresh data:
```
GITHUB_TOKEN=ghp_... node scripts/fetch-prs.js
```
