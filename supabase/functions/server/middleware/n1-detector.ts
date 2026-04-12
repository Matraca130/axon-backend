/**
 * n1-detector.ts — N+1 query pattern detector middleware for Axon
 *
 * Detects suspected N+1 patterns by tracking identical requests from the same user
 * within a rolling 10-second window. When the threshold is exceeded, logs a structured
 * warning for observability and alerting.
 *
 * DESIGN:
 *   - In-memory Map keyed by ${user_id}|${pathTemplate}
 *   - Each entry: { timestamps: number[] } — ring buffer of request timestamps
 *   - Threshold: >=10 identical path requests from same user in 10s window
 *   - Path normalization: UUIDs and numeric IDs → :id
 *   - LRU eviction: cap at ~1000 entries, drop oldest when full
 *   - CAVEAT: Edge function cold starts wipe the map (stateless by nature)
 *
 * ENVIRONMENT:
 *   - N1_DETECTOR_ENABLED=1 — enable the detector (default: disabled for backwards compat)
 *
 * USAGE:
 *   Wire into main Hono app after authenticate() middleware:
 *     app.use("*", authenticate); // or similar
 *     app.use("*", n1DetectorMiddleware);
 *     app.route("/", routes...);
 *
 * Observable via:
 *   - console.warn("[n1-detected]", {...}) in Supabase Edge Logs
 *   - getN1Stats() — returns detection count + watched keys for /healthz endpoint
 */

import type { Context, Next } from "npm:hono";

// ─── Configuration ────────────────────────────────────────────────────
const WINDOW_MS = 10_000; // 10-second rolling window
const THRESHOLD = 10; // trigger warning at >= 10 requests
const MAX_WATCHED_KEYS = 1000; // cap map size to prevent unbounded growth
const ENABLED = Deno.env.get("N1_DETECTOR_ENABLED") === "1";

// ─── Global State ────────────────────────────────────────────────────
// Map<key, { timestamps: number[] }>
// key format: "${user_id}|${pathTemplate}"
const watchedRequests = new Map<string, number[]>();
let detectionCount = 0;

// ─── Path Normalization ────────────────────────────────────────────────
// Pre-compile regex for path normalization (reuse across all requests).
// Replaces UUID segments and numeric IDs with :id placeholder.
const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NUMERIC_ID_REGEX = /\/\d+(?=\/|$)/g;

/**
 * Normalize a path by replacing UUIDs and numeric IDs with :id.
 * Example: /summaries/550e8400-e29b-41d4-a716-446655440000 → /summaries/:id
 * Example: /keywords/12/connections/34 → /keywords/:id/connections/:id
 */
function normalizePathTemplate(path: string): string {
  return path
    .replace(UUID_REGEX, ":id")
    .replace(NUMERIC_ID_REGEX, "/:id");
}

/**
 * Detect if the request should be tracked.
 * Condition: path is authentication-related or health checks are exempt.
 */
function shouldTrack(path: string): boolean {
  // Exempt these patterns to reduce noise
  const EXEMPT_PATTERNS = [/^\/server\/health/, /^\/auth\//, /^\/server\/auth\//];
  return !EXEMPT_PATTERNS.some((p) => p.test(path));
}

/**
 * Track a request and return true if N+1 threshold is crossed.
 */
function trackRequest(userId: string, pathTemplate: string): boolean {
  if (!userId) return false;

  const key = `${userId}|${pathTemplate}`;
  const now = Date.now();

  // Retrieve or create ring buffer for this key
  let timestamps = watchedRequests.get(key) ?? [];

  // Filter out timestamps older than WINDOW_MS
  timestamps = timestamps.filter((t) => now - t < WINDOW_MS);

  // Add current request
  timestamps.push(now);

  // Check if we've hit the threshold
  const isDetected = timestamps.length >= THRESHOLD;

  // Update map
  watchedRequests.set(key, timestamps);

  // LRU eviction: if map grows beyond MAX_WATCHED_KEYS, drop oldest entry
  if (watchedRequests.size > MAX_WATCHED_KEYS) {
    const firstKey = watchedRequests.keys().next().value;
    if (firstKey) watchedRequests.delete(firstKey);
  }

  return isDetected;
}

/**
 * Middleware factory — returns Hono middleware function.
 * Extracts user ID from JWT token (Authorization or X-Access-Token header).
 * Must be async to support JWT verification.
 *
 * CAVEAT: Due to edge function statelessness, this extracts the sub claim without
 * full verification (to avoid the costly jose verification on every request).
 * Full verification happens per-route in authenticate().
 */
export async function n1DetectorMiddleware(c: Context, next: any): Promise<void> {
  // Skip if disabled
  if (!ENABLED) {
    return next();
  }

  // Extract token from request
  const token = c.req.header("X-Access-Token") || (() => {
    const auth = c.req.header("Authorization");
    return auth?.startsWith("Bearer ") ? auth.split(" ")[1] : null;
  })();

  if (!token) {
    return next(); // Skip if no token (unauthenticated route)
  }

  // Parse JWT payload WITHOUT verification (fast path).
  // The sub claim (user_id) is in the signed payload.
  // Full verification happens in authenticate() per-route.
  let userId: string | null = null;
  try {
    // JWT format: header.payload.signature
    const parts = token.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(atob(parts[1]));
      userId = payload.sub;
    }
  } catch {
    // Malformed token — skip tracking
    return next();
  }

  if (!userId) return next(); // Skip if no user context

  const path = c.req.path;
  if (!shouldTrack(path)) return next();

  const pathTemplate = normalizePathTemplate(path);

  // Track request and check if threshold crossed
  if (trackRequest(userId, pathTemplate)) {
    detectionCount++;
    const count = (watchedRequests.get(`${userId}|${pathTemplate}`) || []).length;
    const sampleIds = watchedRequests
      .entries()
      .filter(([k]) => k.startsWith(`${userId}|`))
      .map(([k]) => k.split("|")[1])
      .slice(0, 3);

    console.warn("[n1-detected]", {
      user_id: userId,
      path: pathTemplate,
      count,
      window_ms: WINDOW_MS,
      threshold: THRESHOLD,
      sample_paths: sampleIds,
    });
  }

  return next();
}

/**
 * Observable stats for health check or monitoring endpoints.
 * Returns detection count and number of actively watched keys.
 */
export function getN1Stats(): { detections: number; watchedKeys: number } {
  return {
    detections: detectionCount,
    watchedKeys: watchedRequests.size,
  };
}

/**
 * Reset stats (useful for tests).
 */
export function resetN1Stats(): void {
  detectionCount = 0;
  watchedRequests.clear();
}
