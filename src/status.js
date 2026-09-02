import { todayUTC, last45DayList } from "./utils.js";

export async function listIncidents(env, { days = 45, limit = 200 } = {}) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceStr = since.toISOString();
  const { results } = await env.DB.prepare(
    `SELECT * FROM incidents WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`
  )
    .bind(sinceStr, limit)
    .all();
  return results || [];
}

export async function listMaintenances(env, { days = 45, limit = 200 } = {}) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceStr = since.toISOString();
  const { results } = await env.DB.prepare(
    `SELECT * FROM maintenances WHERE created_at >= ? ORDER BY scheduled_start DESC LIMIT ?`
  )
    .bind(sinceStr, limit)
    .all();
  return results || [];
}

export async function getIncidentWithUpdates(env, id) {
  const incident = await env.DB.prepare("SELECT * FROM incidents WHERE id = ?").bind(id).first();
  if (!incident) return null;
  const { results } = await env.DB.prepare(
    "SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at ASC"
  )
    .bind(id)
    .all();
  incident.updates = results || [];
  incident.apps = await getIncidentApps(env, id); // [] = site-wide
  return incident;
}

export async function getMaintenanceWithUpdates(env, id) {
  const m = await env.DB.prepare("SELECT * FROM maintenances WHERE id = ?").bind(id).first();
  if (!m) return null;
  const { results } = await env.DB.prepare(
    "SELECT * FROM maintenance_updates WHERE maintenance_id = ? ORDER BY created_at ASC"
  )
    .bind(id)
    .all();
  m.updates = results || [];
  m.apps = await getMaintenanceApps(env, id); // [] = site-wide
  return m;
}

export async function findIncidentByPR(env, repo, prNumber) {
  return env.DB.prepare("SELECT * FROM incidents WHERE repo = ? AND pr_number = ?")
    .bind(repo, prNumber)
    .first();
}

export async function findMaintenanceByPR(env, repo, prNumber) {
  return env.DB.prepare("SELECT * FROM maintenances WHERE repo = ? AND pr_number = ?")
    .bind(repo, prNumber)
    .first();
}

export async function createIncident(env, data) {
  const { title, impact = "minor", body = "", componentId = null, appIds = [], source = "admin", repo = null, prNumber = null, prUrl = null } = data;
  const res = await env.DB.prepare(
    `INSERT INTO incidents (title, status, impact, component_id, body, source, repo, pr_number, pr_url)
     VALUES (?, 'investigating', ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(title, impact, componentId, body, source, repo, prNumber, prUrl)
    .run();
  const id = res.meta.last_row_id;
  await attachIncidentApps(env, id, appIds);
  await addIncidentUpdate(env, id, { status: "investigating", message: body || "Incident opened.", source, author: data.author });
  await touchDailyStatus(env, "outage_or_degraded", impact);
  return id;
}

export async function attachIncidentApps(env, incidentId, appIds = []) {
  for (const appId of appIds) {
    await env.DB.prepare("INSERT OR IGNORE INTO incident_apps (incident_id, app_id) VALUES (?, ?)")
      .bind(incidentId, appId)
      .run();
  }
}

export async function getIncidentApps(env, incidentId) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.name FROM apps a JOIN incident_apps ia ON ia.app_id = a.id WHERE ia.incident_id = ?`
  )
    .bind(incidentId)
    .all();
  return results || [];
}

export async function addIncidentUpdate(env, incidentId, { status, message, author = null, source = "admin" }) {
  await env.DB.prepare(
    `INSERT INTO incident_updates (incident_id, status, message, author, source) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(incidentId, status, message, author, source)
    .run();
  await env.DB.prepare(`UPDATE incidents SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(status, incidentId)
    .run();
  if (status === "resolved") {
    await env.DB.prepare(`UPDATE incidents SET resolved_at = datetime('now') WHERE id = ?`).bind(incidentId).run();
  }
}

export async function resolveIncident(env, incidentId, message = "Resolved.", author = null, source = "admin") {
  await addIncidentUpdate(env, incidentId, { status: "resolved", message, author, source });
}

export async function createMaintenance(env, data) {
  const {
    title,
    body = "",
    componentId = null,
    appIds = [],
    source = "admin",
    repo = null,
    prNumber = null,
    prUrl = null,
    scheduledStart = new Date().toISOString(),
    scheduledEnd = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  } = data;
  const res = await env.DB.prepare(
    `INSERT INTO maintenances (title, status, component_id, body, scheduled_start, scheduled_end, source, repo, pr_number, pr_url)
     VALUES (?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(title, componentId, body, scheduledStart, scheduledEnd, source, repo, prNumber, prUrl)
    .run();
  const id = res.meta.last_row_id;
  await attachMaintenanceApps(env, id, appIds);
  await addMaintenanceUpdate(env, id, { status: "scheduled", message: body || "Maintenance scheduled.", source, author: data.author });
  return id;
}

export async function attachMaintenanceApps(env, maintenanceId, appIds = []) {
  for (const appId of appIds) {
    await env.DB.prepare("INSERT OR IGNORE INTO maintenance_apps (maintenance_id, app_id) VALUES (?, ?)")
      .bind(maintenanceId, appId)
      .run();
  }
}

export async function getMaintenanceApps(env, maintenanceId) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.name FROM apps a JOIN maintenance_apps ma ON ma.app_id = a.id WHERE ma.maintenance_id = ?`
  )
    .bind(maintenanceId)
    .all();
  return results || [];
}

export async function addMaintenanceUpdate(env, maintenanceId, { status, message, author = null, source = "admin" }) {
  await env.DB.prepare(
    `INSERT INTO maintenance_updates (maintenance_id, status, message, author, source) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(maintenanceId, status, message, author, source)
    .run();
  await env.DB.prepare(`UPDATE maintenances SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(status, maintenanceId)
    .run();
  if (status === "completed" || status === "cancelled") {
    await env.DB.prepare(`UPDATE maintenances SET completed_at = datetime('now') WHERE id = ?`)
      .bind(maintenanceId)
      .run();
  }
}

export async function completeMaintenance(env, id, message = "Maintenance complete.", author = null, source = "admin") {
  await addMaintenanceUpdate(env, id, { status: "completed", message, author, source });
}

// --- Uptime bar (45 days) ----------------------------------------------

export async function touchDailyStatus(env, kind, impact) {
  const date = todayUTC();
  const existing = await env.DB.prepare("SELECT * FROM daily_status WHERE date = ?").bind(date).first();
  let status = "operational";
  if (kind === "maintenance") status = "maintenance";
  if (kind === "outage_or_degraded") status = impact === "critical" || impact === "major" ? "outage" : "degraded";

  if (!existing) {
    await env.DB.prepare(
      "INSERT INTO daily_status (date, status, incident_count, worst_impact) VALUES (?, ?, 1, ?)"
    )
      .bind(date, status, impact || null)
      .run();
    return;
  }

  const rank = { operational: 0, maintenance: 1, degraded: 2, outage: 3 };
  const worse = rank[status] > rank[existing.status] ? status : existing.status;
  await env.DB.prepare(
    "UPDATE daily_status SET status = ?, incident_count = incident_count + 1, worst_impact = ? WHERE date = ?"
  )
    .bind(worse, impact || existing.worst_impact, date)
    .run();
}

export async function getUptime45(env) {
  const days = last45DayList();
  const { results } = await env.DB.prepare(
    "SELECT * FROM daily_status WHERE date >= ? ORDER BY date ASC"
  )
    .bind(days[0])
    .all();
  const byDate = Object.fromEntries((results || []).map((r) => [r.date, r]));
  const series = days.map((d) => byDate[d] || { date: d, status: "operational", incident_count: 0 });
  const upDays = series.filter((d) => d.status === "operational" || d.status === "maintenance").length;
  const uptimePct = ((upDays / series.length) * 100).toFixed(2);
  return { days: series, uptimePct };
}

// Called by the daily cron just after UTC midnight: makes sure "yesterday"
// has a row even if nothing happened (defaults to operational).
export async function rollupYesterday(env) {
  const y = todayUTC(-1);
  const existing = await env.DB.prepare("SELECT date FROM daily_status WHERE date = ?").bind(y).first();
  if (!existing) {
    await env.DB.prepare("INSERT INTO daily_status (date, status, incident_count) VALUES (?, 'operational', 0)")
      .bind(y)
      .run();
  }
}

export async function currentOverallStatus(env) {
  const openIncidents = await env.DB.prepare(
    "SELECT * FROM incidents WHERE status != 'resolved' ORDER BY created_at DESC"
  ).all();
  const activeMaintenances = await env.DB.prepare(
    "SELECT * FROM maintenances WHERE status IN ('scheduled','in_progress') ORDER BY scheduled_start ASC"
  ).all();

  const incidents = openIncidents.results || [];
  const maintenances = activeMaintenances.results || [];

  let overall = "operational";
  if (incidents.some((i) => i.impact === "critical")) overall = "major_outage";
  else if (incidents.some((i) => i.impact === "major")) overall = "partial_outage";
  else if (incidents.length > 0) overall = "degraded_performance";
  else if (maintenances.some((m) => m.status === "in_progress")) overall = "maintenance";

  return { overall, incidents, maintenances };
}
