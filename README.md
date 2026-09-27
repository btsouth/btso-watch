# btso-watch

Keeps [btso.dev](https://btso.dev) current. Every 5 minutes it compares the latest release of
each app on the site against the site's GitHub snapshot, and when a release is missing it asks
the site repo to refresh (a `repository_dispatch`), which redeploys within a couple of minutes.
Every 6 hours it also asks for a refresh regardless, to keep stars and the activity calendar fresh.

The check runs as a Cloudflare Worker on a cron trigger (`worker/`), which costs nothing and uses
no GitHub Actions minutes. It started out as a scheduled GitHub Actions workflow, but GitHub never
registered that schedule, so the workflow is now a manual backup that runs the same check.

- `worker/` is the Worker: `index.js` plus `wrangler.jsonc` with the two cron triggers. It keeps
  the last dispatch in a KV namespace so the same missing release is asked for at most once an
  hour. Deploy with `cd worker && wrangler deploy`.
- `watch.mjs` and `.github/workflows/releases.yml` run the same check from GitHub by hand.
- Both need a `SITE_TOKEN`: a fine-grained token with Contents read and write on
  `btsouth/southforgeai-site`. On Cloudflare it's a Worker secret (`wrangler secret put SITE_TOKEN`),
  on GitHub a repository secret.
