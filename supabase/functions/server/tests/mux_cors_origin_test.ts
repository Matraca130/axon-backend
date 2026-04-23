/**
 * Tests for routes/mux/cors-origin.ts
 *
 * Covers the FRONTEND_ORIGIN shape validation added as a follow-up
 * to PR #333 (issue #270). The review flagged that "!frontendOrigin"
 * alone was too permissive — a typo'd FRONTEND_ORIGIN="*" or a
 * scheme-less host would otherwise ship straight to Mux and silently
 * reintroduce the wildcard-leak vulnerability.
 *
 * Run: deno test supabase/functions/server/tests/mux_cors_origin_test.ts
 */

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { validateCorsOrigin } from "../routes/mux/cors-origin.ts";

// ─── accepts ─────────────────────────────────────────────

Deno.test("validateCorsOrigin: accepts bare https origin", () => {
  const r = validateCorsOrigin("https://app.example.com");
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.origin, "https://app.example.com");
});

Deno.test("validateCorsOrigin: accepts http with port (dev)", () => {
  const r = validateCorsOrigin("http://localhost:5173");
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.origin, "http://localhost:5173");
});

Deno.test("validateCorsOrigin: accepts https with port", () => {
  const r = validateCorsOrigin("https://staging.example.com:8443");
  assertEquals(r.ok, true);
});

// ─── rejects (missing) ───────────────────────────────────

Deno.test("validateCorsOrigin: rejects undefined", () => {
  const r = validateCorsOrigin(undefined);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "missing");
});

Deno.test("validateCorsOrigin: rejects null", () => {
  const r = validateCorsOrigin(null);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "missing");
});

Deno.test("validateCorsOrigin: rejects empty string", () => {
  const r = validateCorsOrigin("");
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "missing");
});

// ─── rejects (invalid_url) ───────────────────────────────

Deno.test("validateCorsOrigin: rejects plain '*'", () => {
  const r = validateCorsOrigin("*");
  assertEquals(r.ok, false);
  // Note: "*" is not a valid URL → invalid_url (not bad_shape)
  if (!r.ok) assert(r.reason === "invalid_url" || r.reason === "bad_shape");
});

Deno.test("validateCorsOrigin: rejects scheme-less host", () => {
  const r = validateCorsOrigin("app.example.com");
  assertEquals(r.ok, false);
  if (!r.ok) assert(r.reason === "invalid_url" || r.reason === "bad_shape");
});

// ─── rejects (bad_shape) ─────────────────────────────────

Deno.test("validateCorsOrigin: rejects trailing slash", () => {
  const r = validateCorsOrigin("https://app.example.com/");
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "bad_shape");
});

Deno.test("validateCorsOrigin: rejects URL with path", () => {
  const r = validateCorsOrigin("https://app.example.com/upload");
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "bad_shape");
});

Deno.test("validateCorsOrigin: rejects URL with query", () => {
  const r = validateCorsOrigin("https://app.example.com?debug=1");
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "bad_shape");
});

Deno.test("validateCorsOrigin: rejects URL with embedded wildcard", () => {
  const r = validateCorsOrigin("https://*.example.com");
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "bad_shape");
});

Deno.test("validateCorsOrigin: rejects non-http(s) schemes", () => {
  // ftp, ws, data, file — anything other than http/https
  for (const bad of ["ftp://example.com", "ws://example.com", "file:///etc/passwd"]) {
    const r = validateCorsOrigin(bad);
    assertEquals(r.ok, false, `expected rejection for "${bad}"`);
    if (!r.ok) assertEquals(r.reason, "bad_shape");
  }
});

Deno.test("validateCorsOrigin: rejects javascript: scheme", () => {
  const r = validateCorsOrigin("javascript:alert(1)");
  assertEquals(r.ok, false);
});
