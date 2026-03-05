/**
 * tests/helpers/test-client.ts — HTTP + Auth helper for integration tests
 *
 * Provides:
 *   - login()  → authenticate via Supabase Auth REST API, returns JWT
 *   - api.*    → typed HTTP methods (get, post, patch) against Edge Functions
 *
 * Environment variables (from GitHub Secrets):
 *   TEST_SUPABASE_URL       — e.g. https://xxx.supabase.co
 *   TEST_SUPABASE_ANON_KEY  — public anon key
 *   TEST_USER_EMAIL         — student/teacher with active membership
 *   TEST_USER_PASSWORD
 *   TEST_ADMIN_EMAIL        — admin/owner in the same institution
 *   TEST_ADMIN_PASSWORD
 *   TEST_INSTITUTION_ID     — UUID of test institution
 */

// ─── Environment ────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const ENV = {
  get SUPABASE_URL() { return requireEnv("TEST_SUPABASE_URL"); },
  get ANON_KEY() { return requireEnv("TEST_SUPABASE_ANON_KEY"); },
  get USER_EMAIL() { return requireEnv("TEST_USER_EMAIL"); },
  get USER_PASSWORD() { return requireEnv("TEST_USER_PASSWORD"); },
  get ADMIN_EMAIL() { return requireEnv("TEST_ADMIN_EMAIL"); },
  get ADMIN_PASSWORD() { return requireEnv("TEST_ADMIN_PASSWORD"); },
  get INSTITUTION_ID() { return requireEnv("TEST_INSTITUTION_ID"); },
};

/** Base URL for Edge Function routes: https://xxx.supabase.co/functions/v1/server */
export function apiBase(): string {
  return `${ENV.SUPABASE_URL}/functions/v1/server`;
}

// ─── Auth ───────────────────────────────────────────────────────────

interface LoginResult {
  access_token: string;
  user: { id: string; email: string };
}

/**
 * Login via Supabase Auth REST API.
 * Returns the JWT access_token + user metadata.
 */
export async function login(email: string, password: string): Promise<LoginResult> {
  const res = await fetch(
    `${ENV.SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        "apikey": ENV.ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Login failed for ${email}: ${res.status} ${body}`);
  }

  const data = await res.json();
  return {
    access_token: data.access_token,
    user: { id: data.user.id, email: data.user.email },
  };
}

// ─── HTTP Client ────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  data?: T;
  error?: string;
  raw: Record<string, unknown>;
}

async function request<T = unknown>(
  method: string,
  path: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<ApiResponse<T>> {
  const url = `${apiBase()}${path}`;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "apikey": ENV.ANON_KEY,
  };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await res.json();
  return {
    status: res.status,
    ok: res.ok,
    data: raw.data as T,
    error: raw.error as string | undefined,
    raw,
  };
}

export const api = {
  get: <T = unknown>(path: string, token: string) =>
    request<T>("GET", path, token),

  post: <T = unknown>(path: string, token: string, body: Record<string, unknown>) =>
    request<T>("POST", path, token, body),

  patch: <T = unknown>(path: string, token: string, body: Record<string, unknown>) =>
    request<T>("PATCH", path, token, body),
};

// ─── Assertion Helpers ──────────────────────────────────────────────

import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";

/** Assert response status code */
export function assertStatus(res: ApiResponse, expected: number, msg?: string) {
  assertEquals(
    res.status,
    expected,
    msg || `Expected status ${expected}, got ${res.status}. Error: ${res.error || JSON.stringify(res.raw)}`,
  );
}

/** Assert response has data (not error) */
export function assertOk<T>(res: ApiResponse<T>, msg?: string): T {
  assert(res.ok, msg || `Expected OK response, got ${res.status}: ${res.error}`);
  assert(res.data !== undefined, msg || "Expected data in response");
  return res.data!;
}

/** Assert response is an error with specific status */
export function assertError(res: ApiResponse, expectedStatus: number, msg?: string) {
  assertStatus(res, expectedStatus, msg);
  assert(!res.ok, msg || `Expected error response, got OK`);
}

/** Validate UUID format */
export function isUuid(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
