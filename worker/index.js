// btso-watch on Cloudflare Workers: the same release check as watch.mjs, on a
// cron trigger that actually fires (GitHub never registered the Actions
// schedule for this repo).
//
// Every 5 minutes: if an app's latest release is missing from btso.dev's
// snapshot, ask the site repo to refresh. Every 6 hours: refresh anyway, for
// stars and the activity calendar.

const SITE = 'btsouth/southforgeai-site';
const SNAPSHOT = 'src/data/github.json';
const EVERY_SIX_HOURS = '17 */6 * * *';

const gh = (path, env, init = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.SITE_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'btso-watch',
      ...init.headers,
    },
  });

async function dispatch(env, payload) {
  const res = await gh(`/repos/${SITE}/dispatches`, env, {
    method: 'POST',
    body: JSON.stringify({ event_type: 'refresh', client_payload: payload }),
  });
  if (res.status !== 204) throw new Error(`Dispatch failed: ${res.status} ${await res.text()}`);
}

async function missingReleases(env) {
  const snapRes = await gh(`/repos/${SITE}/contents/${SNAPSHOT}`, env, { headers: { Accept: 'application/vnd.github.raw+json' } });
  if (!snapRes.ok) throw new Error(`Could not read the site snapshot: ${snapRes.status}`);
  const snapshot = await snapRes.json();
  const repos = Object.keys(snapshot.repos);
  const query = `query { ${repos.map((r, i) => {
    const [owner, name] = r.split('/');
    return `r${i}: repository(owner: "${owner}", name: "${name}") { releases(first: 10, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { tagName isDraft publishedAt createdAt } } }`;
  }).join(' ')} }`;
  const res = await gh('/graphql', env, { method: 'POST', body: JSON.stringify({ query }) });
  const data = await res.json();
  if (!res.ok || data.errors) throw new Error(`GitHub query failed: ${JSON.stringify(data.errors ?? data)}`);
  const missing = [];
  repos.forEach((repo, i) => {
    const latest = (data.data[`r${i}`]?.releases.nodes ?? [])
      .filter((n) => !n.isDraft)
      .sort((a, b) => (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt))[0];
    if (latest && latest.tagName !== snapshot.repos[repo].latest) missing.push(`${repo}@${latest.tagName}`);
  });
  return { missing: missing.sort(), repos: repos.length };
}

async function check(env) {
  const { missing, repos } = await missingReleases(env);
  if (!missing.length) {
    console.log(`Up to date: ${repos} repos.`);
    return;
  }
  // Ask at most once an hour for the same missing releases, so a failing site
  // refresh can't turn into a loop of private-repo runs.
  const signature = missing.join(',');
  const last = await env.STATE.get('last', 'json');
  if (last?.signature === signature && Date.now() - Date.parse(last.at) < 3600e3) {
    console.log(`Already asked at ${last.at}: ${signature}`);
    return;
  }
  await dispatch(env, { missing });
  await env.STATE.put('last', JSON.stringify({ signature, at: new Date().toISOString() }));
  console.log(`Asked btso.dev to refresh for: ${signature}`);
}

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === EVERY_SIX_HOURS) {
      ctx.waitUntil(dispatch(env, { reason: 'schedule' }).then(() => console.log('Scheduled refresh requested.')));
      return;
    }
    ctx.waitUntil(check(env));
  },
};
