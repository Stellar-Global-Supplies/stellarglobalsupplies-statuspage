-- Scoping incidents/maintenance to specific apps. An incident/maintenance
-- with NO rows in its join table is "site-wide" (shown on every app's
-- uptime bar, same as the old app_id IS NULL behavior); one or more rows
-- means it only affects those specific apps.

ALTER TABLE apps ADD COLUMN slug TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_slug ON apps(slug);


UPDATE apps
SET slug = lower(
  trim(
    replace(replace(replace(replace(name, ' ', '-'), '_', '-'), '.', ''), '/', '-'),
    '-'
  )
)
WHERE slug IS NULL;

CREATE TABLE IF NOT EXISTS incident_apps (
  incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  PRIMARY KEY (incident_id, app_id)
);

CREATE TABLE IF NOT EXISTS maintenance_apps (
  maintenance_id INTEGER NOT NULL REFERENCES maintenances(id) ON DELETE CASCADE,
  app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  PRIMARY KEY (maintenance_id, app_id)
);

INSERT OR IGNORE INTO incident_apps (incident_id, app_id)
SELECT id, app_id FROM incidents WHERE app_id IS NOT NULL;

INSERT OR IGNORE INTO maintenance_apps (maintenance_id, app_id)
SELECT id, app_id FROM maintenances WHERE app_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_incident_apps_app ON incident_apps(app_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_apps_app ON maintenance_apps(app_id);
