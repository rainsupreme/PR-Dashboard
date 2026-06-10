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
- Auto-refreshes daily via GitHub Actions
- Zero dependencies — single HTML file + JSON data

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
     "title": "PR Dashboard"
   }
   ```
5. Push — the workflow deploys your personalized dashboard automatically

That's it. Your dashboard will be live at `https://<username>.github.io/PersonalDashboard/`

The GitHub username is auto-detected from the repository owner. The `github_user` field in `config.json` is only a fallback for local development.

Multiple orgs are fully supported — data from all orgs is merged into a single view.

## How It Works

```
config.json          ← your org + preferences
scripts/fetch-prs.js ← queries GitHub Search API, writes data/prs.json
data/prs.json        ← all PR/issue data (refreshed at deploy time)
index.html           ← single-page dashboard (fetches data/prs.json)
.github/workflows/   ← daily cron + push + manual trigger
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
