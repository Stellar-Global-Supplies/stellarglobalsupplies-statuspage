import { jwtVerify, createRemoteJWKSet, decodeProtectedHeader } from "jose";
import { unauthorized, json } from "./utils.js";

// The billing/orders frontend logs users in via Casdoor SSO through the
// central portal; the sso-exchange Edge Function verifies that Casdoor
// token server-side, then mints a real Supabase session and hands the
// browser a Supabase access_token/refresh_token via supabase.auth.setSession().
// From then on, every call to our API carries THAT Supabase-issued token as:
//   Authorization: Bearer <supabase access_token>
// We never see the Casdoor token — only Supabase's own JWT — so we verify
// it as a Supabase JWT.
//
// Supabase signs these one of two ways depending on the project:
//   - legacy: HS256 with a single shared "JWT Secret"
//   - newer:  RS256/ES256 with rotating Signing Keys, published as JWKS
// Rather than assume, we read the token's own header and verify with
// whichever method matches — same approach the sso-exchange function uses
// for Casdoor's JWKS.

function bearerToken(request) {
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

let cachedJwks = null;
function getRemoteJwks(env) {
  if (!cachedJwks) {
    if (!env.SUPABASE_URL) throw new Error("SUPABASE_URL is not configured");
    cachedJwks = createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
  }
  return cachedJwks;
}

export async function verifySupabaseToken(request, env) {
  const token = bearerToken(request);
  if (!token) return null;

  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return null;
  }

  try {
    let payload;

    if (header.alg === "HS256") {
      if (!env.SUPABASE_JWT_SECRET) {
        throw new Error("SUPABASE_JWT_SECRET secrets-store binding is not configured");
      }
      const secretValue = await env.SUPABASE_JWT_SECRET.get();
      const secretKey = new TextEncoder().encode(secretValue);
      ({ payload } = await jwtVerify(token, secretKey, { audience: "authenticated" }));
    } else {
      // RS256 / ES256 (or anything else) -> verify against Supabase's JWKS.
      const jwks = getRemoteJwks(env);
      ({ payload } = await jwtVerify(token, jwks, { audience: "authenticated" }));
    }

    return {
      uid: payload.sub,
      email: payload.email || payload.user_metadata?.email || null,
      role: payload.role || payload.app_metadata?.role || null,
      raw: payload,
    };
  } catch {
    return null;
  }
}

// Use on every /api/admin/* route. Returns { user } on success or
// { error: Response } to return directly. Anyone who successfully signs
// in through the portal's SSO flow is trusted as an admin here — Casdoor
// (behind the portal) is the access-control boundary, not this app.
export async function requireAuth(request, env) {
  let user;
  try {
    user = await verifySupabaseToken(request, env);
  } catch (e) {
    return { error: json({ error: e.message }, { status: 500 }) };
  }
  if (!user) return { error: unauthorized() };
  return { user };
}