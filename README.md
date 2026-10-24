# Personal PR Dashboard

A GitHub Pages dashboard for tracking your pull requests and issues across one or more GitHub organizations.

**PR Dashboard**: [rainsupreme.github.io/PR-Dashboard](https://rainsupreme.github.io/PR-Dashboard/)

## Features

- **To Review** — open PRs you are reviewing: requested of you, or already
  reviewed by you and still open. One list; a chip on each row says which stage
  it is at (first look, re-review, reply, merge) and a stale badge marks a first
  request older than 7 days
- **To Unblock** — your open PRs
- **Unread Mentions** — issues/PRs where you're @mentioned and not already on another tab
- **Unread Issues** — issues assigned to you or opened by you
- **Reviewed** — PRs you've reviewed (closed/merged)
- **Done** — your closed/merged PRs

Each tab has:
- Multi-select repo filter (checkbox-based)
- Sort and type filters where applicable
- Date range filters for historical tabs

Other features:
- GitHub Primer color scheme (light/dark/system toggle)
- Tab counts are colored by what the tab asks of you: yellow = act now, blue =
  your reviewer hat, green = your author hat, purple = peripheral, grey = history
- Mobile responsive
- Refreshes every 15 minutes (a timer dispatches the workflow; an open tab picks
  up new data within 2 minutes without a reload)
- Zero dependencies — single HTML file + JSON data

## Triage

The stat cards work like a dark board: a card's big number is what that tab
wants from you, and it is grey until that number is above zero, so each card
reads as a sentence (`0 To Unblock · 19 PRs open`). **To Review** counts the
PRs you are reviewing that are *your move* now (a first look you can act on, a
re-review, a reply, a stale approval to re-check, a merge); **To Unblock** counts your own PRs that are waiting on you (CI, conflicts,
requested changes, a reply, a reviewer to find, a merge); **Unread Mentions** and
**Unread Issues** count unread activity. The tab's total sits in the caption
(`15 PRs open`, plus `· N pinned` when you have pinned rows). A lit card means act; a row of grey numbers
means nothing is waiting on you. **Mentions** lists only items not already on
another tab, and counts as new everything since the comment that mentioned you
(or since your reply to it). **Reviewed** and **Done** are history and never light up.
The lit color says which hat: blue = your reviewer hat, green = your author
hat, purple = peripheral.

Your in-flight PRs (**To Review** and **To Unblock**) are enriched via the GitHub GraphQL API, and every row carries one chip
that says *whose move it is*, relative to you:

| Chip | Meaning |
|---|---|
| **→ fix CI / rebase / reply in N threads / re-review / merge …** | Your move. The row stays bright until you act. |
| **? find a reviewer** | Nobody has engaged: no review, no review request. Also your move, and the easiest one to forget. |
| **nudge a committer** | Approved on the current head, green and mergeable, but you can't merge here. |
| **waiting on @name · Nd** | Their move: a reviewer owes a look (requested, or their verdict predates the head, or you answered their thread last). Dimmed. |
| **author rebasing / author fixing CI / addressing another review / address N bot threads / review bot: not ready / author's move** | Their move: the author has something to do before a review is worth your time. Dimmed. See *Not ready for a human yet* below. |
| **CI awaits approval** | A first-time contributor's workflows wait for a maintainer to approve the run. Where you can merge, this is **→ approve CI run**, your move. |
| **queued for merge** | Carries a merge label and is healthy. Dimmed. |

Every in-flight row also has a small **rail** on its right edge with the row's
manual controls, in the same place at every width: **mark read** (✓, or ↩ to
mark unread again) and **pin** (⚑).
A read mark is a statement about the past: new activity after it shows as new
again. A pin is a promise to act: the row stays bright, gets a bar on its left
edge and a flag on the avatar, counts toward the card's lit number, and clears
only when *you* act on the item (comment, review, push) or it closes. Both are
stored in your browser (localStorage), so they are per device; the reset button
in the header clears them. On phones the avatar, number
and title form a header row and the chips, meta and rail flow beneath.

Beside it, the specific state chips: ✓ approved (or *approved (older head)*),
✗ changes requested, ✗ CI failing, ⊘ CI red: tracked flake only, ⊘ CI cancelled,
⊘ CI awaits approval, ⚠ conflicts, and the unresolved threads split into
*N awaiting you* / *N awaiting them* / *N bot*.
CI is also shown as per-job dots; a red dot drawn square is a failure the flake
registry tracks (hover for the issue).

### Why not GitHub's own fields?

GitHub's aggregate fields are sticky across pushes. `reviewDecision` stays
`APPROVED` or `CHANGES_REQUESTED` after the author pushes new commits, and a
review thread stays unresolved until a reviewer clicks *resolve*, no matter who
spoke last. Read naively, that labels a PR you need to re-review as "author's
move" and a PR whose approval is three pushes old as "ready to merge".

So the dashboard derives the turn itself:

- **Per-reviewer verdicts against the head commit.** Each reviewer's latest
  APPROVED / CHANGES_REQUESTED carries the commit it was given on; a verdict on
  an older head is *stale*, which means that reviewer owes another look and the
  approval no longer clears the PR.
- **Per-thread last word.** An unresolved thread awaits whoever did *not* speak
  last. On your own PR every thread counts; on someone else's only threads you
  opened are yours. A thread whose last word is a bot's is counted apart.
- **Review requests** without a current-head verdict put the first look in that
  person's court.
- **CI** combines the per-job check-runs with the commit's status rollup, so a
  failed commit status (e.g. DCO) is seen, and a *cancelled* lane is reported as
  such rather than as green or as a failure.
- **Tracked flakes** come from a flake registry (`config.json` `flake_registry`,
  a URL to [valkey-daily-dashboard](https://github.com/rainsupreme/valkey-daily-dashboard)'s
  `flakes.json`). A failed job whose name the registry tracks under an open issue
  is still red, but its dot is square and its chip reads *CI red: tracked flake
  only* when every red job is one, in the neutral style of a cancelled lane:
  the PR needs reruns or a waiver, not a fix. An entry whose fix has merged is
  not applied, since whether this PR's base carries the fix is not known here.
  Whose move it is does not change: a tracked flake is still a CI failure to
  the triage ladders. Only job-level entries (a job red outside any test, such
  as a setup step) are matched; test-level entries need the job log.

Time is shown (`· 12d`) but is never an input to whose move it is.

These feed the **Triage (needs action)** sort, the default on both tabs
(chronological sorts remain as options). The ladder differs by tab because your
relationship to the PR differs:

- **To Unblock** (you are the author): queued-but-broken > CI failing >
  changes requested > conflicts > threads awaiting you > find a reviewer > ready
  to land > cancelled CI > queued > waiting on a reviewer.
- **To Review** (you are a reviewer): the author's blockers come first, since
  a look at a PR the author is about to change is wasted -- draft > a reply in
  your own thread (cheap, so it jumps the queue) > conflicts > CI failing > CI
  awaiting approval > another reviewer's changes requested > unacknowledged bot
  threads > review bot says not ready. Then what you owe: re-review requested >
  re-review after a push > re-check a stale approval > re-look after a
  comment-only review > first review (bumped after 7 days) > merge (or nudge) >
  waiting on others.

### Not ready for a human yet

A reviewer's time is the scarce resource, so a PR drops out of your lit count
while its author still has something to do. Two of those signals come from
bots:

- **Unacknowledged bot threads.** An unresolved review thread whose last word
  is a bot's (CodeRabbit, the Valkey review bot) counts as feedback the author
  has not looked at. Any acknowledgement clears it: a reply, a reaction on the
  bot's comment, resolving the thread, or a push after the bot spoke. Addressing
  or explicitly declining bot feedback is itself a positive signal to a human
  reviewer; a wall of untouched bot threads says the PR is not ready for one.
- **The review bot's verdict.** `valkey-review-bot` keeps one *Review state*
  comment per PR (marked `<!-- valkey-reviewer:state -->`) with a bold verdict.
  Only **Not ready for human review yet** is used, as a demotion; **Ready** is
  nearly universal and carries no information, so it changes nothing. The
  verdict is ignored when it names an older head or was last edited before the
  latest push, and any parse failure means no signal.

Neither demotion is permanent: the row stays on the tab, dimmed, with the chip
naming what the author owes, and it lights again as soon as the author moves.
To decline a review, remove yourself as a reviewer on GitHub (ideally with a
note saying why); that is the one action the author and other reviewers can
see, and the dashboard follows it on the next fetch. There is no local "mark
reviewed".

## Merger row

When `merge_access` names repos you can merge in, a second row of cards appears
above your own, for the duties only someone with merge rights can do across the
whole project. Each card is a dark-board count over every open PR in those repos:

| Card | Counts |
|---|---|
| **Let CI Run** | first-time contributors whose workflow runs await approval in the Actions tab, with whether the PR touches `.github/` |
| **Needs a Maintainer** | PRs reviewed only by people without write access; no committer has reviewed, commented or been requested |
| **To Land** | approved by a committer on the current head, green, mergeable, and still unmerged a week later |
| **To Unstick** | committer-approved but conflicting or red, or changes requested and the author quiet for a month |
| **Queued** | carrying a merge label; lit only when one of them is broken |
| **Merged** | every PR you have merged there, all time, with the month you started |

Each PR lands in at most one of the first five, oldest first, with a chip saying
why. Who counts as a committer comes from the repo's collaborator list when the
token can read it, plus everyone who has ever merged a PR there (public, and the
same set over time). Rules live in `scripts/merger.js`; no model is involved.

The Merged counter is incremental: the first run walks the merge history once,
later runs fetch only merges since the last one. The cache (`data/merger-cache.json`)
ships with the site and is read back from Pages on the next refresh. It also
remembers, per head commit, whether a PR with runs awaiting approval touches
`.github/`, so that check costs a request only for heads it has not seen.

## Merge labels and merge access

Set `merge_labels` in `config.json` to flag PRs a maintainer has queued for
merge (e.g. Valkey's `to-be-merged`). Matching labels render in their real
GitHub color and feed the triage ranking: a PR that is mechanically ready but
*not* yet labelled is a nudge; one that is labelled *and* healthy sinks to the
bottom ("just waiting").

Set `merge_access` to the repos (`"valkey-io/valkey"`) where *you* can merge,
or a bare org (`"valkey-io"`) if that is every repo in it. There, a ready PR
becomes **→ merge**, your own move, instead of **nudge a committer**, and the
merger row above covers exactly those repos.

## Fork & Personalize

> **Important**: You must enable GitHub Pages **before** the first workflow run, otherwise the deploy step will fail.

### Setup (one-time, takes 30 seconds)

1. Fork this repository
2. Go to the **Actions** tab in your fork and click **"I understand my workflows, go ahead and enable them"**
3. Go to **Settings > Pages** and set Source to **GitHub Actions**
4. Edit `config.json` — set your organization(s):
   ```json
   {
     "orgs": ["your-org"],
     "title": "PR Dashboard",
     "merge_labels": ["to-be-merged"],
     "merge_access": ["your-org/your-repo"]
   }
   ```
   `merge_labels` is optional — list any repo labels your project uses to mark
   PRs as queued for merge. Leave it out (or empty) to disable label flagging.
   `merge_access` is optional too — list the repos where you can merge, one
   `owner/repo` each. A bare org (`"your-org"`) means every repo in it, which is
   only right if you can merge org-wide; it also makes the merger fetch cover
   every one of them.
5. Push — the workflow deploys your personalized dashboard automatically

That's it. Your dashboard will be live at `https://<username>.github.io/PersonalDashboard/`

The GitHub username is auto-detected from the repository owner. The `github_user` field in `config.json` is only a fallback for local development.

Multiple orgs are fully supported — data from all orgs is merged into a single view.

## How It Works

```
config.json          ← your org + preferences (merge_labels, merge_access)
scripts/fetch-prs.js ← queries GitHub Search + GraphQL APIs, writes data/prs.json
data/prs.json        ← all PR/issue data + triage signals (refreshed at deploy time)
index.html           ← single-page dashboard (fetches data/prs.json)
scripts/utils.js     ← shared logic (sorting, triage scoring) — also unit-tested
.github/workflows/   ← hourly cron (throttled by GitHub) + push + workflow_dispatch
contrib/systemd/     ← timer + service (user/ or system/ variant) dispatching the workflow every 15 min
```

The GitHub Actions workflow:
1. Checks out the repo
2. Runs `fetch-prs.js` with the auto-provided `GITHUB_TOKEN`
3. Uploads the entire directory as a Pages artifact
4. Deploys via `deploy-pages` action

No data is committed back to the repo — fresh data is fetched at each deploy.

## Refresh cadence

The workflow's hourly `schedule:` is the floor every checkout gets, but GitHub
throttles scheduled runs on quiet repos: in practice it fires every 3-6 hours.
`workflow_dispatch` is not throttled, so for a 15-minute cadence add a one-line
systemd timer that runs `gh workflow run update.yml -R <owner>/<repo>`.
The schedule keeps running alongside it; an extra run is cheap. On an always-on
machine where `gh` is logged in with the `workflow` scope, pick the variant
your host supports:

**Per-user units** (a desktop with a user systemd manager):

```bash
cp contrib/systemd/user/pr-dashboard-refresh.* ~/.config/systemd/user/
# edit PR_DASHBOARD_REPO in the .service if this is a fork
systemctl --user daemon-reload
systemctl --user enable --now pr-dashboard-refresh.timer
systemctl --user list-timers pr-dashboard-refresh.timer   # next fire
journalctl --user -u pr-dashboard-refresh.service -n 5    # last dispatches
```

**System units** (no per-user manager, e.g. systemd 219 on Amazon Linux 2,
where `systemctl --user` fails with "Failed to get D-Bus connection"). The
service runs as the named user, so `gh` finds that user's login:

```bash
# edit User=, HOME= and PR_DASHBOARD_REPO in the .service first
sudo cp contrib/systemd/system/pr-dashboard-refresh.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pr-dashboard-refresh.timer
systemctl list-timers pr-dashboard-refresh.timer          # next fire
journalctl -u pr-dashboard-refresh.service -n 5           # last dispatches
```

Each run costs a few API requests, not a few hundred: the fetcher downloads the
currently deployed `data/prs.json` (`PRIOR_DATA_URL`) and reuses an item's
activity when its search `updated_at` has not moved, and its check-runs when
the head commit and its settled CI rollup have not moved. GraphQL triage
signals are always re-fetched, since merge state, thread turns and CI finish
without touching `updated_at`. A quiet run of the personal lists is ~10 REST +
~2 GraphQL requests; with the merger row for nine repos the whole run measured
47 REST + 20 GraphQL, against budgets of 1,000 and 5,000 per hour, so
`GITHUB_TOKEN` suffices; set a
`DASHBOARD_TOKEN` secret (a PAT, public read is enough) only if you want a
cadence well under 10 minutes. Cached activity is re-fetched after 6 hours
regardless, bounding anything that fails to bump `updated_at`. The tight
budget is search: ~27 search calls per run against GitHub's 30 per minute, so
a secondary-limit 403 there is waited out for 60 s instead of failing the run,
while a permission 403 (the Actions token cannot list another repo's
collaborators) fails at once and falls back.

The page polls `data/prs.json` every 2 minutes while open (and when the tab
becomes visible) and swaps new data in place; filters, pins, open activity
sections and scroll position survive. The header always shows the data's age
("Updated Oct 21, 02:23 PM (12 min ago)"), ticking every 30 s. The stale
banner is the alarm for a stopped pipeline, so its threshold follows your
cadence: `stale_after_minutes` in `config.json`, 45 here (three missed
15-minute fires). Leave it unset without the timer: the default is 6 hours,
because GitHub stretching the hourly schedule to 3-6 hours is normal, not a
stall.

## Local Development

```bash
# Serve locally (needed for fetch() to work)
npx serve .

# Manually refresh data (an existing data/prs.json is used as the prior snapshot;
# delete it, or set PRIOR_DATA_URL to the deployed copy, to choose the baseline)
GITHUB_TOKEN=$(gh auth token) node scripts/fetch-prs.js
```

## License

BSD 3-Clause License. See [LICENSE](LICENSE).
