# Stellar Global Supplies — Status Page

A self-hosted status page (à la Cloudflare Status) built entirely on the
**Cloudflare free tier**: one Worker (Hono) serving both the static
frontend and the API, **D1** for storage, and **KV** for admin sessions.

## Features

- **Public status page** (`/`) with three tabs:
  - **Incidents** — timeline of open/past incidents with per-update history
  - **Maintenance** — scheduled/active/completed maintenance windows
  - **Uptime** — 45-day heatmap + uptime %
- **Admin panel** (`/admin.html`) to create incidents/maintenance and post
  updates, protected by **SSO through your existing portal** (Casdoor →
  Supabase session) — no separate password to manage.
- **GitHub webhook** (`POST /api/webhook/github`):
  - PR opened/labeled `incident` → opens an incident
  - PR opened/labeled `maintenance` → schedules maintenance
  - Any comment on that PR → appended as a timeline update (status is
    inferred from keywords like "identified", "monitoring", "resolved")
  - PR merged or closed → resolves the incident / completes the maintenance

## Project layout

```
wrangler.toml          Worker + D1 + KV + cron config
migrations/0001_init.sql   D1 schema
src/index.js            Hono app: routes for public API, admin API, webhook
src/status.js            D1 data-access helpers
src/github.js            Webhook signature check + event handling
src/auth.js               Login / session (KV-backed) helpers
src/utils.js               Small shared helpers
public/index.html, app.js  Public status page
public/admin.html, admin.js Admin panel (SSO-protected)
public/sso-callback.html/js SSO token exchange, mirrors the billing app's SSOCallback.jsx
public/config.js           Supabase URL/anon key + portal LANDING_URL (fill these in)
public/lib/supabase-client.js  Shared Supabase client for the static frontend
public/style.css           Shared styling (teal theme inspired by stellarglobalsupplies.com)
```

## 1. Install & create resources

```bash
npm install

# D1 database
wrangler d1 create stellar-status-db
# -> copy the returned database_id into wrangler.toml

# Run the schema (local dev)
npm run db:migrate
# ...and again against the real remote DB before/after first deploy
npm run db:migrate:remote
```

## 2. Secrets & config

```bash
wrangler secret put GITHUB_WEBHOOK_SECRET # shared secret for the GitHub webhook
wrangler secret put SUPABASE_JWT_SECRET   # Project Settings -> API -> JWT Settings -> JWT Secret
                                           # (same Supabase project the billing/orders app uses)
```

Edit `public/config.js` with your real Supabase project values and portal URL:

```js
window.__ENV__ = {
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_SUPABASE_ANON_KEY",
  LANDING_URL: "https://apps.stellarglobalsupplies.com",
};
```

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
   that JWT against `SUPABASE_JWT_SECRET`.

Anyone who can successfully complete that SSO flow is trusted as an admin
here — there's no separate allowlist, so access control lives in Casdoor
(who's allowed to have a portal account), not in this app. If the portal
is ever opened up to non-staff accounts, add an allowlist check back into
`src/auth.js`'s `requireAuth()`.

If your `sso-exchange` Edge Function restricts which callback origins it
accepts, add `https://status.stellarglobalsupplies.com` to that list.

## 3. Run locally / deploy

```bash
npm run dev       # http://127.0.0.1:8787
npm run deploy    # publishes the Worker + static assets
```

The Worker serves `/public/*` as static assets and handles everything under
`/api/*` — no separate Pages project is required, though you can still put
this Worker behind Cloudflare Pages/Workers routes on your own domain
(e.g. `status.stellarglobalsupplies.com`) via a custom domain binding.

## 4. Wire up the GitHub webhook

In your repo: **Settings → Webhooks → Add webhook**

- Payload URL: `https://<your-worker-domain>/api/webhook/github`
- Content type: `application/json`
- Secret: same value as `GITHUB_WEBHOOK_SECRET`
- Events: select **Pull requests** and **Issue comments**

Create two labels in the repo: `incident` and `maintenance`. Then:

1. Open a PR and add the `incident` (or `maintenance`) label → the status
   page shows it immediately.
2. Comment on the PR — comments become timeline updates. Include words like
   "identified", "monitoring", or "resolved" to move the incident's status
   automatically (defaults to "investigating" otherwise).
3. Merge or close the PR → the incident is resolved / maintenance is marked
   completed (or cancelled, if closed without merging).

## Notes / next steps

- `components` table exists so incidents/maintenance can later be scoped to
  specific parts of the site (Website, Quote Forms, Product Catalogue);
  the admin UI currently creates incidents against the whole site — pass
  `componentId` from the API if you want per-component granularity in the UI.
- Swap the teal (`#00B98E`) theme in `public/style.css` for your exact
  brand tokens if they drift from the main site.
- For production, put the Worker behind a custom domain (e.g.
  `status.stellarglobalsupplies.com`) via **Workers → Triggers → Custom
  Domains** in the Cloudflare dashboard.
