# PersonalDashboard

A GitHub Pages PR dashboard for tracking pull requests across the **valkey-io** organization.

## Overview

Displays:
- PRs awaiting your review
- Your open/in-progress PRs
- Completed (merged/closed) PRs with filtering

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
- **Daily refresh via GitHub Actions** — cron at `0 16 * * *` (9 AM PDT), also on push and manual dispatch
- **Future-proofed `data/` directory** — additional data files can be added later
- **No external dependencies** — no frameworks, no CDN calls
- **Self-hosted font** — `fonts/BarlowCondensed-Bold.woff2` (OFL, latin subset) for the PR-number column; no webfont CDN
- **Dark mode** — respects `prefers-color-scheme`
- **Mobile responsive** — stat cards stack on narrow viewports

## Data Source

GitHub Search API (authenticated via `GITHUB_TOKEN` in Actions), per org:
- `review-requested:<user> is:pr is:open org:<org>`
- `author:<user> is:pr is:open org:<org>`
- `author:<user> is:pr is:closed org:<org>`
- `reviewed-by:<user> is:pr is:closed org:<org> -author:<user>`
- `mentions:<user> is:open org:<org> -author:<user>`
- `assignee:<user> is:issue is:open org:<org>`
- `author:<user> is:issue is:open org:<org>`

All queries are paginated (up to 1000 results per query).

## Setup

1. Push this repo to GitHub
2. Enable GitHub Pages (Settings > Pages > Source: **GitHub Actions**)
3. The `GITHUB_TOKEN` is automatically available to Actions — no secrets needed
4. The workflow runs on push, daily cron, and manual dispatch

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
