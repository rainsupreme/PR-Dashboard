// Triage signals for a list of PRs, fetched in aliased GraphQL batches.

const { graphql, sleep } = require("./github.js");
const { GITHUB_USER } = require("./settings.js");
const { mapSignals, repoParts, EMPTY_SIGNALS } = require("./mappers.js");

// Fields every in-flight PR needs for triage. Shared by the per-PR query
// (fallback) and the aliased batch query below.
const PR_SIGNALS_FRAGMENT = `
fragment Signals on PullRequest {
  reviewDecision
  mergeable
  headRefOid
  author { login }
  reviewRequests(first: 20) {
    nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
  }
  reviews(last: 100) {
    nodes { author { login __typename } state submittedAt commit { oid } }
  }
  reviewThreads(first: 100) {
    nodes {
      isResolved
      opener: comments(first: 1) { nodes { author { login __typename } } }
      latest: comments(last: 1) { nodes { author { login __typename } createdAt reactions { totalCount } } }
    }
  }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
}`;

// Lean variant for project-wide (merger) PRs: no review threads, which the
// merger rules never read. ~70 nodes per PR instead of ~420, so 400+ PRs fit
// inside the 1000-point hourly GraphQL budget of the Actions token.
const PR_SIGNALS_LEAN_FRAGMENT = `
fragment Signals on PullRequest {
  reviewDecision
  mergeable
  headRefOid
  author { login }
  reviewRequests(first: 20) {
    nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
  }
  reviews(last: 50) {
    nodes { author { login __typename } state submittedAt commit { oid } }
  }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
}`;

const PR_SIGNALS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ...Signals }
  }
}
${PR_SIGNALS_FRAGMENT}`;

const SIGNALS_BATCH_SIZE = 25;

async function fetchPRSignals(pr) {
  const { owner, name } = repoParts(pr);
  try {
    const data = await graphql(PR_SIGNALS_QUERY, { owner, name, number: pr.number });
    return mapSignals(data?.repository?.pullRequest, GITHUB_USER);
  } catch (e) {
    console.warn(`  Failed to fetch signals for #${pr.number}: ${e.message}`);
    return { ...EMPTY_SIGNALS };
  }
}

// One GraphQL call for up to SIGNALS_BATCH_SIZE PRs, each under its own alias.
// Returns an array of signal objects in input order; a failed batch falls
// back to per-PR fetches so one bad node cannot blank the whole batch.
async function fetchSignalsBatch(prs, fragment = PR_SIGNALS_FRAGMENT, retried = false) {
  const parts = prs.map((pr, i) => {
    const { owner, name } = repoParts(pr);
    return `p${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${pr.number}) { ...Signals } }`;
  });
  const query = `query { ${parts.join("\n")} }\n${fragment}`;
  try {
    const data = await graphql(query, {});
    return prs.map((pr, i) => mapSignals(data?.[`p${i}`]?.pullRequest, GITHUB_USER));
  } catch (e) {
    if (/RATE_LIMIT/i.test(e.message)) {
      // Usually the per-minute secondary limit, not the hourly budget: wait it
      // out once. If it still fails, say so rather than hammer the per-PR path.
      if (!retried) {
        console.warn(`  Signals batch of ${prs.length} hit the GraphQL rate limit; waiting 65s and retrying once.`);
        await sleep(65000);
        return fetchSignalsBatch(prs, fragment, true);
      }
      console.warn(`  Signals batch of ${prs.length} still rate limited; marking them as missing.`);
      return prs.map(() => ({ ...EMPTY_SIGNALS, signals_missing: true }));
    }
    console.warn(`  Signals batch of ${prs.length} failed (${e.message}); retrying one by one.`);
    const out = [];
    for (const pr of prs) out.push(await fetchPRSignals(pr));
    return out;
  }
}

async function enrichWithSignals(prs, label, fragment = PR_SIGNALS_FRAGMENT) {
  if (prs.length === 0) return prs;
  console.log(`\n  Fetching triage signals for ${prs.length} ${label} PRs (${Math.ceil(prs.length / SIGNALS_BATCH_SIZE)} batches)...`);
  const enriched = [];
  for (let i = 0; i < prs.length; i += SIGNALS_BATCH_SIZE) {
    const slice = prs.slice(i, i + SIGNALS_BATCH_SIZE);
    const signals = await fetchSignalsBatch(slice, fragment);
    slice.forEach((pr, j) => enriched.push({ ...pr, ...signals[j] }));
    if (i + SIGNALS_BATCH_SIZE < prs.length) await sleep(750); // stay under the per-minute secondary limit
  }
  const missing = enriched.filter((p) => p.signals_missing).length;
  if (missing) console.warn(`  ${missing} of ${prs.length} ${label} PRs have no signals this run.`);
  return enriched;
}
module.exports = { PR_SIGNALS_FRAGMENT, PR_SIGNALS_LEAN_FRAGMENT, PR_SIGNALS_QUERY, SIGNALS_BATCH_SIZE, fetchPRSignals, fetchSignalsBatch, enrichWithSignals };
