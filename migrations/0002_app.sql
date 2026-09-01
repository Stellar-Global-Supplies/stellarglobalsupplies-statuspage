-- Multi-app uptime: a set of URLs mapped to app names, each with its own
-- 45-day bar. Live-checked on status-page view (throttled), and overridden
-- for any day/app that has an incident (orange) or maintenance (blue).

CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,        
  last_status TEXT NOT NULL DEFAULT 'unknown', 
  last_checked_at TEXT,
  last_http_status INTEGER,
  last_latency_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_daily_status (
  app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  date TEXT NOT NULL,                        
  status TEXT NOT NULL DEFAULT 'operational', 
  checked_count INTEGER NOT NULL DEFAULT 0,
  last_http_status INTEGER,
  PRIMARY KEY (app_id, date)
);

ALTER TABLE incidents ADD COLUMN app_id INTEGER REFERENCES apps(id);
ALTER TABLE maintenances ADD COLUMN app_id INTEGER REFERENCES apps(id);

CREATE INDEX IF NOT EXISTS idx_app_daily_status_app ON app_daily_status(app_id, date);
CREATE INDEX IF NOT EXISTS idx_incidents_app ON incidents(app_id);
CREATE INDEX IF NOT EXISTS idx_maintenances_app ON maintenances(app_id);

INSERT INTO apps (name, url, sort_order)
SELECT 'Stellar Global Supplies', 'https://www.stellarglobalsupplies.com/', 1
WHERE NOT EXISTS (SELECT 1 FROM apps WHERE url = 'https://www.stellarglobalsupplies.com/');