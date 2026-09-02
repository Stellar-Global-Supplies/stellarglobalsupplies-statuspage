import { randomToken } from "./utils.js";

export async function subscribe(env, email) {
  const token = randomToken(24);
  try {
    await env.DB.prepare(
      "INSERT INTO subscribers (email, unsubscribe_token) VALUES (?, ?)"
    )
      .bind(email.trim().toLowerCase(), token)
      .run();
    return { created: true };
  } catch {
    // Already subscribed (UNIQUE constraint) — treat as success, no error
    // leaked about which emails already exist.
    return { created: false };
  }
}

export async function unsubscribe(env, token) {
  const res = await env.DB.prepare("DELETE FROM subscribers WHERE unsubscribe_token = ?").bind(token).run();
  return res.meta.changes > 0;
}

export async function countSubscribers(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) as n FROM subscribers").first();
  return row?.n || 0;
}

// --- Gmail OAuth settings (stored in D1, set via the admin panel) --------

const GMAIL_KEYS = ["gmail_client_id", "gmail_client_secret", "gmail_refresh_token", "gmail_sender_email"];

export async function saveGmailSettings(env, { clientId, clientSecret, refreshToken, senderEmail }) {
  const values = {
    gmail_client_id: clientId,
    gmail_client_secret: clientSecret,
    gmail_refresh_token: refreshToken,
    gmail_sender_email: senderEmail,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue; // allow partial updates
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
      .bind(key, value)
      .run();
  }
}

export async function getGmailSettingsStatus(env) {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM settings WHERE key IN (${GMAIL_KEYS.map(() => "?").join(",")})`
  )
    .bind(...GMAIL_KEYS)
    .all();
  const map = Object.fromEntries((results || []).map((r) => [r.key, r.value]));
  return {
    configured: GMAIL_KEYS.every((k) => !!map[k]),
    senderEmail: map.gmail_sender_email || null,
    clientId: map.gmail_client_id ? maskMiddle(map.gmail_client_id) : null,
  };
}

function maskMiddle(s) {
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}
