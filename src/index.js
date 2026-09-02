import { Hono } from "hono";
import { json, badRequest } from "./utils.js";
import { requireAuth } from "./auth.js";
import { verifySignature, handleGithubEvent } from "./github.js";
import {
  listIncidents,
  listMaintenances,
  getIncidentWithUpdates,
  getMaintenanceWithUpdates,
  createIncident,
  createMaintenance,
  addIncidentUpdate,
  addMaintenanceUpdate,
  resolveIncident,
  completeMaintenance,
  getUptime45,
  currentOverallStatus,
} from "./status.js";
import {
  listApps,
  createApp,
  updateApp,
  deleteApp,
  getAppsWithLiveStatus,
  getAppUptime45,
} from "./apps.js";
import { subscribe, unsubscribe, countSubscribers, saveGmailSettings, getGmailSettingsStatus } from "./subscribers.js";
import { notifySubscribers } from "./gmail.js";

const app = new Hono();

// ---------------------------------------------------------------------
// Public, read-only API — powers the status page tabs.
// ---------------------------------------------------------------------

app.get("/api/status", async (c) => {
  const overall = await currentOverallStatus(c.env);
  return json({ name: c.env.STATUS_PAGE_NAME || "Status", ...overall });
});

app.get("/api/incidents", async (c) => {
  const days = Number(c.req.query("days") || 45);
  const incidents = await listIncidents(c.env, { days });
  return json({ incidents });
});

app.get("/api/incidents/:id", async (c) => {
  const incident = await getIncidentWithUpdates(c.env, c.req.param("id"));
  if (!incident) return json({ error: "not found" }, { status: 404 });
  return json({ incident });
});

app.get("/api/maintenances", async (c) => {
  const days = Number(c.req.query("days") || 45);
  const maintenances = await listMaintenances(c.env, { days });
  return json({ maintenances });
});

app.get("/api/maintenances/:id", async (c) => {
  const m = await getMaintenanceWithUpdates(c.env, c.req.param("id"));
  if (!m) return json({ error: "not found" }, { status: 404 });
  return json({ maintenance: m });
});

app.get("/api/uptime", async (c) => {
  const uptime = await getUptime45(c.env);
  return json(uptime);
});

// ---------------------------------------------------------------------
// Apps: the set of monitored URLs, live-checked (throttled) on view, each
// with its own 45-day bar (green/blue/orange/red — see apps.js).
// ---------------------------------------------------------------------

app.get("/api/apps", async (c) => {
  const apps = await getAppsWithLiveStatus(c.env);
  return json({ apps });
});

app.get("/api/apps/:id/uptime", async (c) => {
  const uptime = await getAppUptime45(c.env, c.req.param("id"));
  return json(uptime);
});

// ---------------------------------------------------------------------
// Public subscription — email notifications via Gmail, sent whenever an
// incident/maintenance is created or updated.
// ---------------------------------------------------------------------

app.post("/api/subscribe", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = (body.email || "").trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest("valid email required");
  await subscribe(c.env, email);
  return json({ ok: true });
});

app.get("/api/unsubscribe", async (c) => {
  const token = c.req.query("token");
  if (!token) return badRequest("token required");
  const removed = await unsubscribe(c.env, token);
  return new Response(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2>${removed ? "You've been unsubscribed" : "Link not found"}</h2>
      <p>${removed ? "You won't receive further status updates." : "This unsubscribe link is invalid or already used."}</p>
    </body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
});

// ---------------------------------------------------------------------
// GitHub webhook — PR label "incident" / "maintenance" drives everything.
// ---------------------------------------------------------------------

app.post("/api/webhook/github", async (c) => {
  const rawBody = await c.req.text();
  const webhookSecret = c.env.GITHUB_WEBHOOK_SECRET ? await c.env.GITHUB_WEBHOOK_SECRET.get() : null;
  const ok = await verifySignature(c.req.raw, rawBody, webhookSecret);
  if (!ok) return json({ error: "invalid signature" }, { status: 401 });

  const eventName = c.req.header("x-github-event") || "unknown";
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return badRequest("invalid JSON payload");
  }

  const result = await handleGithubEvent(c.env, eventName, payload);

  // Notify subscribers for whatever the webhook just did.
  if (result?.created === "incident" || result?.updated === "incident" || result?.resolved === "incident") {
    const incident = await getIncidentWithUpdates(c.env, result.id);
    if (incident) c.executionCtx.waitUntil(notifyIncidentEmail(c.env, incident));
  }
  if (result?.created === "maintenance" || result?.updated === "maintenance" || result?.completed === "maintenance") {
    const maintenance = await getMaintenanceWithUpdates(c.env, result.id);
    if (maintenance) c.executionCtx.waitUntil(notifyMaintenanceEmail(c.env, maintenance));
  }

  return json({ ok: true, event: eventName, result });
});

// ---------------------------------------------------------------------
// Admin auth — SSO via the central portal (Supabase). The frontend sends
// `Authorization: Bearer <supabase access_token>` on every admin call;
// requireAuth() verifies that token.
// ---------------------------------------------------------------------

app.get("/api/admin/me", async (c) => {
  const { user, error } = await requireAuth(c.req.raw, c.env);
  if (error) return error;
  return json({ allowed: true, email: user.email });
});

// ---------------------------------------------------------------------
// Admin: incidents & maintenances (manual creation / updates)
// ---------------------------------------------------------------------

app.post("/api/admin/incidents", async (c) => {
  const { user, error } = await requireAuth(c.req.raw, c.env);
  if (error) return error;
  const body = await c.req.json().catch(() => ({}));
  if (!body.title) return badRequest("title required");
  const id = await createIncident(c.env, {
    title: body.title,
    body: body.body || "",
    impact: body.impact || "minor",
    componentId: body.componentId || null,
    appIds: Array.isArray(body.appIds) ? body.appIds : [],
    source: "admin",
    author: user.email,
  });
  const incident = await getIncidentWithUpdates(c.env, id);
  c.executionCtx.waitUntil(notifyIncidentEmail(c.env, incident));
  return json({ id }, { status: 201 });
});

app.post("/api/admin/incidents/:id/updates", async (c) => {
  const { user, error } = await requireAuth(c.req.raw, c.env);
  if (error) return error;
  const body = await c.req.json().catch(() => ({}));
  if (!body.message || !body.status) return badRequest("status and message required");
  await addIncidentUpdate(c.env, c.req.param("id"), {
    status: body.status,
    message: body.message,
    author: user.email,
    source: "admin",
  });
  const incident = await getIncidentWithUpdates(c.env, c.req.param("id"));
  c.executionCtx.waitUntil(notifyIncidentEmail(c.env, incident));
  return json({ ok: true });
});

app.post("/api/admin/incidents/:id/resolve", async (c) => {
  const { user, error } = await requireAuth(c.req.raw, c.env);
  if (error) return error;
  const body = await c.req.json().catch(() => ({}));
  await resolveIncident(c.env, c.req.param("id"), body.message || "Resolved.", user.email, "admin");
  const incident = await getIncidentWithUpdates(c.env, c.req.param("id"));
  c.executionCtx.waitUntil(notifyIncidentEmail(c.env, incident));
  return json({ ok: true });
});

app.post("/api/admin/maintenances", async (c) => {
  const { user, error } = await requireAuth(c.req.raw, c.env);
  if (error) return error;
  const body = await c.req.json().catch(() => ({}));
  if (!body.title || !body.scheduledStart || !body.scheduledEnd) {
    return badRequest("title, scheduledStart, scheduledEnd required");
  }
  const id = await createMaintenance(c.env, {
    title: body.title,
    body: body.body || "",
    componentId: body.componentId || null,
    appIds: Array.isArray(body.appIds) ? body.appIds : [],
    scheduledStart: body.scheduledStart,
    scheduledEnd: body.scheduledEnd,
    source: "admin",
    author: user.email,
  });
  const maintenance = await getMaintenanceWithUpdates(c.env, id);
  c.executionCtx.waitUntil(notifyMaintenanceEmail(c.env, maintenance));
  return json({ id }, { status: 201 });
});

app.post("/api/admin/maintenances/:id/updates", async (c) => {
  const { user, error } = await requireAuth(c.req.raw, c.env);
  if (error) return error;
  const body = await c.req.json().catch(() => ({}));
  if (!body.message || !body.status) return badRequest("status and message required");
  await addMaintenanceUpdate(c.env, c.req.param("id"), {
    status: body.status,
    message: body.message,
    author: user.email,
    source: "admin",
  });
  const maintenance = await getMaintenanceWithUpdates(c.env, c.req.param("id"));
  c.executionCtx.waitUntil(notifyMaintenanceEmail(c.env, maintenance));
  return json({ ok: true });
});

app.post("/api/admin/maintenances/:id/complete", async (c) => {
  const { user, error } = await requireAuth(c.req.raw, c.env);
  if (error) return error;
  const body = await c.req.json().catch(() => ({}));
  await completeMaintenance(c.env, c.req.param("id"), body.message || "Completed.", user.email, "admin");
  const maintenance = await getMaintenanceWithUpdates(c.env, c.req.param("id"));
  c.executionCtx.waitUntil(notifyMaintenanceEmail(c.env, maintenance));
  return json({ ok: true });
});

app.get("/api/admin/incidents", async (c) => {
  const { error } = await requireAuth(c.req.raw, c.env);
  if (error) return error;
  const incidents = await listIncidents(c.env, { days: 45, limit: 500 });
  return json({ incidents });
});

app.get("/api/admin/maintenances", async (c) => {
  const { error } = await requireAuth(c.req.raw, c.env);
  if (error) return error;
  const maintenances = await listMaintenances(c.env, { days: 45, limit: 500 });
  return json({ maintenances });
});

// ---------------------------------------------------------------------
// Admin: manage monitored apps (name + URL)
// ---------------------------------------------------------------------

app.get("/api/admin/apps", async (c) => {
  const { error } = await requireAuth(c.req.raw, c.env);
  if (error) return error;
  const apps = await listApps(c.env);
  return json({ apps });
});

app.post("/api/admin/apps", async (c) => {
  const { error } = await requireAuth(c.req.raw, c.env);
  if (error) return error;
  const body = await c.req.json().catch(() => ({}));
  if (!body.name || !body.url) return badRequest("name and url required");
  try {
    new URL(body.url);
  } catch {
    return badRequest("url must be a valid absolute URL");
  }
  const id = await createApp(c.env, { name: body.name, url: body.url, sortOrder: body.sortOrder || 0 });
  return json({ id }, { status: 201 });
});

app.patch("/api/admin/apps/:id", async (c) => {
  const { error } = await requireAuth(c.req.raw, c.env);
  if (error) return error;
  const body = await c.req.json().catch(() => ({}));
  const ok = await updateApp(c.env, c.req.param("id"), body);
  if (!ok) return json({ error: "not found" }, { status: 404 });
  return json({ ok: true });
});

app.delete("/api/admin/apps/:id", async (c) => {
  const { error } = await requireAuth(c.req.raw, c.env);
  if (error) return error;
  await deleteApp(c.env, c.req.param("id"));
  return json({ ok: true });
});

// ---------------------------------------------------------------------
// Admin: Gmail OAuth settings (client_id / client_secret / refresh_token),
// stored in D1. Used to send subscriber notifications.
// ---------------------------------------------------------------------

app.get("/api/admin/settings/gmail", async (c) => {
  const { error } = await requireAuth(c.req.raw, c.env);
  if (error) return error;
  const status = await getGmailSettingsStatus(c.env);
  const subscriberCount = await countSubscribers(c.env);
  return json({ ...status, subscriberCount });
});

app.post("/api/admin/settings/gmail", async (c) => {
  const { error } = await requireAuth(c.req.raw, c.env);
  if (error) return error;
  const body = await c.req.json().catch(() => ({}));
  if (!body.clientId || !body.clientSecret || !body.refreshToken || !body.senderEmail) {
    return badRequest("clientId, clientSecret, refreshToken, senderEmail all required");
  }
  await saveGmailSettings(c.env, body);
  return json({ ok: true });
});

app.notFound((c) => json({ error: "not found" }, { status: 404 }));

// ---------------------------------------------------------------------
// Email notification helpers
// ---------------------------------------------------------------------

const IMPACT_LABEL = { minor: "Minor", major: "Major", critical: "Critical" };

async function notifyIncidentEmail(env, incident) {
  if (!incident) return;
  const latest = incident.updates?.[incident.updates.length - 1];
  const subject = `[${incident.status === "resolved" ? "Resolved" : "Incident"}] ${incident.title}`;
  const html = `
    <div style="font-family:sans-serif;max-width:520px">
      <h2 style="margin-bottom:4px">${escapeHtml(incident.title)}</h2>
      <p style="color:#64748b;font-size:13px;margin-top:0">
        Status: <strong>${incident.status}</strong> · Impact: ${IMPACT_LABEL[incident.impact] || incident.impact}
      </p>
      ${latest ? `<p>${escapeHtml(latest.message)}</p>` : ""}
      <p style="font-size:12px;color:#94a3b8">Stellar Global Supplies — System Status</p>
    </div>`;
  try {
    await notifySubscribers(env, subject, html);
  } catch (e) {
    console.error("notifyIncidentEmail failed:", e.message);
  }
}

async function notifyMaintenanceEmail(env, maintenance) {
  if (!maintenance) return;
  const latest = maintenance.updates?.[maintenance.updates.length - 1];
  const subject = `[Maintenance ${maintenance.status.replace("_", " ")}] ${maintenance.title}`;
  const html = `
    <div style="font-family:sans-serif;max-width:520px">
      <h2 style="margin-bottom:4px">${escapeHtml(maintenance.title)}</h2>
      <p style="color:#64748b;font-size:13px;margin-top:0">
        Status: <strong>${maintenance.status.replace("_", " ")}</strong><br/>
        ${new Date(maintenance.scheduled_start).toLocaleString()} → ${new Date(maintenance.scheduled_end).toLocaleString()}
      </p>
      ${latest ? `<p>${escapeHtml(latest.message)}</p>` : ""}
      <p style="font-size:12px;color:#94a3b8">Stellar Global Supplies — System Status</p>
    </div>`;
  try {
    await notifySubscribers(env, subject, html);
  } catch (e) {
    console.error("notifyMaintenanceEmail failed:", e.message);
  }
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export default {
  fetch: app.fetch,
};
