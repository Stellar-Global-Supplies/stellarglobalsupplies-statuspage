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
  return json({ ok: true, event: eventName, result });
});

// ---------------------------------------------------------------------
// Admin auth — SSO via the central portal (Supabase). The frontend sends
// `Authorization: Bearer <supabase access_token>` on every admin call;
// requireAuth() verifies that token and checks the admin allowlist.
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
    source: "admin",
    author: user.email,
  });
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
  return json({ ok: true });
});

app.post("/api/admin/incidents/:id/resolve", async (c) => {
  const { user, error } = await requireAuth(c.req.raw, c.env);
  if (error) return error;
  const body = await c.req.json().catch(() => ({}));
  await resolveIncident(c.env, c.req.param("id"), body.message || "Resolved.", user.email, "admin");
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
    scheduledStart: body.scheduledStart,
    scheduledEnd: body.scheduledEnd,
    source: "admin",
    author: user.email,
  });
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
  return json({ ok: true });
});

app.post("/api/admin/maintenances/:id/complete", async (c) => {
  const { user, error } = await requireAuth(c.req.raw, c.env);
  if (error) return error;
  const body = await c.req.json().catch(() => ({}));
  await completeMaintenance(c.env, c.req.param("id"), body.message || "Completed.", user.email, "admin");
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

app.notFound((c) => json({ error: "not found" }, { status: 404 }));

export default {
  fetch: app.fetch,
};