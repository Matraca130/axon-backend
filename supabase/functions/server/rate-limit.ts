/**
 * rate-limit.ts — In-memory rate limiter for Axon v4.4
 *
 * Provides per-key request rate limiting using a fixed window counter.
 * Works within a single Deno isolate's lifetime.
 *
 * Limitations:
 *   - Not distributed: each Deno Deploy isolate has its own counter.
 *     This means the effective rate limit is `maxRequests * N_isolates`.
 *   - For production hardening, consider Deno KV or Redis backing.
 *   - Still effective against single-client burst abuse (the most
 *     common attack vector for signup/search endpoints).
 *
 * O-8 FIX: Rate limiting for critical routes.
 */

export interface RateLimitConfig {
  /** Maximum requests allowed in the window */
  maxRequests: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Periodic cleanup to prevent memory leaks (every 60 seconds)
let cleanupTimer: number | null = null;

function ensureCleanup(): void {
  if (cleanupTimer !== null) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetAt) {
        store.delete(key);
      }
    }
  }, 60_000);
  // Allow Deno to exit even if interval is running
  if (typeof Deno !== "undefined" && "unrefTimer" in Deno) {
    (Deno as any).unrefTimer(cleanupTimer);
  }
}

/**
 * Check rate limit for a given key.
 * Returns whether the request is allowed, remaining quota, and reset time.
 */
export function checkRateLimit(
  key: string,
  config: RateLimitConfig,
): RateLimitResult {
  ensureCleanup();
  const now = Date.now();
  const entry = store.get(key);

  // New window or expired window
  if (!entry || now > entry.resetAt) {
    const resetAt = now + config.windowMs;
    store.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: config.maxRequests - 1, resetAt };
  }

  // Within existing window — check limit
  if (entry.count >= config.maxRequests) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  // Within limit — increment
  entry.count++;
  return {
    allowed: true,
    remaining: config.maxRequests - entry.count,
    resetAt: entry.resetAt,
  };
}

/** Reset all rate limit state (for testing) */
export function resetRateLimitStore(): void {
  store.clear();
}
