# Stellar Global Supplies — Status Page

A self-hosted status page built entirely on the **Cloudflare free tier**:
one Worker (Hono) serving both the static frontend and the API, **D1** for
storage. Auth is SSO through your existing Casdoor-backed portal.

## Features

- **Public status page** (`/`) with three tabs:
  - **Incidents** — timeline of open/past incidents with per-update history
  - **Maintenance** — scheduled/active/completed maintenance windows
  - **Apps & Uptime** — one card per monitored URL, each with its own live
    status badge and 45-day bar
- **Live app monitoring** — a set of URLs mapped to app names (managed in
  the admin panel). Whenever anyone loads the status page, each app whose
  last check is older than `CHECK_INTERVAL_SECONDS` gets re-checked with a
  real HTTP request; the result updates that app's "today" cell.
  Day-by-day bar color, worst-first:
  - 🔴 **Outage** — the live check failed (non-2xx/3xx or timeout)
  - 🟠 **Incident** — an open incident overlaps that day (site-wide or
    scoped to that app)
  - 🔵 **Maintenance** — a scheduled/active maintenance window overlaps
    that day
  - 🟢 **Operational** — none of the above
- **Email subscriptions** — visitors can subscribe with just an email
  address; every incident/maintenance create or update sends them a
  notification via the **Gmail API** (OAuth refresh-token flow), with a
  one-click unsubscribe link. Every send fans out via
  `c.executionCtx.waitUntil(...)` so it never blocks the API response.
- **Admin panel** (`/admin.html`) — create/update incidents & maintenance,
  manage the monitored apps list, and configure Gmail OAuth credentials.
  Protected by **SSO through your existing portal** (Casdoor → Supabase
  session) — no separate password to manage.
- **GitHub webhook** (`POST /api/webhook/github`):
  - PR opened/labeled `incident` → opens an incident
  - PR opened/labeled `maintenance` → schedules maintenance
  - Any comment on that PR → appended as a timeline update (status is
    inferred from keywords like "identified", "monitoring", "resolved")
  - PR merged or closed → resolves the incident / completes the maintenance
  - Works at the **org level** — any repo's PRs can trigger this, as long
    as that repo has `incident`/`maintenance` labels created on it

## Project layout

```
wrangler.toml                    Worker + D1 + Secrets Store config
migrations/0001_init.sql         Core schema: incidents, maintenances, components
migrations/0002_apps.sql         Monitored apps + per-app daily status
migrations/0003_subscriptions.sql Email subscribers + Gmail settings (D1)
migrations/0004_app_scoping.sql  App slugs + incident/maintenance-to-app join tables
src/index.js                     Hono app: all routes + email notification wiring
src/status.js                    Incidents/maintenance data access
src/apps.js                      App CRUD, live health-check, per-app uptime series
src/gmail.js                     Gmail OAuth token refresh + send, subscriber fan-out
src/subscribers.js                Subscribe/unsubscribe + Gmail settings storage
src/github.js                    Webhook signature check + event handling
src/auth.js                      Supabase JWT verification (HS256 or JWKS, auto-detected)
src/utils.js                     Small shared helpers
public/index.html, app.js        Public status page (Incidents / Maintenance / Apps tabs)
public/admin.html, admin.js      Admin panel (SSO-protected)
public/sso-callback.html/js      SSO token exchange, mirrors the billing app's SSOCallback.jsx
public/config.js                 Supabase URL/anon key + portal LANDING_URL (fill these in)
public/lib/supabase-client.js    Shared Supabase client for the static frontend
public/style.css                 Shared styling (teal theme inspired by stellarglobalsupplies.com)
```

## 1. Install & create resources

```bash
npm install

# D1 database
wrangler d1 create stellar-status-db
# -> copy the returned database_id into wrangler.toml

# Run all three migrations (local dev)
npm run db:migrate
# ...and again against the real remote DB before/after first deploy
npm run db:migrate:remote
```

## 2. Secrets Store & config

This project uses [Cloudflare Secrets Store](https://developers.cloudflare.com/secrets-store/) bindings (account-level, async `await env.NAME.get()`) rather than the older per-Worker `wrangler secret put`.

```bash
# One-time: create a store (or reuse one you already have)
wrangler secrets-store store create stellar-secrets --remote

# Add the two secrets this Worker needs
wrangler secrets-store secret create stellar-secrets --remote \
  --name github-webhook-secret --scopes workers
wrangler secrets-store secret create stellar-secrets --remote \
  --name supabase-jwt-secret --scopes workers
```

Then put the `store_id` printed by `store create` into both
`[[secrets_store_secrets]]` blocks in `wrangler.toml`.

- `github-webhook-secret` — the shared secret you configure on the GitHub webhook
- `supabase-jwt-secret` — only used if your Supabase project signs JWTs with
  the legacy shared HS256 secret; `src/auth.js` auto-detects this from each
  token's header and falls back to fetching Supabase's JWKS for RS256/ES256
  projects, so this can be a placeholder if you're on the newer asymmetric
  signing keys.

Edit `public/config.js` with your real Supabase project values and portal URL:

```js
window.__ENV__ = {
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_SUPABASE_ANON_KEY",
  LANDING_URL: "https://apps.stellarglobalsupplies.com",
};
```

Also set these plain (non-secret) vars in `wrangler.toml`:

- `SUPABASE_URL` — same project URL, used server-side for JWKS verification
- `PUBLIC_BASE_URL` — your deployed status page URL, used to build
  unsubscribe links in notification emails
- `CHECK_INTERVAL_SECONDS` — minimum seconds between live health-checks of
  any one app (default `120`)

### How admin auth works

The admin panel doesn't have its own login form. It reuses the same SSO
flow as the billing/orders frontend:

1. Visiting `/admin.html` without a session redirects to
   `${LANDING_URL}/login?callback=<url to /sso-callback.html>` — the same
   Casdoor-backed portal login your other apps use.
2. The portal sends the browser back to `/sso-callback.html?token=&ts=`,
   which exchanges that token for a real Supabase session via your
   `sso-exchange` Edge Function, then calls `supabase.auth.setSession(...)`.
3. From then on, every `/api/admin/*` call sends
   `Authorization: Bearer <supabase access_token>`, and the Worker verifies
   that JWT.

Anyone who can successfully complete that SSO flow is trusted as an admin
here — access control lives in Casdoor (who's allowed to have a portal
account), not in this app.

## 3. Set up Gmail sending (for subscriber notifications)

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or
   reuse) a project → **APIs & Services → Credentials → Create OAuth client
   ID** → type **Desktop app** (simplest for generating a refresh token
   manually).
2. Enable the **Gmail API** for that project.
3. Use the OAuth playground ([developers.google.com/oauthplayground](https://developers.google.com/oauthplayground))
   or a small local script to authorize the `https://www.googleapis.com/auth/gmail.send`
   scope **as the mailbox you want to send from**, and exchange for a
   refresh token.
4. In the admin panel's **Email Notifications (Gmail)** card, enter the
   Client ID, Client Secret, Refresh Token, and the sender email address.
   These are saved to the `settings` table in D1 (per requirement — not the
   Secrets Store) via `POST /api/admin/settings/gmail`.

From then on, every incident/maintenance create or update — whether from
the admin panel or the GitHub webhook — emails every subscriber, with an
unsubscribe link built from `PUBLIC_BASE_URL`.

**Note on storing OAuth credentials in D1:** this is less defensively
secured than the Secrets Store (D1 data is readable by anyone with D1
console access, whereas Secrets Store values are write-only after
creation). That's a deliberate tradeoff per the requirement to manage these
from the admin UI at runtime rather than via `wrangler` CLI deploys. If you
want tighter security later, swap `src/gmail.js`'s D1 read for a Secrets
Store binding and drop the admin-panel save flow in favor of
`wrangler secrets-store secret create`.

## 4. Onboard apps to monitor

In the admin panel's **Monitored Apps** card, add a name + URL for each app
(e.g. "Orders Frontend" → `https://orders.stellarglobalsupplies.com`). Each
app is automatically given a **slug** (e.g. `orders-frontend`) derived from
its name. It'll appear on the public status page's **Apps & Uptime** tab
immediately, starting in an "unknown" state until its first check fires (on
the next status-page view). Pause/Delete are available per-app in the same
panel.

### Scoping incidents/maintenance to specific apps

By default, every incident/maintenance is **site-wide** — it shows on
every app's uptime bar (orange for incidents, blue for maintenance). To
scope one to just certain apps instead:

- **From the admin panel**: uncheck "Site-wide" in the "Affected apps"
  picker on the incident/maintenance form and tick the specific app(s).
- **From GitHub**: add a label like `app:orders-frontend` to the PR (the
  slug after `app:` must match an app's slug exactly). Multiple `app:`
  labels scope it to multiple apps. No `app:` label → site-wide, same as
  before.

An incident/maintenance's affected apps are shown as chips on its card on
the public status page.

## 5. Run locally / deploy

```bash
npm run dev       # http://127.0.0.1:8787
npm run deploy    # publishes the Worker + static assets
```

The Worker serves `/public/*` as static assets and handles everything under
`/api/*` — no separate Pages project is required. Put it behind a custom
domain (e.g. `status.stellarglobalsupplies.com`) via **Workers → Settings →
Domains & Routes → Add → Custom Domain** in the Cloudflare dashboard.

## 6. Wire up the GitHub webhook

Can be added at the **repo** level (just that repo triggers it) or the
**org** level (any repo's PRs can trigger it — the handler doesn't filter
by repo). Either way: **Settings → Webhooks → Add webhook**

- Payload URL: `https://status.stellarglobalsupplies.com/api/webhook/github`
- Content type: `application/json`
- Secret: same value as `github-webhook-secret`
- Events: select **Pull requests** and **Issue comments**

Create `incident` and `maintenance` labels on each repo that should be able
to trigger this (GitHub labels aren't shared org-wide by default). Add an
`app:<slug>` label too (e.g. `app:orders-frontend`) if the PR should scope
to a specific app instead of site-wide — see "Scoping incidents/maintenance
to specific apps" above.

1. Open a PR and add the `incident` (or `maintenance`) label → the status
   page shows it immediately, and subscribers get an email.
2. Comment on the PR — comments become timeline updates and another email.
   Include words like "identified", "monitoring", or "resolved" to move
   the incident's status automatically.
3. Merge or close the PR → the incident is resolved / maintenance is marked
   completed (or cancelled, if closed without merging) — another email.

## Notes / next steps

- `components` table (from migration 0001) still exists for finer-grained
  scoping if you want it later; `apps` (migration 0002) is the newer,
  simpler mechanism actually driving the public "Apps & Uptime" tab.
- Swap the teal (`#00B98E`) theme in `public/style.css` for your exact
  brand tokens if they drift from the main site.
- If your `sso-exchange` Edge Function restricts allowed callback origins,
  add `https://status.stellarglobalsupplies.com` to that list.
