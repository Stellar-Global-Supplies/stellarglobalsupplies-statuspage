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
  loadAdminApps();
  loadGmailSettings();
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
  const appIds = getSelectedAppIds("inc-apps-picker");
  if (!title) return alert("Title is required");
  await api("/api/admin/incidents", { method: "POST", body: JSON.stringify({ title, impact, body, appIds }) });
  document.getElementById("inc-title").value = "";
  document.getElementById("inc-body").value = "";
  loadAdminIncidents();
});

document.getElementById("mnt-create").addEventListener("click", async () => {
  const title = document.getElementById("mnt-title").value.trim();
  const start = document.getElementById("mnt-start").value;
  const end = document.getElementById("mnt-end").value;
  const body = document.getElementById("mnt-body").value.trim();
  const appIds = getSelectedAppIds("mnt-apps-picker");
  if (!title || !start || !end) return alert("Title, start and end are required");
  await api("/api/admin/maintenances", {
    method: "POST",
    body: JSON.stringify({
      title,
      body,
      appIds,
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

// --- Monitored apps -------------------------------------------------------

document.getElementById("app-create").addEventListener("click", async () => {
  const name = document.getElementById("app-name").value.trim();
  const url = document.getElementById("app-url").value.trim();
  if (!name || !url) return alert("Name and URL are required");
  try {
    await api("/api/admin/apps", { method: "POST", body: JSON.stringify({ name, url }) });
    document.getElementById("app-name").value = "";
    document.getElementById("app-url").value = "";
    loadAdminApps();
  } catch (e) {
    alert(e.message);
  }
});

async function loadAdminApps() {
  const el = document.getElementById("admin-apps");
  const { apps } = await api("/api/admin/apps");

  renderAppsPicker("inc-apps-picker", apps);
  renderAppsPicker("mnt-apps-picker", apps);

  if (!apps.length) {
    el.innerHTML = '<div class="empty-state">No apps yet.</div>';
    return;
  }
  el.innerHTML = apps
    .map(
      (a) => `<div class="card">
      <h3>${escapeHtml(a.name)} ${a.active ? "" : '<span class="pill-source">Paused</span>'}</h3>
      <div class="meta">
        ${escapeHtml(a.url)}<br/>
        Last check: <span class="badge ${a.last_status === "operational" ? "resolved" : a.last_status === "outage" ? "critical" : "scheduled"}">${a.last_status}</span>
        ${a.last_checked_at ? fmtDate(a.last_checked_at) : "never"}
      </div>
      <button class="secondary" onclick="toggleApp(${a.id}, ${a.active ? 0 : 1})">${a.active ? "Pause" : "Resume"}</button>
      <button class="secondary" onclick="deleteAppRow(${a.id})">Delete</button>
    </div>`
    )
    .join("");
}

// Renders "Site-wide" + one checkbox per app. Site-wide is checked by
// default and, when checked, disables the individual app boxes (an
// incident is either site-wide OR scoped to specific apps, not both).
function renderAppsPicker(containerId, apps) {
  const el = document.getElementById(containerId);
  if (!apps.length) {
    el.innerHTML = '<span class="empty-state" style="padding:8px 0">No apps yet — add one below first.</span>';
    return;
  }
  el.innerHTML = `
    <label><input type="checkbox" class="site-wide-toggle" checked /> Site-wide (affects all apps)</label>
    <hr/>
    ${apps
      .map((a) => `<label><input type="checkbox" class="app-toggle" value="${a.id}" disabled /> ${escapeHtml(a.name)}</label>`)
      .join("")}
  `;
  const siteWideBox = el.querySelector(".site-wide-toggle");
  const appBoxes = el.querySelectorAll(".app-toggle");
  siteWideBox.addEventListener("change", () => {
    appBoxes.forEach((box) => {
      box.disabled = siteWideBox.checked;
      if (siteWideBox.checked) box.checked = false;
    });
  });
}

function getSelectedAppIds(containerId) {
  const el = document.getElementById(containerId);
  const siteWideBox = el.querySelector(".site-wide-toggle");
  if (!siteWideBox || siteWideBox.checked) return []; // [] = site-wide
  return [...el.querySelectorAll(".app-toggle:checked")].map((box) => Number(box.value));
}

window.toggleApp = async function (id, active) {
  await api(`/api/admin/apps/${id}`, { method: "PATCH", body: JSON.stringify({ active: !!active }) });
  loadAdminApps();
};

window.deleteAppRow = async function (id) {
  if (!confirm("Delete this app? Its uptime history will be removed too.")) return;
  await api(`/api/admin/apps/${id}`, { method: "DELETE" });
  loadAdminApps();
};

// --- Gmail settings ---------------------------------------------------

async function loadGmailSettings() {
  const statusEl = document.getElementById("gmail-status");
  try {
    const s = await api("/api/admin/settings/gmail");
    statusEl.textContent = s.configured
      ? `Configured (sending as ${s.senderEmail}). ${s.subscriberCount} subscriber(s).`
      : `Not configured yet. ${s.subscriberCount} subscriber(s) waiting.`;
  } catch {
    statusEl.textContent = "Could not load Gmail configuration status.";
  }
}

document.getElementById("gmail-save").addEventListener("click", async () => {
  const clientId = document.getElementById("gmail-client-id").value.trim();
  const clientSecret = document.getElementById("gmail-client-secret").value.trim();
  const refreshToken = document.getElementById("gmail-refresh-token").value.trim();
  const senderEmail = document.getElementById("gmail-sender-email").value.trim();
  if (!clientId || !clientSecret || !refreshToken || !senderEmail) {
    return alert("All four Gmail fields are required");
  }
  try {
    await api("/api/admin/settings/gmail", {
      method: "POST",
      body: JSON.stringify({ clientId, clientSecret, refreshToken, senderEmail }),
    });
    document.getElementById("gmail-client-id").value = "";
    document.getElementById("gmail-client-secret").value = "";
    document.getElementById("gmail-refresh-token").value = "";
    document.getElementById("gmail-sender-email").value = "";
    loadGmailSettings();
    alert("Gmail settings saved.");
  } catch (e) {
    alert(e.message);
  }
});

bootstrap();
