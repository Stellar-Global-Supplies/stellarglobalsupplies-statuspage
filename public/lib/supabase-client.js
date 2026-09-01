// Loaded as a module. Exposes a single shared Supabase client on
// window.supabaseClient, the same pattern the billing/orders frontend
// uses via utils/supabase.js — just without a bundler, since this app
// is plain static HTML/JS served straight from the Worker.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.__ENV__ || {};

if (!SUPABASE_URL || SUPABASE_URL.includes("YOUR-PROJECT")) {
  console.warn("config.js: SUPABASE_URL / SUPABASE_ANON_KEY are not set yet.");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

window.supabaseClient = supabase;
