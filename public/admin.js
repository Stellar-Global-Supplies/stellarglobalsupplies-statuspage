import { supabase } from "./lib/supabase-client.js";

const LANDING_URL = (window.__ENV__ && window.__ENV__.LANDING_URL) || "https://apps.stellarglobalsupplies.com";

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso.includes("Z") || iso.includes("+") ? iso : iso + "Z");
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function goToPortalLogin() {
  const redirect = window.location.pathname + window.location.search + window.location.hash;
  const callback = encodeURIComponent(
    `${window.location.origin}/sso-callback.html?redirect=${encodeURIComponent(redirect)}`
  );
  window.location.replace(`${LANDING_URL}/login?callback=${callback}`);
}

function showChecking() {
  document.getElementById("checking-view").style.display = "block";
  document.getElementById("admin-view").style.display = "none";
  document.getElementById("logout-link").style.display = "none";
}

function showAdmin() {
  document.getElementById("checking-view").style.display = "none";
  document.getElementById("admin-view").style.display = "block";
  document.getElementById("logout-link").style.display = "inline";
  loadAdminIncidents();
  loadAdminMaintenances();
}

async function signOut() {
  await supabase.auth.signOut().catch(() => {});
  window.location.replace(LANDING_URL);
}

document.getElementById("logout-link").addEventListener("click", (e) => {
  e.preventDefault();
  signOut();
});

// --- Authenticated API calls: attach the Supabase access token ---------

async function api(path, opts = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("unauthorized");
  const res = await fetch(path, {
    ...opts,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.access_token}`,
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) throw new Error("unauthorized");
  if (res.status === 403) throw new Error("forbidden");
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

// --- Bootstrap: same "don't trust context blindly, confirm session" ----
// pattern as the billing app's RequireAuth, since we land here straight
// from /sso-callback.html.

async function bootstrap() {
  showChecking();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    goToPortalLogin();
    return;
  }

  try {
    await api("/api/admin/me");
    showAdmin();
  } catch {
    goToPortalLogin();
  }
}

supabase.auth.onAuthStateChange((_event, session) => {
  if (!session) goToPortalLogin();
});

// --- Incident / maintenance CRUD (unchanged from before, just uses api()) --

document.getElementById("inc-create").addEventListener("click", async () => {
  const title = document.getElementById("inc-title").value.trim();
  const impact = document.getElementById("inc-impact").value;
  const body = document.getElementById("inc-body").value.trim();
  if (!title) return alert("Title is required");
  await api("/api/admin/incidents", { method: "POST", body: JSON.stringify({ title, impact, body }) });
  document.getElementById("inc-title").value = "";
  document.getElementById("inc-body").value = "";
  loadAdminIncidents();
});

document.getElementById("mnt-create").addEventListener("click", async () => {
  const title = document.getElementById("mnt-title").value.trim();
  const start = document.getElementById("mnt-start").value;
  const end = document.getElementById("mnt-end").value;
  const body = document.getElementById("mnt-body").value.trim();
  if (!title || !start || !end) return alert("Title, start and end are required");
  await api("/api/admin/maintenances", {
    method: "POST",
    body: JSON.stringify({
      title,
      body,
      scheduledStart: new Date(start).toISOString(),
      scheduledEnd: new Date(end).toISOString(),
    }),
  });
  document.getElementById("mnt-title").value = "";
  document.getElementById("mnt-body").value = "";
  loadAdminMaintenances();
});

async function loadAdminIncidents() {
  const el = document.getElementById("admin-incidents");
  const { incidents } = await api("/api/admin/incidents");
  if (!incidents.length) {
    el.innerHTML = '<div class="empty-state">No incidents.</div>';
    return;
  }
  el.innerHTML = incidents
    .map(
      (i) => `<div class="card">
      <h3>${escapeHtml(i.title)}</h3>
      <div class="meta">
        <span class="badge ${i.status}">${i.status}</span>
        <span class="badge ${i.impact}">${i.impact}</span>
        ${fmtDate(i.created_at)}
        ${i.source === "github" ? '<span class="pill-source">GitHub PR #' + i.pr_number + "</span>" : ""}
      </div>
      ${
        i.status !== "resolved"
          ? `<div>
        <input type="text" placeholder="Update message" id="inc-update-${i.id}" style="margin-bottom:8px" />
        <select id="inc-status-${i.id}">
          <option value="investigating">Investigating</option>
          <option value="identified">Identified</option>
          <option value="monitoring">Monitoring</option>
          <option value="resolved">Resolved</option>
        </select>
        <button class="secondary" onclick="postIncidentUpdate(${i.id})">Post Update</button>
        <button class="secondary" onclick="resolveIncident(${i.id})">Resolve</button>
      </div>`
          : ""
      }
    </div>`
    )
    .join("");
}

async function loadAdminMaintenances() {
  const el = document.getElementById("admin-maintenances");
  const { maintenances } = await api("/api/admin/maintenances");
  if (!maintenances.length) {
    el.innerHTML = '<div class="empty-state">No maintenance windows.</div>';
    return;
  }
  el.innerHTML = maintenances
    .map(
      (m) => `<div class="card">
      <h3>${escapeHtml(m.title)}</h3>
      <div class="meta">
        <span class="badge ${m.status}">${m.status.replace("_", " ")}</span>
        ${fmtDate(m.scheduled_start)} → ${fmtDate(m.scheduled_end)}
        ${m.source === "github" ? '<span class="pill-source">GitHub PR #' + m.pr_number + "</span>" : ""}
      </div>
      ${
        m.status !== "completed" && m.status !== "cancelled"
          ? `<div>
        <input type="text" placeholder="Update message" id="mnt-update-${m.id}" style="margin-bottom:8px" />
        <select id="mnt-status-${m.id}">
          <option value="scheduled">Scheduled</option>
          <option value="in_progress">In progress</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <button class="secondary" onclick="postMaintenanceUpdate(${m.id})">Post Update</button>
        <button class="secondary" onclick="completeMaintenance(${m.id})">Complete</button>
      </div>`
          : ""
      }
    </div>`
    )
    .join("");
}

window.postIncidentUpdate = async function (id) {
  const message = document.getElementById(`inc-update-${id}`).value.trim();
  const status = document.getElementById(`inc-status-${id}`).value;
  if (!message) return alert("Enter an update message");
  await api(`/api/admin/incidents/${id}/updates`, { method: "POST", body: JSON.stringify({ status, message }) });
  loadAdminIncidents();
};

window.resolveIncident = async function (id) {
  await api(`/api/admin/incidents/${id}/resolve`, { method: "POST", body: JSON.stringify({ message: "Resolved." }) });
  loadAdminIncidents();
};

window.postMaintenanceUpdate = async function (id) {
  const message = document.getElementById(`mnt-update-${id}`).value.trim();
  const status = document.getElementById(`mnt-status-${id}`).value;
  if (!message) return alert("Enter an update message");
  await api(`/api/admin/maintenances/${id}/updates`, { method: "POST", body: JSON.stringify({ status, message }) });
  loadAdminMaintenances();
};

window.completeMaintenance = async function (id) {
  await api(`/api/admin/maintenances/${id}/complete`, { method: "POST", body: JSON.stringify({ message: "Completed." }) });
  loadAdminMaintenances();
};

bootstrap();
