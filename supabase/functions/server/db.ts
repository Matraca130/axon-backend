/**
 * db.ts — Supabase client helpers for Axon v4.4
 *
 * Environment: Supabase Edge Functions (Deno) + Hono
 * Variables are read from Deno.env (not Hono Bindings).
 *
 * Two client types:
 *   - getAdminClient()    → SERVICE_ROLE_KEY, bypasses RLS. Lazy singleton.
 *   - getUserClient(jwt)  → ANON_KEY + user JWT, respects RLS. Per-request, zero background timers.
 *
 * Auth strategy:
 *   - authenticate() verifies the JWT cryptographically via jose + JWKS (~0.3ms after cache warm).
 *   - JWT signature is verified via jose ES256 (P-256 JWKS). PostgREST verifies again on DB queries (defense-in-depth).
 *   - For admin-only routes (signup, institution creation), use getAdminClient().auth.getUser(token).
 */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js";
import type { Context } from "npm:hono";
import type { StatusCode } from "npm:hono/utils/http-status";
import { jwtVerify, createRemoteJWKSet, errors as joseErrors } from "https://deno.land/x/jose@v5.9.6/index.ts";

// ─── Environment Validation (fail fast on cold start) ─────────────────
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  const missing = [
    !SUPABASE_URL && "SUPABASE_URL",
    !SUPABASE_ANON_KEY && "SUPABASE_ANON_KEY",
    !SUPABASE_SERVICE_ROLE_KEY && "SUPABASE_SERVICE_ROLE_KEY",
  ].filter(Boolean).join(", ");
  throw new Error(`[Axon Fatal] Missing required env vars: ${missing}`);
}

// ── JWKS for jose verification (D2 — ES256/P-256) ──────────────────
// Supabase signs JWTs with ES256 (P-256). We verify using the public JWKS endpoint.
// createRemoteJWKSet caches keys in-memory and auto-refreshes on key rotation.
const JWKS_URL = new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
const JWKS = createRemoteJWKSet(JWKS_URL);

// ─── Route Prefix ─────────────────────────────────────────────────────
/**
 * Empty for production (Supabase Edge Functions handle routing).
 * Set to "/make-server-6569f786" for Figma Make development environment.
 */
export const PREFIX = "/server";

// ─── Client Factories ────────────────────────────────────────────────

/**
 * Admin client — bypasses RLS. Use sparingly (signup, institution ops).
 * Lazy singleton: created once on first call, reused for all warm invocations.
 */
let _adminClient: SupabaseClient | null = null;

export const getAdminClient = (): SupabaseClient => {
  if (!_adminClient) {
    _adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  }
  return _adminClient;
};

/**
 * User client — respects RLS via the user's JWT. Created per request.
 * All background Auth features are disabled to prevent memory leaks in Edge:
 *   - persistSession: false  → no localStorage (doesn't exist in Deno)
 *   - autoRefreshToken: false → no setInterval timer accumulating per request
 *   - detectSessionInUrl: false → no URL hash listener (irrelevant server-side)
 */
export const getUserClient = (accessToken: string): SupabaseClient => {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
};

// ─── Auth Helpers ─────────────────────────────────────────────────────

/** Extract user JWT from the request.
 * Priority: X-Access-Token header (Figma Make) → Authorization Bearer (production).
 * Figma Make's gateway reserves Authorization for the publicAnonKey,
 * so authenticated routes send the user JWT via X-Access-Token instead.
 */
export const extractToken = (c: Context): string | null => {
  // Figma Make: user JWT in custom header
  const custom = c.req.header("X-Access-Token");
  if (custom) return custom;

  // Production: user JWT in Authorization header
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.split(" ")[1];
};

/** Auth error with structured response (DECISIONS.md D2 #2) */
function authErr(c: Context, code: string, message: string, status: 401 | 403 | 503 = 401): Response {
  return c.json({ error: code, message, source: "jose_middleware" }, status);
}

/** Verified JWT payload */
interface VerifiedPayload {
  sub: string;
  email?: string;
  exp?: number;
  aud?: string;
}

/**
 * Verify JWT cryptographically using jose (D2).
 * Checks: ES256 signature via JWKS, expiration, audience = "authenticated".
 * JWKS keys are cached in-memory by jose (~0.3ms after first fetch).
 * Returns verified payload or structured error.
 */
async function verifyJwt(token: string): Promise<VerifiedPayload | { error: string; status: 401 | 503 }> {
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      audience: "authenticated",
    });

    if (!payload.sub || typeof payload.sub !== "string") {
      return { error: "jwt_missing_sub", status: 401 };
    }

    return {
      sub: payload.sub,
      email: payload.email as string | undefined,
      exp: payload.exp,
      aud: payload.aud as string | undefined,
    };
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) {
      return { error: "jwt_expired", status: 401 };
    }
    if (e instanceof joseErrors.JWTClaimValidationFailed) {
      return { error: "jwt_claim_invalid", status: 401 };
    }
    if (e instanceof joseErrors.JWSSignatureVerificationFailed) {
      return { error: "jwt_signature_invalid", status: 401 };
    }
    return { error: "jwt_verification_failed", status: 401 };
  }
}

/**
 * Authenticate the request: verify JWT with jose → return { user, db }.
 * Returns an error Response if auth fails, so routes can early-return.
 *
 * Security model (D2 — jose verification):
 *   - JWT signature is cryptographically verified via ES256 JWKS (jose).
 *   - Audience "authenticated" is enforced, preventing cross-project JWT abuse.
 *   - Expiration is verified by jose (no manual check needed).
 *   - PostgREST still verifies independently on every DB query (defense-in-depth).
 *
 * Usage:
 *   const auth = await authenticate(c);
 *   if (auth instanceof Response) return auth;
 *   const { user, db } = auth;
 */
export const authenticate = async (
  c: Context,
): Promise<
  { user: { id: string; email: string }; db: SupabaseClient } | Response
> => {
  const token = extractToken(c);
  if (!token) {
    return authErr(c, "missing_token", "Missing Authorization header", 401);
  }

  const result = await verifyJwt(token);

  if ("error" in result) {
    return authErr(c, result.error, result.error, result.status);
  }

  const db = getUserClient(token);

  return {
    user: { id: result.sub, email: result.email ?? "" },
    db,
  };
};

// ─── Response Helpers ─────────────────────────────────────────────────

/** Safe JSON body parser — returns null instead of throwing SyntaxError on bad input */
export const safeJson = async (c: Context): Promise<Record<string, unknown> | null> => {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
};

/** Standard success response */
export const ok = <T = unknown>(c: Context, data: T, status: StatusCode = 200) => {
  return c.json({ data }, status);
};

/** Standard error response with logging */
export const err = (c: Context, message: string, status: StatusCode = 400) => {
  console.error(`[Axon Error] ${message}`);
  return c.json({ error: message }, status);
};
