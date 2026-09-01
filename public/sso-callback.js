import { supabase } from "./lib/supabase-client.js";

const LANDING_URL = (window.__ENV__ && window.__ENV__.LANDING_URL) || "https://apps.stellarglobalsupplies.com";
const EXCHANGE_FN = `${window.__ENV__.SUPABASE_URL}/functions/v1/sso-exchange`;

const MAX_AGE_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 30 * 1000;

function safeRedirect(redirect, fallback = "/admin.html") {
  try {
    const url = new URL(redirect || fallback, window.location.origin);
    if (url.origin !== window.location.origin) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

function showError(message) {
  document.getElementById("sso-body").innerHTML = `
    <p class="sso-error-title">Sign-in error</p>
    <p class="sso-error-msg">${message}</p>
    <a href="${LANDING_URL}" class="sso-btn">Return to Portal</a>
  `;
}

function setStatus(text) {
  const el = document.getElementById("sso-status-text");
  if (el) el.textContent = text;
}

async function run() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const ts = Number(params.get("ts") || 0);
  const redirect = safeRedirect(params.get("redirect") || "/admin.html", "/admin.html");

  // Strip sensitive params from browser history, same as the billing app.
  window.history.replaceState(null, "", window.location.pathname);

  if (!token) return showError("No sign-in token was received. Please return to the portal and try again.");
  if (!Number.isFinite(ts) || ts === 0) return showError("Invalid sign-in link. Please return to the portal.");

  const now = Date.now();
  if (now - ts > MAX_AGE_MS) return showError("This sign-in link has expired. Please return to the portal.");
  if (ts - now > CLOCK_SKEW_MS) return showError("This sign-in link is not yet valid. Please check your system clock.");

  setStatus("Exchanging credentials…");

  try {
    const res = await fetch(EXCHANGE_FN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Exchange failed (${res.status})`);

    const { access_token, refresh_token } = data;
    if (!access_token || !refresh_token) throw new Error("The sign-in service returned an incomplete session.");

    setStatus("Setting up your workspace…");

    const { error: authErr } = await supabase.auth.setSession({ access_token, refresh_token });
    if (authErr) throw new Error(authErr.message);

    const { data: { session: confirmedSession } } = await supabase.auth.getSession();
    if (!confirmedSession) throw new Error("Session could not be confirmed. Please try signing in again.");

    window.location.replace(redirect);
  } catch (err) {
    showError(err.message || "Sign-in failed. Please return to the portal.");
  }
}

run();
