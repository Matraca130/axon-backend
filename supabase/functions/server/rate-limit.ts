/**
 * rate-limit.ts — In-memory rate limiter for Axon v4.4
 *
 * B1 FIX: Switched from distributed-first (PostgreSQL RPC per request)
 *         to in-memory-first (Map lookup, 0 latency).
 *
 * History:
 *   - S-2: Original in-memory Map implementation.
 *   - C-1: Fixed key extraction (JWT `sub` instead of shared header).
 *   - S-2b: Added distributed PostgreSQL RPC as primary.
 *   - B1: Reverted to in-memory-first. The distributed approach added
 *         ~2-5ms latency per request for cross-isolate accuracy that
 *         Axon's current scale doesn't require. The DB table and RPC
 *         remain in PostgreSQL but are no longer called.
 *
 * Architecture:
 *   - Primary: In-memory Map (per-isolate, ~0ms overhead).
 *   - Trade-off: Each Deno isolate has its own counter. A user hitting
 *     N isolates gets up to N × MAX_REQUESTS per window. At Axon's
 *     scale (~1-2 isolates), this is 120-240 req/min — acceptable.
 *
 * Configuration:
 *   - WINDOW_MS: 60,000ms (1 minute)
 *   - MAX_REQUESTS: 120 requests per window per user
 *
 * Exemptions:
 *   - Health check (/health)
 *   - Webhooks (/webhooks/) — these have their own auth (HMAC signatures)
 */

import type { Context, Next } from "npm:hono";
import { extractToken, decodeJwtPayload } from "./db.ts";

// ─── Configuration ─────────────────────────────────────────────────

export const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
export const RATE_LIMIT_MAX_REQUESTS = 120;  // 120 req/min/user

// ─── In-Memory State ────────────────────────────────────────────

export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export const rateLimitMap = new Map<string, RateLimitEntry>();
let lastCleanup = Date.now();
const CLEANUP_INTERVAL_MS = 5 * 60_000;

// ─── Key Extraction ─────────────────────────────────────────────

/**
 * Extract a stable per-user key from the JWT token.
 *
 * C-1 FIX: The old implementation used token.substring(0, 32) which
 * returned the JWT header — identical for ALL Supabase HS256 tokens.
 * All users shared one 120 req/min bucket.
 *
 * Strategy:
 *   1. Primary: Decode JWT payload → extract `sub` (user UUID).
 *   2. Fallback: JWT signature (last segment), unique per token.
 *
 * Prefixes (uid:/sig:) prevent collisions between strategies.
 */
export function extractKey(token: string): string {
  // ── Primary: decode JWT payload and use `sub` (user UUID) ──
  // L2 FIX: Reuses decodeJwtPayload from db.ts instead of duplicating JWT decoding logic
  const payload = decodeJwtPayload(token);
  if (payload && typeof payload.sub === "string" && payload.sub.length > 0) {
    return `uid:${payload.sub}`;
  }

  // ── Fallback: use JWT signature (unique per token issuance) ──
  const lastDot = token.lastIndexOf(".");
  if (lastDot !== -1 && lastDot < token.length - 1) {
    const sig = token.substring(lastDot + 1);
    return `sig:${sig.substring(0, 32)}`;
  }

  // ── Last resort ──
  return `raw:${token.substring(Math.max(0, token.length - 32))}`;
}

// ─── Rate Limit Check ───────────────────────────────────────────

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

// L1 FIX: Max size bound to prevent unbounded memory growth
const RATE_LIMIT_MAP_MAX_SIZE = 10_000;

export function checkRateLimitLocal(
  key: string,
  now: number = Date.now(),
): { allowed: boolean; retryAfterMs?: number; current?: number } {
  const entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetAt) {
    // L1 FIX: Evict expired entries if map is at capacity before adding new key
    if (!entry && rateLimitMap.size >= RATE_LIMIT_MAP_MAX_SIZE) {
      cleanupExpired(now);
      // If still at capacity after cleanup, allow request but don't track it
      if (rateLimitMap.size >= RATE_LIMIT_MAP_MAX_SIZE) {
        console.warn(`[RateLimit] Map at max capacity (${RATE_LIMIT_MAP_MAX_SIZE}), skipping tracking`);
        return { allowed: true, current: 0 };
      }
    }
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

/**
 * Backward-compatible alias.
 * @deprecated Use checkRateLimitLocal instead.
 */
export const checkRateLimit = checkRateLimitLocal;

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
    return next();
  }

  const key = extractKey(token);
  const now = Date.now();

  // Periodic cleanup of expired entries
  if (now - lastCleanup > CLEANUP_INTERVAL_MS) {
    const cleaned = cleanupExpired(now);
    if (cleaned > 0) {
      console.log(`[RateLimit] Cleaned ${cleaned} expired entries`);
    }
  }

  const result = checkRateLimitLocal(key, now);

  if (!result.allowed) {
    const retryAfterSec = Math.ceil((result.retryAfterMs ?? 0) / 1000);
    console.warn(
      `[RateLimit] Exceeded for key ${key.substring(0, 12)}...: ${result.current} requests`,
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
