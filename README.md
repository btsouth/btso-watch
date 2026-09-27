# btso-watch

Keeps [btso.dev](https://btso.dev) current. Every few minutes it compares the latest release of
each app on the site against the site's GitHub snapshot, and when a release is missing it asks
the site repo to refresh (a `repository_dispatch`), which redeploys within a couple of minutes.

It lives in its own public repo because public repos don't use Actions minutes, so checking
often is free and the private site repo only runs when something actually shipped.

- `watch.mjs` does the check and the dispatch.
- `state.json` records the last dispatch, so the same missing release is asked for at most once
  an hour. Its history doubles as a log of refreshes.
- Needs a `SITE_TOKEN` secret: a fine-grained token with Contents read and write on
  `btsouth/southforgeai-site`.
