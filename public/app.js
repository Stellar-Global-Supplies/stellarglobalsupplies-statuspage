/* ============================================================
   Stellar Global Supplies — Status Page JS
   ============================================================ */

   const OVERALL_COPY = {
    operational:          ["All Systems Operational", "Everything is running smoothly."],
    degraded_performance: ["Degraded Performance",    "Some systems are experiencing issues."],
    partial_outage:       ["Partial Outage",           "Some systems are down."],
    major_outage:         ["Major Outage",             "A significant issue is affecting our systems."],
    maintenance:          ["Under Maintenance",        "Scheduled maintenance is in progress."],
  };
  
  const ICONS = {
    operational:          "✓",
    degraded_performance: "!",
    partial_outage:       "!",
    major_outage:         "✕",
    maintenance:          "⚙",
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
  
  function fmtDateShort(iso) {
    if (!iso) return "";
    const d = new Date(iso.includes("Z") || iso.includes("+") ? iso : iso + "Z");
    return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  
  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }
  
  // ── TABS ────────────────────────────────────────────────────
  function goToTab(tabName) {
    document.querySelectorAll(".tab-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.tab === tabName)
    );
    document.querySelectorAll(".panel").forEach(p =>
      p.classList.toggle("active", p.id === "panel-" + tabName)
    );
  }
  
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => goToTab(btn.dataset.tab));
  });
  
  // ── OVERALL STATUS ───────────────────────────────────────────
  async function loadOverall() {
    try {
      const data = await fetchJSON("/api/status");
      const [title, sub] = OVERALL_COPY[data.overall] || OVERALL_COPY.operational;
      document.getElementById("overall-title").textContent = title;
      document.getElementById("overall-sub").textContent   = sub;
      const icon = document.getElementById("overall-icon");
      icon.className   = "overall-icon status-" + data.overall;
      icon.textContent = ICONS[data.overall] || "✓";
      renderActiveBar(data.incidents || [], data.maintenances || []);
    } catch {
      document.getElementById("overall-title").textContent = "Status unavailable";
    }
  }
  
  // ── ACTIVE INCIDENT BANNER ───────────────────────────────────
  function renderActiveBar(incidents, maintenances) {
    const bar = document.getElementById("active-bar");
    if (!incidents.length && !maintenances.length) {
      bar.style.display = "none";
      bar.innerHTML = "";
      return;
    }
  
    const allItems = [
      ...incidents.map(i => ({
        title: i.title,
        meta:  i.status.replace("_", " ") + " · " + i.impact,
        tab:   "incidents",
        type:  "incident",
      })),
      ...maintenances.map(m => ({
        title: m.title,
        meta:  m.status.replace("_", " ") + " · ends " + fmtDate(m.scheduled_end),
        tab:   "maintenance",
        type:  "maint",
      })),
    ];
  
    const firstType = allItems[0].type;
    bar.className = "active-bar" + (firstType === "maint" ? " maint-bar" : "");
  
    const headerLabel = incidents.length
      ? `${incidents[0].title}`
      : `${maintenances[0].title}`;
  
    bar.innerHTML = `
      <div class="active-header">
        <span class="active-header-title">${escapeHtml(headerLabel)}</span>
        <span class="active-header-sub" data-tab="${allItems[0].tab}">Subscribe</span>
      </div>
      ${allItems.map(item => `
        <div class="active-row" data-tab="${item.tab}">
          <span class="active-title">${escapeHtml(item.title)}</span>
          <span class="active-meta">${escapeHtml(item.meta)}</span>
        </div>
      `).join("")}
    `;
  
    bar.style.display = "block";
    bar.querySelectorAll("[data-tab]").forEach(el => {
      el.addEventListener("click", () => goToTab(el.dataset.tab));
    });
  }
  
  // ── APPS / UPTIME BARS ───────────────────────────────────────
  const APP_STATUS_MAP = {
    operational: { label: "Operational", cls: "ok" },
    outage:      { label: "Outage",       cls: "outage" },
    degraded:    { label: "Degraded Performance", cls: "degraded" },
    maintenance: { label: "Maintenance",  cls: "maint" },
    unknown:     { label: "Checking…",   cls: "" },
  };
  
  async function loadApps() {
    const el = document.getElementById("apps-list");
    try {
      const { apps } = await fetchJSON("/api/apps");
      if (!apps.length) {
        el.innerHTML = '<div class="empty-state">No services configured yet.</div>';
        return;
      }
  
      el.innerHTML = apps.map(a => {
        const sm = APP_STATUS_MAP[a.last_status] || APP_STATUS_MAP.unknown;
        return `
          <div class="app-row" id="app-row-${a.id}">
            <div class="app-row-header">
              <span class="app-name">${escapeHtml(a.name)}</span>
              <span class="app-status-label ${sm.cls}" id="app-lbl-${a.id}">${sm.label}</span>
            </div>
            <div class="uptime-bar-wrap" id="app-grid-${a.id}">
              ${Array.from({length:90}, () => '<div class="uptime-cell no-data"></div>').join("")}
            </div>
            <div class="uptime-bar-labels">
              <span>90 days ago</span>
              <span class="pct"><span id="app-pct-${a.id}">—</span>% uptime</span>
              <span>Today</span>
            </div>
          </div>
        `;
      }).join("");
  
      await Promise.all(apps.map(async a => {
        try {
          const { days, uptimePct } = await fetchJSON(`/api/apps/${a.id}/uptime`);
          document.getElementById(`app-pct-${a.id}`).textContent = uptimePct;
          document.getElementById(`app-grid-${a.id}`).innerHTML = days
            .map(d => `<div class="uptime-cell ${d.status !== "operational" ? d.status : ""}" title="${d.date}: ${d.status}"></div>`)
            .join("");
        } catch { /* noop */ }
      }));
    } catch {
      el.innerHTML = '<div class="empty-state">Could not load services.</div>';
    }
  }
  
  // ── INCIDENTS ────────────────────────────────────────────────
  function renderUpdates(updates) {
    if (!updates || !updates.length) return "";
    return updates.map(u => `
      <div class="update-row">
        <span class="badge ${u.status}">${u.status.replace("_", " ")}</span>
        - ${escapeHtml(u.message)}
        <div class="u-meta">${fmtDate(u.created_at)}${u.author ? " · " + escapeHtml(u.author) : ""}${u.source === "github" ? '<span class="pill-source">GitHub</span>' : ""}</div>
      </div>
    `).join("");
  }
  
  function groupByDate(items, dateField) {
    const groups = {};
    items.forEach(i => {
      const label = fmtDateShort(i[dateField]);
      if (!groups[label]) groups[label] = [];
      groups[label].push(i);
    });
    return groups;
  }
  
  async function loadIncidents() {
    const el = document.getElementById("incidents-list");
    try {
      const { incidents } = await fetchJSON("/api/incidents?days=45");
      if (!incidents.length) {
        el.innerHTML = '<div class="empty-state">No incidents in the last 45 days. 🎉</div>';
        return;
      }
  
      const groups = groupByDate(incidents, "created_at");
  
      el.innerHTML = (await Promise.all(
        Object.entries(groups).map(async ([dateLabel, items]) => {
          const rows = await Promise.all(items.map(async i => {
            const full = await fetchJSON(`/api/incidents/${i.id}`).then(r => r.incident);
            const isOpen = i.status !== "resolved";
            return `
              <details class="inc-item"${isOpen ? " open" : ""}>
                <summary>
                  <a class="inc-title-link" href="#" onclick="return false;">${escapeHtml(i.title)}</a>
                  <span class="inc-meta">${i.status.replace("_", " ")} · Opened ${fmtDate(i.created_at)}</span>
                </summary>
                <div class="inc-body">${renderUpdates(full.updates)}</div>
              </details>
            `;
          }));
          return `
            <div class="inc-date-group">
              <div class="inc-date-label">${dateLabel}</div>
              ${rows.join("")}
            </div>
          `;
        })
      )).join("");
    } catch {
      el.innerHTML = '<div class="empty-state">Could not load incidents.</div>';
    }
  }
  
  // ── MAINTENANCE ──────────────────────────────────────────────
  async function loadMaintenance() {
    const el = document.getElementById("maintenance-list");
    try {
      const { maintenances } = await fetchJSON("/api/maintenances?days=45");
      if (!maintenances.length) {
        el.innerHTML = '<div class="empty-state">No maintenance windows in the last 45 days.</div>';
        return;
      }
  
      const groups = groupByDate(maintenances, "scheduled_start");
  
      el.innerHTML = (await Promise.all(
        Object.entries(groups).map(async ([dateLabel, items]) => {
          const rows = await Promise.all(items.map(async m => {
            const full = await fetchJSON(`/api/maintenances/${m.id}`).then(r => r.maintenance);
            const isOpen = m.status !== "completed" && m.status !== "cancelled";
            return `
              <details class="inc-item"${isOpen ? " open" : ""}>
                <summary>
                  <a class="inc-title-link" href="#" onclick="return false;" style="color:var(--maint)">${escapeHtml(m.title)}</a>
                  <span class="inc-meta">${m.status.replace("_", " ")} · ${fmtDate(m.scheduled_start)} → ${fmtDate(m.scheduled_end)}</span>
                </summary>
                <div class="inc-body">${renderUpdates(full.updates)}</div>
              </details>
            `;
          }));
          return `
            <div class="inc-date-group">
              <div class="inc-date-label">${dateLabel}</div>
              ${rows.join("")}
            </div>
          `;
        })
      )).join("");
    } catch {
      el.innerHTML = '<div class="empty-state">Could not load maintenance windows.</div>';
    }
  }
  
  // ── SUBSCRIBE ────────────────────────────────────────────────
  document.getElementById("subscribe-form").addEventListener("submit", async e => {
    e.preventDefault();
    const email = document.getElementById("subscribe-email").value.trim();
    const msg   = document.getElementById("subscribe-msg");
    const btn   = document.getElementById("subscribe-btn");
    btn.disabled = true;
    try {
      await fetchJSON("/api/subscribe", {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({ email }),
      });
      msg.textContent = "You're subscribed — you'll get an email on incidents and maintenance.";
      msg.className   = "subscribe-msg success";
      document.getElementById("subscribe-email").value = "";
    } catch {
      msg.textContent = "Something went wrong. Please try again.";
      msg.className   = "subscribe-msg error";
    } finally {
      btn.disabled = false;
    }
  });
  
  // ── BOOT ─────────────────────────────────────────────────────
  loadOverall();
  loadApps();
  loadIncidents();
  loadMaintenance();