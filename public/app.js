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

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
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
    renderActiveBar(data.incidents || [], data.maintenances || []);
  } catch (e) {
    document.getElementById("overall-title").textContent = "Status unavailable";
  }
}

function goToTab(tabName) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabName));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + tabName));
}

function renderActiveBar(incidents, maintenances) {
  const bar = document.getElementById("active-bar");
  if (!incidents.length && !maintenances.length) {
    bar.style.display = "none";
    bar.innerHTML = "";
    return;
  }

  const incidentRows = incidents.map(
    (i) => `<div class="active-row" data-tab="incidents">
      <span class="dot orange"></span>
      <span class="active-title">${escapeHtml(i.title)}</span>
      <span class="active-meta">${i.status.replace("_", " ")} · ${i.impact}</span>
    </div>`
  );

  const maintenanceRows = maintenances.map(
    (m) => `<div class="active-row" data-tab="maintenance">
      <span class="dot blue"></span>
      <span class="active-title">${escapeHtml(m.title)}</span>
      <span class="active-meta">${m.status.replace("_", " ")} · ends ${fmtDate(m.scheduled_end)}</span>
    </div>`
  );

  bar.innerHTML = [...incidentRows, ...maintenanceRows].join("");
  bar.style.display = "block";
  bar.querySelectorAll(".active-row").forEach((row) => {
    row.addEventListener("click", () => goToTab(row.dataset.tab));
  });
}

function renderAppChips(apps) {
  if (!apps || !apps.length) return '<span class="app-chip">Site-wide</span>';
  return apps.map((a) => `<span class="app-chip">${escapeHtml(a.name)}</span>`).join("");
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
          return `<details class="card"${i.status !== "resolved" ? " open" : ""}>
            <summary>
              <h3>${escapeHtml(i.title)}</h3>
              <div class="meta">
                <span class="badge ${i.status}">${i.status}</span>
                <span class="badge ${i.impact}">${i.impact}</span>
                Opened ${fmtDate(i.created_at)}${i.source === "github" ? '<span class="pill-source">GitHub PR #' + i.pr_number + "</span>" : ""}
              </div>
              <div>${renderAppChips(full.apps)}</div>
            </summary>
            <div class="details-body">${renderUpdates(full.updates)}</div>
          </details>`;
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
          return `<details class="card"${m.status !== "completed" && m.status !== "cancelled" ? " open" : ""}>
            <summary>
              <h3>${escapeHtml(m.title)}</h3>
              <div class="meta">
                <span class="badge ${m.status}">${m.status.replace("_", " ")}</span>
                ${fmtDate(m.scheduled_start)} → ${fmtDate(m.scheduled_end)}
                ${m.source === "github" ? '<span class="pill-source">GitHub PR #' + m.pr_number + "</span>" : ""}
              </div>
              <div>${renderAppChips(full.apps)}</div>
            </summary>
            <div class="details-body">${renderUpdates(full.updates)}</div>
          </details>`;
        })
      )
    ).join("");
  } catch (e) {
    el.innerHTML = '<div class="empty-state">Could not load maintenance windows.</div>';
  }
}

const APP_STATUS_LABEL = { operational: "Operational", outage: "Outage", degraded: "Incident", maintenance: "Maintenance", unknown: "Checking…" };

function appStatusClass(status) {
  // Reuses the same badge palette: minor=green-ish, major=orange, critical=red.
  if (status === "operational") return "resolved";
  if (status === "outage") return "critical";
  if (status === "degraded") return "major";
  if (status === "maintenance") return "monitoring";
  return "scheduled";
}

async function loadApps() {
  const el = document.getElementById("apps-list");
  try {
    const { apps } = await fetchJSON("/api/apps");
    if (!apps.length) {
      el.innerHTML = '<div class="empty-state">No apps configured yet.</div>';
      return;
    }
    el.innerHTML = apps
      .map(
        (a) => `<div class="card">
          <h3>${escapeHtml(a.name)}</h3>
          <div class="meta">
            <span class="badge ${appStatusClass(a.last_status)}">${APP_STATUS_LABEL[a.last_status] || a.last_status}</span>
            <a href="${escapeHtml(a.url)}" target="_blank" rel="noopener" style="color:var(--ink-soft)">${escapeHtml(a.url)}</a>
            ${a.last_latency_ms ? ` · ${a.last_latency_ms}ms` : ""}
          </div>
          <div class="uptime-summary">
            <span>Last 45 days</span>
            <span><strong id="app-pct-${a.id}">--</strong>% uptime</span>
          </div>
          <div class="uptime-grid" id="app-grid-${a.id}"></div>
        </div>`
      )
      .join("");

    await Promise.all(
      apps.map(async (a) => {
        try {
          const { days, uptimePct } = await fetchJSON(`/api/apps/${a.id}/uptime`);
          document.getElementById(`app-pct-${a.id}`).textContent = uptimePct;
          document.getElementById(`app-grid-${a.id}`).innerHTML = days
            .map((d) => `<div class="uptime-cell ${d.status !== "operational" ? d.status : ""}" title="${d.date}: ${d.status}"></div>`)
            .join("");
        } catch {
          /* noop */
        }
      })
    );
  } catch (e) {
    el.innerHTML = '<div class="empty-state">Could not load apps.</div>';
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

document.getElementById("subscribe-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("subscribe-email").value.trim();
  const msg = document.getElementById("subscribe-msg");
  const btn = document.getElementById("subscribe-btn");
  btn.disabled = true;
  try {
    await fetchJSON("/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    msg.textContent = "You're subscribed — you'll get an email on incidents and maintenance.";
    msg.className = "subscribe-msg success";
    document.getElementById("subscribe-email").value = "";
  } catch {
    msg.textContent = "Something went wrong. Please try again.";
    msg.className = "subscribe-msg error";
  } finally {
    btn.disabled = false;
  }
});

loadOverall();
loadApps();
loadIncidents();
loadMaintenance();