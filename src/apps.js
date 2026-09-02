import { last45DayList, todayUTC } from "./utils.js";

const DEFAULT_CHECK_INTERVAL_SECONDS = 120;
const CHECK_TIMEOUT_MS = 8000;

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function listApps(env, { onlyActive = false } = {}) {
  const query = onlyActive
    ? "SELECT * FROM apps WHERE active = 1 ORDER BY sort_order ASC, id ASC"
    : "SELECT * FROM apps ORDER BY sort_order ASC, id ASC";
  const { results } = await env.DB.prepare(query).all();
  return results || [];
}

export async function createApp(env, { name, url, sortOrder = 0 }) {
  const baseSlug = slugify(name) || "app";
  let slug = baseSlug;
  let n = 2;
  // Handle rare slug collisions (two apps with very similar names).
  while (await env.DB.prepare("SELECT 1 FROM apps WHERE slug = ?").bind(slug).first()) {
    slug = `${baseSlug}-${n++}`;
  }
  const res = await env.DB.prepare(
    "INSERT INTO apps (name, url, sort_order, slug) VALUES (?, ?, ?, ?)"
  )
    .bind(name, url, sortOrder, slug)
    .run();
  return res.meta.last_row_id;
}

// Resolves PR labels like "app:orders-frontend" to app IDs, for the
// GitHub webhook. Unknown slugs are silently skipped (not an error) so a
// typo'd label just doesn't scope the incident rather than failing it.
export async function findAppIdsBySlugs(env, slugs) {
  if (!slugs.length) return [];
  const placeholders = slugs.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id FROM apps WHERE slug IN (${placeholders})`
  )
    .bind(...slugs)
    .all();
  return (results || []).map((r) => r.id);
}

export async function updateApp(env, id, { name, url, active, sortOrder }) {
  const app = await env.DB.prepare("SELECT * FROM apps WHERE id = ?").bind(id).first();
  if (!app) return null;
  await env.DB.prepare(
    "UPDATE apps SET name = ?, url = ?, active = ?, sort_order = ? WHERE id = ?"
  )
    .bind(
      name ?? app.name,
      url ?? app.url,
      active === undefined ? app.active : active ? 1 : 0,
      sortOrder ?? app.sort_order,
      id
    )
    .run();
  return true;
}

export async function deleteApp(env, id) {
  await env.DB.prepare("DELETE FROM apps WHERE id = ?").bind(id).run();
}

// --- Live health checks --------------------------------------------------

function checkIntervalSeconds(env) {
  const n = Number(env.CHECK_INTERVAL_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CHECK_INTERVAL_SECONDS;
}

function isDue(app, env) {
  if (!app.last_checked_at) return true;
  const last = new Date(app.last_checked_at.includes("Z") ? app.last_checked_at : app.last_checked_at + "Z");
  return Date.now() - last.getTime() > checkIntervalSeconds(env) * 1000;
}

async function checkOneApp(env, app) {
  const started = Date.now();
  let status = "outage";
  let httpStatus = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    const res = await fetch(app.url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "StellarStatusPage-HealthCheck/1.0" },
    });
    clearTimeout(timer);
    httpStatus = res.status;
    status = res.status >= 200 && res.status < 400 ? "operational" : "outage";
  } catch {
    status = "outage";
  }

  const latency = Date.now() - started;
  const nowIso = new Date().toISOString();
  const today = todayUTC();

  await env.DB.prepare(
    `UPDATE apps SET last_status = ?, last_checked_at = ?, last_http_status = ?, last_latency_ms = ? WHERE id = ?`
  )
    .bind(status, nowIso, httpStatus, latency, app.id)
    .run();

  await env.DB.prepare(
    `INSERT INTO app_daily_status (app_id, date, status, checked_count, last_http_status)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(app_id, date) DO UPDATE SET
       status = excluded.status,
       checked_count = app_daily_status.checked_count + 1,
       last_http_status = excluded.last_http_status`
  )
    .bind(app.id, today, status, httpStatus)
    .run();

  return { ...app, last_status: status, last_checked_at: nowIso, last_http_status: httpStatus, last_latency_ms: latency };
}

// Called on every status-page view. Only actually re-checks apps whose last
// check is older than CHECK_INTERVAL_SECONDS, so a burst of page loads
// doesn't hammer the target URLs.
export async function getAppsWithLiveStatus(env) {
  const apps = await listApps(env, { onlyActive: true });
  const due = apps.filter((a) => isDue(a, env));
  const fresh = apps.filter((a) => !isDue(a, env));

  const checked = await Promise.all(due.map((a) => checkOneApp(env, a).catch(() => a)));
  const all = [...fresh, ...checked].sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
  return all;
}

// --- Per-app 45-day uptime, overlaid with incidents/maintenance ----------

const RANK = { operational: 0, maintenance: 1, degraded: 2, outage: 3 };

function overlapsDay(startIso, endIsoOrNull, day) {
  const start = (startIso || "").slice(0, 10);
  const end = endIsoOrNull ? endIsoOrNull.slice(0, 10) : todayUTC();
  return start <= day && day <= end;
}

export async function getAppUptime45(env, appId) {
  const days = last45DayList();
  const windowStart = days[0];

  const [{ results: statusRows }, { results: incidentRows }, { results: maintRows }] = await Promise.all([
    env.DB.prepare("SELECT * FROM app_daily_status WHERE app_id = ? AND date >= ?").bind(appId, windowStart).all(),
    env.DB.prepare(
      `SELECT i.* FROM incidents i
       WHERE (i.resolved_at IS NULL OR i.resolved_at >= ?) AND i.created_at <= ?
       AND (
         NOT EXISTS (SELECT 1 FROM incident_apps ia WHERE ia.incident_id = i.id)
         OR EXISTS (SELECT 1 FROM incident_apps ia WHERE ia.incident_id = i.id AND ia.app_id = ?)
       )`
    )
      .bind(windowStart, new Date().toISOString(), appId)
      .all(),
    env.DB.prepare(
      `SELECT m.* FROM maintenances m
       WHERE m.scheduled_end >= ? AND m.scheduled_start <= ?
       AND (
         NOT EXISTS (SELECT 1 FROM maintenance_apps ma WHERE ma.maintenance_id = m.id)
         OR EXISTS (SELECT 1 FROM maintenance_apps ma WHERE ma.maintenance_id = m.id AND ma.app_id = ?)
       )`
    )
      .bind(windowStart, new Date().toISOString(), appId)
      .all(),
  ]);

  const byDate = Object.fromEntries((statusRows || []).map((r) => [r.date, r.status]));

  const series = days.map((day) => {
    let status = byDate[day] || "operational";

    const incidentToday = (incidentRows || []).find((i) => overlapsDay(i.created_at, i.resolved_at, day));
    const maintToday = (maintRows || []).find((m) => overlapsDay(m.scheduled_start, m.scheduled_end, day));

    // Precedence: a live-checked outage always wins; otherwise incident
    // (orange) beats maintenance (blue) beats plain operational.
    if (status !== "outage") {
      if (incidentToday) status = "degraded"; // rendered orange in the UI
      else if (maintToday) status = "maintenance";
    }

    return { date: day, status };
  });

  const upDays = series.filter((d) => d.status === "operational" || d.status === "maintenance").length;
  const uptimePct = ((upDays / series.length) * 100).toFixed(2);
  return { days: series, uptimePct };
}
