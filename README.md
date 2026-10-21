# Personal PR Dashboard

A GitHub Pages dashboard for tracking your pull requests and issues across one or more GitHub organizations.

**PR Dashboard**: [rainsupreme.github.io/PR-Dashboard](https://rainsupreme.github.io/PR-Dashboard/)

## Features

- **To Review** — open PRs requesting your review, with stale badges (> 7 days)
- **To Follow Up** — PRs you've reviewed that are still open
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
- Auto-refreshes hourly via GitHub Actions
- Zero dependencies — single HTML file + JSON data

## Triage

The stat cards work like a dark board: a card's big number is what that tab
wants from you, and it is grey until that number is above zero, so each card
reads as a sentence (`0 To Unblock · 19 PRs open`). **To Review** counts review
requests you can act on now; **To Follow Up** counts PRs you reviewed that are
*your move* again (a re-review, a reply, a stale approval to re-check, a merge);
**To Unblock** counts your own PRs that are waiting on you (CI, conflicts,
requested changes, a reply, a reviewer to find, a merge); **Unread Mentions** and
**Unread Issues** count unread activity. The tab's total sits in the caption
(`15 PRs open`). A lit card means act; a row of grey numbers
means nothing is waiting on you. **Mentions** lists only items not already on
another tab, and counts as new everything since the comment that mentioned you
(or since your reply to it). **Reviewed** and **Done** are history and never light up.
The lit color says which hat: yellow = act now, blue = your reviewer hat,
green = your author hat, purple = peripheral.

Your in-flight PRs (**To Review**, **To Follow Up** and **To Unblock**) are enriched via the GitHub GraphQL API, and every row carries one chip
that says *whose move it is*, relative to you:

| Chip | Meaning |
|---|---|
| **→ fix CI / rebase / reply in N threads / re-review / merge …** | Your move. The row stays bright until you act. |
| **? find a reviewer** | Nobody has engaged: no review, no review request. Also your move, and the easiest one to forget. |
| **nudge a committer** | Approved on the current head, green and mergeable, but you can't merge here. |
| **waiting on @name · Nd** | Their move: a reviewer owes a look (requested, or their verdict predates the head, or you answered their thread last). Dimmed. |
| **author's move** | On a PR you reviewed: CI red, conflicts, or changes requested. Dimmed. |
| **queued for merge** | Carries a merge label and is healthy. Dimmed. |

Beside it, the specific state chips: ✓ approved (or *approved (older head)*),
✗ changes requested, ✗ CI failing, ⊘ CI cancelled, ⚠ conflicts, and the
unresolved threads split into *N awaiting you* / *N awaiting them* / *N bot*.
CI is also shown as per-job dots.

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

Time is shown (`· 12d`) but is never an input to whose move it is.

These feed the **Triage (needs action)** sort, the default on the three tabs
(chronological sorts remain as options). The ladder differs by tab because your
relationship to the PR differs:

- **Authored** (you are the author): queued-but-broken > CI failing >
  changes requested > conflicts > threads awaiting you > find a reviewer > ready
  to land > cancelled CI > queued > waiting on a reviewer.
- **Reviewing** (you reviewed): review requested of you > author replied
  in your thread > *author's move if broken* > re-review after a push > re-check
  a stale approval > re-look after a comment-only review > merge (or nudge) >
  waiting on others.
- **To Review**: your review, unless the author has CI or conflicts to
  fix first; a request older than 7 days is bumped.

## Merge labels and merge access

Set `merge_labels` in `config.json` to flag PRs a maintainer has queued for
merge (e.g. Valkey's `to-be-merged`). Matching labels render in their real
GitHub color and feed the triage ranking: a PR that is mechanically ready but
*not* yet labelled is a nudge; one that is labelled *and* healthy sinks to the
bottom ("just waiting").

Set `merge_access` to the orgs (`"valkey-io"`) or repos (`"valkey-io/valkey"`)
where *you* can merge. There, a ready PR becomes **→ merge**, your own move,
instead of **nudge a committer**.

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
     "merge_access": ["valkey-io"]
   }
   ```
   `merge_labels` is optional — list any repo labels your project uses to mark
   PRs as queued for merge. Leave it out (or empty) to disable label flagging.
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
.github/workflows/   ← hourly cron + push + manual trigger
```

The GitHub Actions workflow:
1. Checks out the repo
2. Runs `fetch-prs.js` with the auto-provided `GITHUB_TOKEN`
3. Uploads the entire directory as a Pages artifact
4. Deploys via `deploy-pages` action

No data is committed back to the repo — fresh data is fetched at each deploy.

## Local Development

```bash
# Serve locally (needed for fetch() to work)
npx serve .

# Manually refresh data
GITHUB_TOKEN=$(gh auth token) node scripts/fetch-prs.js
```

## License

BSD 3-Clause License. See [LICENSE](LICENSE).
