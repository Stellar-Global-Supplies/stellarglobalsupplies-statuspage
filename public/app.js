const OVERALL_COPY = {
  operational: ["All Systems Operational", "Everything is running smoothly."],
  degraded_performance: ["Degraded Performance", "Some systems are experiencing issues."],
  partial_outage: ["Partial Outage", "Some systems are down."],
  major_outage: ["Major Outage", "A significant issue is affecting our systems."],
  maintenance: ["Under Maintenance", "Scheduled maintenance is in progress."],
};

const ICONS = {
  operational: "✓",
  degraded_performance: "!",
  partial_outage: "!",
  major_outage: "✕",
  maintenance: "⚙",
};

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso.includes("Z") || iso.includes("+") ? iso : iso + "Z");
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function loadOverall() {
  try {
    const data = await fetchJSON("/api/status");
    const [title, sub] = OVERALL_COPY[data.overall] || OVERALL_COPY.operational;
    document.getElementById("overall-title").textContent = title;
    document.getElementById("overall-sub").textContent = sub;
    const icon = document.getElementById("overall-icon");
    icon.className = "icon status-" + data.overall;
    icon.textContent = ICONS[data.overall] || "✓";
  } catch (e) {
    document.getElementById("overall-title").textContent = "Status unavailable";
  }
}

function renderUpdates(updates) {
  if (!updates || !updates.length) return "";
  return `<div class="updates">${updates
    .map(
      (u) => `<div class="update-row">
        <span class="badge ${u.status}">${u.status.replace("_", " ")}</span>
        ${escapeHtml(u.message)}
        <div class="u-meta">${fmtDate(u.created_at)}${u.author ? " · " + escapeHtml(u.author) : ""}${u.source === "github" ? '<span class="pill-source">GitHub</span>' : ""}</div>
      </div>`
    )
    .join("")}</div>`;
}

async function loadIncidents() {
  const el = document.getElementById("incidents-list");
  try {
    const { incidents } = await fetchJSON("/api/incidents?days=45");
    if (!incidents.length) {
      el.innerHTML = '<div class="empty-state">No incidents in the last 45 days. 🎉</div>';
      return;
    }
    el.innerHTML = (
      await Promise.all(
        incidents.map(async (i) => {
          const full = await fetchJSON(`/api/incidents/${i.id}`).then((r) => r.incident);
          return `<div class="card">
            <h3>${escapeHtml(i.title)}</h3>
            <div class="meta">
              <span class="badge ${i.status}">${i.status}</span>
              <span class="badge ${i.impact}">${i.impact}</span>
              Opened ${fmtDate(i.created_at)}${i.source === "github" ? '<span class="pill-source">GitHub PR #' + i.pr_number + "</span>" : ""}
            </div>
            ${renderUpdates(full.updates)}
          </div>`;
        })
      )
    ).join("");
  } catch (e) {
    el.innerHTML = '<div class="empty-state">Could not load incidents.</div>';
  }
}

async function loadMaintenance() {
  const el = document.getElementById("maintenance-list");
  try {
    const { maintenances } = await fetchJSON("/api/maintenances?days=45");
    if (!maintenances.length) {
      el.innerHTML = '<div class="empty-state">No maintenance windows scheduled.</div>';
      return;
    }
    el.innerHTML = (
      await Promise.all(
        maintenances.map(async (m) => {
          const full = await fetchJSON(`/api/maintenances/${m.id}`).then((r) => r.maintenance);
          return `<div class="card">
            <h3>${escapeHtml(m.title)}</h3>
            <div class="meta">
              <span class="badge ${m.status}">${m.status.replace("_", " ")}</span>
              ${fmtDate(m.scheduled_start)} → ${fmtDate(m.scheduled_end)}
              ${m.source === "github" ? '<span class="pill-source">GitHub PR #' + m.pr_number + "</span>" : ""}
            </div>
            ${renderUpdates(full.updates)}
          </div>`;
        })
      )
    ).join("");
  } catch (e) {
    el.innerHTML = '<div class="empty-state">Could not load maintenance windows.</div>';
  }
}

async function loadUptime() {
  try {
    const { days, uptimePct } = await fetchJSON("/api/uptime");
    document.getElementById("uptime-pct").textContent = uptimePct;
    const grid = document.getElementById("uptime-grid");
    grid.innerHTML = days
      .map((d) => `<div class="uptime-cell ${d.status !== "operational" ? d.status : ""}" title="${d.date}: ${d.status}"></div>`)
      .join("");
  } catch (e) {
    /* noop */
  }
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("panel-" + btn.dataset.tab).classList.add("active");
  });
});

loadOverall();
loadIncidents();
loadMaintenance();
loadUptime();
