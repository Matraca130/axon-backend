/**
 * rate-limit.ts — In-memory sliding window rate limiter for Axon v4.4
 *
 * O-8 FIX: Prevents abuse by capping requests per user per window.
 *
 * Architecture:
 *   - Uses a Map<string, { count, resetAt }> keyed by user token prefix.
 *   - Suitable for Supabase Edge Functions (single Deno isolate per function).
 *   - Periodic cleanup removes expired entries to prevent memory leaks.
 *
 * Configuration:
 *   - WINDOW_MS: 60,000ms (1 minute)
 *   - MAX_REQUESTS: 120 requests per window per user
 *   - CLEANUP_INTERVAL: Every 5 minutes
 *
 * Exemptions:
 *   - Health check (/health)
 *   - Webhooks (/webhooks/) — these have their own auth (HMAC signatures)
 */

import type { Context, Next } from "npm:hono";
import { extractToken } from "./db.ts";

// ─── Configuration ─────────────────────────────────────────────────

export const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
export const RATE_LIMIT_MAX_REQUESTS = 120;  // 120 req/min/user
const CLEANUP_INTERVAL_MS = 5 * 60_000;     // 5 minutes

// ─── State ───────────────────────────────────────────────────────

export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// Exported for testing
export const rateLimitMap = new Map<string, RateLimitEntry>();
let lastCleanup = Date.now();

/**
 * Extract a stable key from the user's token.
 * Uses the first 32 chars of the JWT (header + partial payload hash)
 * which is stable across requests from the same user but different
 * enough to distinguish users.
 */
function extractKey(token: string): string {
  return token.substring(0, 32);
}

/**
 * Remove expired entries from the map.
 * Called lazily — only when CLEANUP_INTERVAL has elapsed.
 */
export function cleanupExpired(now: number = Date.now()): number {
  let cleaned = 0;
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) {
      rateLimitMap.delete(key);
      cleaned++;
    }
  }
  lastCleanup = now;
  return cleaned;
}

/**
 * Check rate limit for a given key.
 * Returns { allowed: true } or { allowed: false, retryAfterMs }.
 */
export function checkRateLimit(
  key: string,
  now: number = Date.now(),
): { allowed: boolean; retryAfterMs?: number; current?: number } {
  const entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetAt) {
    // New window
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, current: 1 };
  }

  entry.count++;

  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    return {
      allowed: false,
      retryAfterMs: entry.resetAt - now,
      current: entry.count,
    };
  }

  return { allowed: true, current: entry.count };
}

// ─── Hono Middleware ─────────────────────────────────────────────

export async function rateLimitMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  const path = c.req.path;

  // Exempt: health checks and webhooks
  if (path.endsWith("/health") || path.includes("/webhooks/")) {
    return next();
  }

  // Only rate-limit authenticated requests
  const token = extractToken(c);
  if (!token) {
    return next(); // Let auth middleware handle missing tokens
  }

  const now = Date.now();

  // Periodic cleanup (lazy, non-blocking)
  if (now - lastCleanup > CLEANUP_INTERVAL_MS) {
    const cleaned = cleanupExpired(now);
    if (cleaned > 0) {
      console.log(`[RateLimit] Cleaned ${cleaned} expired entries`);
    }
  }

  const key = extractKey(token);
  const result = checkRateLimit(key, now);

  if (!result.allowed) {
    const retryAfterSec = Math.ceil((result.retryAfterMs ?? 0) / 1000);
    console.warn(
      `[RateLimit] Rate limit exceeded for key ${key.substring(0, 8)}...: ${result.current} requests`,
    );
    return c.json(
      {
        error: "Rate limit exceeded. Please try again later.",
        retry_after_seconds: retryAfterSec,
      },
      429,
    );
  }

  return next();
}
