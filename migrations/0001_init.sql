-- Stellar Global Supplies status page schema

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

INSERT INTO components (name, description, sort_order)
SELECT 'Website', 'stellarglobalsupplies.com', 1
WHERE NOT EXISTS (SELECT 1 FROM components WHERE name = 'Website');

INSERT INTO components (name, description, sort_order)
SELECT 'Quote / Contact Forms', 'Lead capture & contact endpoints', 2
WHERE NOT EXISTS (SELECT 1 FROM components WHERE name = 'Quote / Contact Forms');

INSERT INTO components (name, description, sort_order)
SELECT 'Product Catalogue', 'Product & pricing pages', 3
WHERE NOT EXISTS (SELECT 1 FROM components WHERE name = 'Product Catalogue');

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'investigating', 
  impact TEXT NOT NULL DEFAULT 'minor',          
  component_id INTEGER REFERENCES components(id),
  body TEXT,
  source TEXT NOT NULL DEFAULT 'admin',          
  repo TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS incident_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  author TEXT,
  source TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS maintenances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  component_id INTEGER REFERENCES components(id),
  body TEXT,
  scheduled_start TEXT NOT NULL,
  scheduled_end TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'admin',
  repo TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS maintenance_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  maintenance_id INTEGER NOT NULL REFERENCES maintenances(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  author TEXT,
  source TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);


CREATE TABLE IF NOT EXISTS daily_status (
  date TEXT PRIMARY KEY,             
  status TEXT NOT NULL DEFAULT 'operational', 
  incident_count INTEGER NOT NULL DEFAULT 0,
  worst_impact TEXT
);

CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents(created_at);
CREATE INDEX IF NOT EXISTS idx_incidents_pr ON incidents(repo, pr_number);
CREATE INDEX IF NOT EXISTS idx_maintenances_pr ON maintenances(repo, pr_number);
CREATE INDEX IF NOT EXISTS idx_incident_updates_incident ON incident_updates(incident_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_updates_maintenance ON maintenance_updates(maintenance_id);
