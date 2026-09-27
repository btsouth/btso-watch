// Checks whether btso.dev's GitHub snapshot is missing a release, and asks the
// site to refresh when it is. Runs on a schedule in this public repo, so the
// frequent checks cost no Actions minutes; the private site repo only runs
// when something actually shipped.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const SITE = 'btsouth/btso.dev';
const SNAPSHOT = 'src/data/github.json';
const siteToken = process.env.SITE_TOKEN;
const ghToken = process.env.GITHUB_TOKEN;
const output = (k, v) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);

if (!siteToken) {
  console.log('SITE_TOKEN is not set, nothing to check.');
  process.exit(0);
}

const api = (path, token, init = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'btso-watch', ...init.headers },
  });

// 1. The releases the site currently knows about.
const snapRes = await api(`/repos/${SITE}/contents/${SNAPSHOT}`, siteToken, { headers: { Accept: 'application/vnd.github.raw+json' } });
if (!snapRes.ok) throw new Error(`Could not read the site snapshot: ${snapRes.status}`);
const snapshot = await snapRes.json();
const repos = Object.keys(snapshot.repos);

// 2. The latest published release of each repo, dated by publish time like the site.
const query = `query { ${repos.map((r, i) => {
  const [owner, name] = r.split('/');
  return `r${i}: repository(owner: "${owner}", name: "${name}") { releases(first: 10, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { tagName isDraft publishedAt createdAt } } }`;
}).join(' ')} }`;
const gqlRes = await fetch('https://api.github.com/graphql', {
  method: 'POST',
  headers: { Authorization: `Bearer ${ghToken}`, 'Content-Type': 'application/json', 'User-Agent': 'btso-watch' },
  body: JSON.stringify({ query }),
});
const gql = await gqlRes.json();
if (!gqlRes.ok || gql.errors) throw new Error(`GitHub query failed: ${JSON.stringify(gql.errors ?? gql)}`);

const missing = [];
repos.forEach((repo, i) => {
  const latest = (gql.data[`r${i}`]?.releases.nodes ?? [])
    .filter((n) => !n.isDraft)
    .sort((a, b) => (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt))[0];
  if (latest && latest.tagName !== snapshot.repos[repo].latest) missing.push(`${repo}@${latest.tagName}`);
});

if (!missing.length) {
  console.log(`Up to date: ${repos.length} repos.`);
  process.exit(0);
}

// 3. Dispatch at most once an hour for the same missing releases, so a failing
// site refresh can't turn into a loop of private-repo runs.
const signature = missing.sort().join(',');
const state = JSON.parse(readFileSync('state.json', 'utf8'));
if (state.signature === signature && Date.now() - Date.parse(state.at) < 3600e3) {
  console.log(`Already asked for a refresh at ${state.at}: ${signature}`);
  process.exit(0);
}

if (process.env.DRY_RUN) {
  console.log(`Dry run, would ask for a refresh: ${signature}`);
  process.exit(0);
}

const dispatch = await api(`/repos/${SITE}/dispatches`, siteToken, {
  method: 'POST',
  body: JSON.stringify({ event_type: 'refresh', client_payload: { missing } }),
});
if (dispatch.status !== 204) throw new Error(`Dispatch failed: ${dispatch.status} ${await dispatch.text()}`);
console.log(`Asked btso.dev to refresh for: ${signature}`);
writeFileSync('state.json', JSON.stringify({ signature, at: new Date().toISOString() }, null, 2) + '\n');
output('dispatched', missing.map((m) => m.split('/')[1]).join(', '));
