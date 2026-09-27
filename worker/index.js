// btso-watch on Cloudflare Workers: the same release check as watch.mjs, on a
// cron trigger that actually fires (GitHub never registered the Actions
// schedule for this repo).
//
// Every 5 minutes: if an app's latest release is missing from btso.dev's
// snapshot, ask the site repo to refresh. Every 6 hours: refresh anyway, for
// stars and the activity calendar.

const SITE = 'btsouth/btso.dev';
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
  // GitHub reports when the token expires; keep it in the run record so a
  // renewal doesn't sneak up on anyone.
  const tokenExpires = snapRes.headers.get('github-authentication-token-expiration');
  const snapshot = await snapRes.json();
  const repos = Object.keys(snapshot.repos);
  const query = `query { ${repos.map((r, i) => {
    const [owner, name] = r.split('/');
    return `r${i}: repository(owner: "${owner}", name: "${name}") { releases(first: 10, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { tagName isDraft publishedAt createdAt } } }`;
  }).join(' ')} }`;
  const res = await gh('/graphql', env, { method: 'POST', body: JSON.stringify({ query }) });
  const data = await res.json();
  if (!res.ok || !data.data) throw new Error(`GitHub query failed: ${JSON.stringify(data.errors ?? data)}`);
  // One blocked repo (say, an org token policy) shouldn't stop the others.
  const skipped = (data.errors ?? []).map((e) => repos[Number(String(e.path?.[0]).slice(1))] ?? '?');
  for (const e of data.errors ?? []) console.log(`Skipped ${repos[Number(String(e.path?.[0]).slice(1))] ?? '?'}: ${e.message}`);
  const missing = [];
  repos.forEach((repo, i) => {
    const latest = (data.data[`r${i}`]?.releases.nodes ?? [])
      .filter((n) => !n.isDraft)
      .sort((a, b) => (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt))[0];
    if (latest && latest.tagName !== snapshot.repos[repo].latest) missing.push(`${repo}@${latest.tagName}`);
  });
  return { missing: missing.sort(), repos: repos.length, skipped, tokenExpires };
}

async function check(env) {
  const { missing, repos, skipped, tokenExpires } = await missingReleases(env);
  await env.STATE.put('health', JSON.stringify({ tokenExpires, skipped, at: new Date().toISOString() }));
  const note = skipped.length ? `, skipped ${skipped.join(', ')}` : '';
  if (!missing.length) {
    console.log(`Up to date: ${repos} repos${note}.`);
    return `up to date (${repos} repos${note})`;
  }
  // Ask at most once an hour for the same missing releases, so a failing site
  // refresh can't turn into a loop of private-repo runs.
  const signature = missing.join(',');
  const last = await env.STATE.get('last', 'json');
  if (last?.signature === signature && Date.now() - Date.parse(last.at) < 3600e3) {
    console.log(`Already asked at ${last.at}: ${signature}`);
    return `already asked for ${signature}`;
  }
  await dispatch(env, { missing });
  await env.STATE.put('last', JSON.stringify({ signature, at: new Date().toISOString() }));
  console.log(`Asked btso.dev to refresh for: ${signature}`);
  return `asked for a refresh: ${signature}`;
}

export default {
  async scheduled(event, env, ctx) {
    const job = event.cron === EVERY_SIX_HOURS
      ? dispatch(env, { reason: 'schedule' }).then(() => 'scheduled refresh requested')
      : check(env);
    // The last run's time and outcome, for a quick health check:
    // wrangler kv key get --binding STATE lastRun --remote
    ctx.waitUntil(
      Promise.resolve(job)
        .then((result) => ({ ok: true, result: result ?? 'checked' }))
        .catch((e) => ({ ok: false, error: String(e).slice(0, 300) }))
        .then((outcome) => env.STATE.put('lastRun', JSON.stringify({ at: new Date().toISOString(), cron: event.cron, ...outcome }))),
    );
  },
};
