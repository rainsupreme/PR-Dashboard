# Personal PR Dashboard

A GitHub Pages dashboard for tracking your pull requests and issues across one or more GitHub organizations.

**PR Dashboard**: [rainsupreme.github.io/PR-Dashboard](https://rainsupreme.github.io/PR-Dashboard/)

## Features

- **Needs Your Review** — open PRs requesting your review, with stale badges (> 7 days)
- **Working On** — your open PRs
- **Mentions** — issues/PRs where you're @mentioned
- **Issues** — issues assigned to you or opened by you
- **Reviewed** — PRs you've reviewed (closed/merged)
- **Completed** — your closed/merged PRs

Each tab has:
- Multi-select repo filter (checkbox-based)
- Sort and type filters where applicable
- Date range filters for historical tabs

Other features:
- GitHub Primer color scheme (light/dark/system toggle)
- Mobile responsive
- Auto-refreshes hourly via GitHub Actions
- Zero dependencies — single HTML file + JSON data

## Triage

Your in-flight PRs (**Working On** and **Reviewed (Open)**) are enriched via
the GitHub GraphQL API with the signals that tell you *where the ball is*:

- **Review decision** — ✓ approved / ✗ changes requested
- **Mergeable state** — ⚠ conflicts when a rebase is needed
- **Unresolved review threads** — count of open conversations
- **CI** — per-job status dots, summarized as green / failing

When a PR is fully clear these collapse into one composite chip —
`✓ approved · green · mergeable` — otherwise the specific state chips show.

These feed a **Triage (needs action)** sort, the default on the *Needs
Review*, *Reviewed (Open)*, and *Working On* tabs (chronological sorts remain
as options). It ranks by urgency:

1. Queued for merge but broken (CI red / conflict)
2. CI failing
3. Changes requested
4. Merge conflict
5. Unresolved review threads
6. Ready to land but not yet queued (nudge a maintainer)
7. Stale review request (> 7 days)

PRs with nothing actionable *and* no new activity are dimmed; anything
needing action stays highlighted even when quiet.

## Merge labels

Set `merge_labels` in `config.json` to flag PRs a maintainer has queued for
merge (e.g. Valkey's `to_be_merged`). Matching labels render in their real
GitHub color and feed the triage ranking — kept visually and semantically
distinct from the mechanical readiness signal above. A PR that is mechanically
ready but *not* yet labelled sorts as "nudge a maintainer"; one that is
labelled *and* healthy sinks to the bottom ("just waiting").

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
     "merge_labels": ["to_be_merged"]
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
config.json          ← your org + preferences (incl. merge_labels)
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
