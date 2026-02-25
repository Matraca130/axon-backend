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
 *   - authenticate() decodes the JWT locally (~0.1ms, zero network).
 *   - Cryptographic signature validation is deferred to PostgREST/RLS on every DB query.
 *   - For admin-only routes (signup, institution creation), use getAdminClient().auth.getUser(token).
 */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js";
import type { Context } from "npm:hono";
import type { StatusCode } from "npm:hono/utils/http-status";

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

/**
 * Decode JWT payload locally — ~0.1ms, zero network.
 * Does NOT verify the cryptographic signature (PostgREST/RLS handles that).
 * Does check `exp` locally to fast-fail expired tokens before wasting a DB round-trip.
 */
const decodeJwtPayload = (
  token: string,
): { sub: string; email?: string; exp?: number } | null => {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    // Base64URL → Base64
    let base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");

    // Restore padding stripped by JWT spec. atob strictly requires length % 4 === 0.
    // A valid Base64 string never has remainder 1; only 0, 2, or 3 are possible.
    const pad = base64.length % 4;
    if (pad === 1) return null; // invalid Base64
    if (pad) base64 += "=".repeat(4 - pad);

    const json = atob(base64);
    const payload = JSON.parse(json);
    if (!payload.sub) return null;
    return payload;
  } catch {
    return null;
  }
};

/**
 * Authenticate the request: decode JWT locally → return { user, db }.
 * Returns an error Response if auth fails, so routes can early-return.
 *
 * Security model:
 *   - This function only extracts claims (id, email) for application logic.
 *   - The real cryptographic validation happens when `db` makes its first query:
 *     PostgREST verifies the JWT signature + expiration before any SQL executes.
 *   - For admin-only routes that need verified user metadata, use
 *     getAdminClient().auth.getUser(token) directly.
 *
 * ⚠️  CRITICAL WARNING — NON-DB ROUTES:
 *   If a route calls an external API (OpenAI, Stripe, etc.) using user.id WITHOUT
 *   making any Supabase DB query, the JWT is NEVER cryptographically validated.
 *   An attacker could forge a JWT and consume paid API credits.
 *   For such routes, ALWAYS either:
 *     (a) Do a canary DB query first (e.g. db.from('profiles').select('id').single())
 *     (b) Use getAdminClient().auth.getUser(token) to verify the token via network
 *     (c) [Phase 3] Use jose to verify the JWT signature locally with SUPABASE_JWT_SECRET
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
    return err(c, "Missing Authorization header", 401);
  }

  const payload = decodeJwtPayload(token);
  if (!payload) {
    return err(c, "Malformed or invalid JWT", 401);
  }

  // Fast-fail expired tokens locally (saves a wasted DB round-trip)
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    return err(c, "JWT has expired", 401);
  }

  const db = getUserClient(token);

  return {
    user: { id: payload.sub, email: payload.email ?? "" },
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
