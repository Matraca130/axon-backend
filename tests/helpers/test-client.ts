/**
 * tests/helpers/test-client.ts — Shared test utilities
 * Used by ALL integration tests. Provides login(), api helpers, ENV config.
 */

// ═══ ENV CONFIG ═══
export const ENV = {
  SUPABASE_URL: Deno.env.get("TEST_SUPABASE_URL") ?? "",
  ANON_KEY: Deno.env.get("TEST_SUPABASE_ANON_KEY") ?? "",
  USER_EMAIL: Deno.env.get("TEST_USER_EMAIL") ?? "",
  USER_PASSWORD: Deno.env.get("TEST_USER_PASSWORD") ?? "",
  ADMIN_EMAIL: Deno.env.get("TEST_ADMIN_EMAIL") ?? "",
  ADMIN_PASSWORD: Deno.env.get("TEST_ADMIN_PASSWORD") ?? "",
  INSTITUTION_ID: Deno.env.get("TEST_INSTITUTION_ID") ?? "",
};

export function apiBase(): string {
  return `${ENV.SUPABASE_URL}/functions/v1/server`;
}

// ═══ LOGIN HELPER ═══
interface LoginResponse {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string };
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  const res = await fetch(`${ENV.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ENV.ANON_KEY,
    },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Login failed for ${email}: ${res.status}`);
  return res.json();
}

// ═══ API CLIENT ═══
interface ApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  raw: T;
  error?: string;
}

async function request<T = unknown>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const url = `${apiBase()}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "apikey": ENV.ANON_KEY,
  };
  if (token) {
    headers["Authorization"] = `Bearer ${ENV.ANON_KEY}`;
    headers["X-Access-Token"] = token;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let raw: any;
  try { raw = await res.json(); } catch { raw = null; }

  return {
    status: res.status,
    ok: res.ok,
    raw: raw as T,
    error: raw?.error ?? raw?.message ?? undefined,
  };
}

export const api = {
  get: <T = unknown>(path: string, token: string) => request<T>("GET", path, token),
  post: <T = unknown>(path: string, token: string, body?: unknown) => request<T>("POST", path, token, body),
  put: <T = unknown>(path: string, token: string, body?: unknown) => request<T>("PUT", path, token, body),
  delete: <T = unknown>(path: string, token: string) => request<T>("DELETE", path, token),
};

// ═══ ASSERTION HELPERS ═══
export function assertStatus(r: ApiResponse, expected: number): void {
  if (r.status !== expected) {
    throw new Error(`Expected status ${expected}, got ${r.status}. Body: ${JSON.stringify(r.raw)}`);
  }
}

export function assertOk<T>(r: ApiResponse<T>): T {
  if (!r.ok) throw new Error(`Expected ok response, got ${r.status}: ${r.error}`);
  // CRITICAL: Backend ok() wraps responses in { data: ... } envelope.
  // Unwrap automatically so tests can access fields directly.
  const body = r.raw as any;
  return (body?.data !== undefined ? body.data : body) as T;
}

export function assertError(r: ApiResponse, expectedStatus: number): void {
  if (r.status !== expectedStatus) {
    throw new Error(`Expected error ${expectedStatus}, got ${r.status}`);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s: unknown): boolean {
  return typeof s === "string" && UUID_RE.test(s);
}
