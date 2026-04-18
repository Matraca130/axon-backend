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
 *   - RL-300: Bumped MAX_REQUESTS 120 → 300. The Smart Reader page
 *         alone fires ~9 GETs in parallel on every summary load
 *         (block-bookmarks, summary-blocks, chunks, keywords,
 *         block-mastery, videos, text-annotations, sticky-notes,
 *         reading-states), and a normal study session triggers
 *         several reading-state PATCHes per minute. With the old
 *         120/min cap, two summary loads + a chat exchange would
 *         trip the limiter and surface "Limite de solicitudes de
 *         IA excedido" to the user despite no abuse. 300 gives
 *         5x headroom for the chat path while staying conservative
 *         enough to detect a runaway client.
 *
 * Architecture:
 *   - Primary: In-memory Map (per-isolate, ~0ms overhead).
 *   - Trade-off: Each Deno isolate has its own counter. A user hitting
 *     N isolates gets up to N × MAX_REQUESTS per window. At Axon's
 *     scale (~1-2 isolates), this is 300-600 req/min — acceptable.
 *
 * Configuration:
 *   - WINDOW_MS: 60,000ms (1 minute)
 *   - MAX_REQUESTS: 300 requests per window per user
 *
 * Exemptions:
 *   - Health check (/health)
 *   - Webhooks (/webhooks/) — these have their own auth (HMAC signatures)
 */

import type { Context, Next } from "npm:hono";
// extractToken import removed — no longer used for rate-limit keying (SEC fix)

// ─── Configuration ─────────────────────────────────────────────────

export const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
export const RATE_LIMIT_MAX_REQUESTS = 300;  // 300 req/min/user

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
 * Extract a rate-limit key from a client IP address.
 *
 * SEC: Previously extracted `sub` from JWT payload via atob() without
 * signature verification (C-1 FIX). An attacker could forge a JWT with
 * any `sub` to hijack another user's rate-limit bucket or spread
 * requests across fake buckets. Now uses only IP for pre-auth keying.
 * Post-auth rate limiting (e.g. AI routes) should use the verified
 * user ID from authenticate().
 *
 * @deprecated extractKey(token) is no longer used. Kept for backward
 * compatibility with any external callers during transition.
 */
export function extractKey(token: string): string {
  // Return a signature-based key as a safe fallback if anyone still calls this.
  const lastDot = token.lastIndexOf(".");
  if (lastDot !== -1 && lastDot < token.length - 1) {
    const sig = token.substring(lastDot + 1);
    return `sig:${sig.substring(0, 32)}`;
  }
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

export function checkRateLimitLocal(
  key: string,
  now: number = Date.now(),
): { allowed: boolean; retryAfterMs?: number; current?: number } {
  const entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetAt) {
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

  // SEC: Always use client IP for pre-auth rate limiting. The previous
  // approach decoded JWT sub via atob() without signature verification,
  // allowing bucket hijacking. Post-auth rate limiting (e.g. AI routes)
  // uses the verified user ID from authenticate().
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    || c.req.header("x-real-ip")
    || "unknown";
  const key = `ip:${ip}`;
  const now = Date.now();

  // Periodic cleanup of expired entries
  if (now - lastCleanup > CLEANUP_INTERVAL_MS) {
    const cleaned = cleanupExpired(now);
    if (cleaned > 0) {
      console.warn(`[RateLimit] Cleaned ${cleaned} expired entries`);
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
