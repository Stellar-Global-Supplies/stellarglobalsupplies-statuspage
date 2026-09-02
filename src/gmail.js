// Sends notification emails via the Gmail API, using OAuth credentials
// (client_id, client_secret, refresh_token) saved in D1 through the admin
// panel — see src/settings.js. We exchange the refresh token for a fresh
// access token on each send (Gmail access tokens are short-lived, ~1hr,
// and Workers are stateless between requests so caching isn't worth the
// complexity here).

async function getGmailConfig(env) {
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('gmail_client_id','gmail_client_secret','gmail_refresh_token','gmail_sender_email')"
  ).all();
  const map = Object.fromEntries((results || []).map((r) => [r.key, r.value]));
  return {
    clientId: map.gmail_client_id || null,
    clientSecret: map.gmail_client_secret || null,
    refreshToken: map.gmail_refresh_token || null,
    senderEmail: map.gmail_sender_email || null,
  };
}

async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || "Failed to refresh Gmail access token");
  return data.access_token;
}

function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildMime({ from, to, subject, html }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
  ].join("\r\n");
  return `${headers}\r\n\r\n${html}`;
}

export async function sendGmail(env, { to, subject, html }) {
  const config = await getGmailConfig(env);
  if (!config.clientId || !config.clientSecret || !config.refreshToken || !config.senderEmail) {
    throw new Error("Gmail is not configured yet (set it in the admin panel)");
  }
  const accessToken = await getAccessToken(config);
  const raw = toBase64Url(buildMime({ from: config.senderEmail, to, subject, html }));

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gmail send failed (${res.status})`);
  }
}

// Fire-and-forget-friendly: sends to every subscriber, swallowing individual
// failures so one bad address doesn't stop the rest. Call via
// `c.executionCtx.waitUntil(notifySubscribers(...))` so it doesn't block
// the API response.
export async function notifySubscribers(env, subject, html) {
  const { results } = await env.DB.prepare("SELECT email, unsubscribe_token FROM subscribers").all();
  const subscribers = results || [];
  if (!subscribers.length) return;

  await Promise.allSettled(
    subscribers.map((s) => {
      const unsubUrl = `${env.PUBLIC_BASE_URL || ""}/api/unsubscribe?token=${encodeURIComponent(s.unsubscribe_token)}`;
      const fullHtml = `${html}<p style="font-size:11px;color:#94a3b8;margin-top:24px">You're receiving this because you subscribed to status updates. <a href="${unsubUrl}">Unsubscribe</a></p>`;
      return sendGmail(env, { to: s.email, subject, html: fullHtml });
    })
  );
}
