/**
 * routes/mux/cors-origin.ts — FRONTEND_ORIGIN validation for Mux uploads.
 *
 * Exposed as a pure helper so the validation rules can be unit-tested
 * without mocking the Mux API or Supabase admin client.
 *
 * The rules here exist to prevent silently re-introducing the
 * `cors_origin: "*"` wildcard-leak (issue #270) via misconfigured
 * env vars. A typo like FRONTEND_ORIGIN="*" or a scheme-less host
 * would otherwise ship straight to Mux.
 */

export type CorsOriginValidation =
  | { ok: true; origin: string }
  | { ok: false; reason: "missing" | "invalid_url" | "bad_shape"; value: string };

/**
 * Validate a value intended to be sent to Mux as `cors_origin`.
 *
 * Accepts: "https://app.example.com", "http://localhost:5173"
 * Rejects: missing/empty, "*", "app.example.com" (no scheme),
 *          "https://app.example.com/" (trailing slash),
 *          "https://*.example.com" (wildcard).
 */
export function validateCorsOrigin(raw: string | undefined | null): CorsOriginValidation {
  if (!raw) {
    return { ok: false, reason: "missing", value: "" };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url", value: raw };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "bad_shape", value: raw };
  }
  // parsed.origin strips trailing slash + path + query + fragment, so if the
  // caller included any of those, the comparison fails.
  if (parsed.origin !== raw) {
    return { ok: false, reason: "bad_shape", value: raw };
  }
  if (raw.includes("*")) {
    return { ok: false, reason: "bad_shape", value: raw };
  }
  return { ok: true, origin: raw };
}
