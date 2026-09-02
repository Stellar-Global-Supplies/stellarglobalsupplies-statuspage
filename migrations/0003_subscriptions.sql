-- Email subscribers for status-page notifications, and the Gmail OAuth
-- credentials used to send them (stored in D1 per requirement — client_id,
-- client_secret and refresh_token live here, set via the admin panel).

CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  unsubscribe_token TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Simple key/value settings store. Used for the Gmail OAuth app credentials:
--   gmail_client_id, gmail_client_secret, gmail_refresh_token, gmail_sender_email
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email);
