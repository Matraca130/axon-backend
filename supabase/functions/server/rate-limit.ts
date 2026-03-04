/**
 * rate-limit.ts — Distributed rate limiter for Axon v4.4
 *
 * S-2 FIX: Replaced in-memory Map with PostgreSQL-backed rate limiting.
 * C-1 FIX: Rate limit key now uses JWT `sub` (user UUID) instead of
 *          the first 32 chars of the token header (which was identical
 *          for all users, causing a shared global bucket).
 *
 * Architecture:
 *   - Primary: Uses check_rate_limit() RPC in PostgreSQL (shared across all isolates).
 *   - Fallback: In-memory Map if the RPC is unavailable (migration not applied yet).
 *   - Key: JWT `sub` claim (user UUID), with fallback to JWT signature.
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
import { extractToken, getAdminClient } from "./db.ts";

// ─── Configuration ─────────────────────────────────────────────────

export const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
export const RATE_LIMIT_MAX_REQUESTS = 120;  // 120 req/min/user

// ─── Fallback: In-Memory State (used if DB RPC is unavailable) ───

export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export const rateLimitMap = new Map<string, RateLimitEntry>();
let lastCleanup = Date.now();
const CLEANUP_INTERVAL_MS = 5 * 60_000;

// Track whether DB-backed rate limiting is available
let useDistributed = true;
let distributedFailCount = 0;
const MAX_DISTRIBUTED_FAILURES = 5; // After 5 consecutive failures, fall back permanently for this isolate

// ─── Key Extraction ─────────────────────────────────────────────

/**
 * Extract a stable per-user key from the JWT token.
 *
 * C-1 FIX: The old implementation used token.substring(0, 32) which
 * returned the JWT header — identical for ALL Supabase HS256 tokens.
 * All users shared one 120 req/min bucket.
 *
 * New approach:
 *   1. Primary: Decode JWT payload → extract `sub` (user UUID).
 *      This is the correct semantic key: rate limit is per-USER.
 *      Survives token refresh (same user = same key).
 *      Cost: ~0.1ms (same as authenticate() in db.ts).
 *
 *   2. Fallback: If decode fails, use the JWT signature (last segment).
 *      The signature is unique per token issuance.
 *      Less ideal (resets on refresh) but still per-token, not global.
 *
 * Prefixes (uid:/sig:) prevent collisions between strategies.
 */
export function extractKey(token: string): string {
  // ── Primary: decode JWT payload and use `sub` (user UUID) ──
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      // Base64URL → Base64
      let base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");

      // Restore padding (JWT spec strips it)
      const pad = base64.length % 4;
      if (pad === 1) throw new Error("invalid base64"); // impossible in valid Base64
      if (pad) base64 += "=".repeat(4 - pad);

      const payload = JSON.parse(atob(base64));
      if (typeof payload.sub === "string" && payload.sub.length > 0) {
        return `uid:${payload.sub}`;
      }
    }
  } catch {
    // Decode failed — fall through to signature-based key
  }

  // ── Fallback: use JWT signature (unique per token issuance) ──
  const lastDot = token.lastIndexOf(".");
  if (lastDot !== -1 && lastDot < token.length - 1) {
    const sig = token.substring(lastDot + 1);
    return `sig:${sig.substring(0, 32)}`;
  }

  // ── Last resort: use end of token (shouldn't happen with valid JWTs) ──
  return `raw:${token.substring(Math.max(0, token.length - 32))}`;
}

// ─── Fallback: In-Memory Rate Limiting ──────────────────────────

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
 * Backward-compatible alias for checkRateLimitLocal.
 * Kept for existing tests and external consumers.
 * @deprecated Use checkRateLimitLocal instead.
 */
export const checkRateLimit = checkRateLimitLocal;

// ─── Primary: Distributed Rate Limiting via PostgreSQL RPC ──────

async function checkRateLimitDistributed(
  key: string,
): Promise<{ allowed: boolean; retryAfterMs: number; current: number } | null> {
  try {
    const adminDb = getAdminClient();
    const { data, error } = await adminDb.rpc("check_rate_limit", {
      p_key: key,
      p_max_requests: RATE_LIMIT_MAX_REQUESTS,
      p_window_ms: RATE_LIMIT_WINDOW_MS,
    });

    if (error) {
      console.warn(`[RateLimit] Distributed check failed: ${error.message}`);
      return null; // Signal to fall back
    }

    // Reset failure counter on success
    distributedFailCount = 0;

    return {
      allowed: data.allowed,
      current: data.current,
      retryAfterMs: data.retry_after_ms ?? 0,
    };
  } catch (e) {
    console.warn(`[RateLimit] Distributed check exception: ${(e as Error).message}`);
    return null; // Signal to fall back
  }
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

  const key = extractKey(token);

  // ── Try distributed (PostgreSQL) rate limiting first ──
  if (useDistributed) {
    const result = await checkRateLimitDistributed(key);

    if (result !== null) {
      // Distributed check succeeded
      if (!result.allowed) {
        const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
        console.warn(
          `[RateLimit] Distributed: rate limit exceeded for key ${key.substring(0, 12)}...: ${result.current} requests`,
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

    // Distributed check failed — increment failure counter
    distributedFailCount++;
    if (distributedFailCount >= MAX_DISTRIBUTED_FAILURES) {
      console.warn(
        `[RateLimit] ${MAX_DISTRIBUTED_FAILURES} consecutive distributed failures. ` +
        `Falling back to in-memory rate limiting for this isolate.`,
      );
      useDistributed = false;
    }
  }

  // ── Fallback: in-memory rate limiting ──
  const now = Date.now();

  // Periodic cleanup
  if (now - lastCleanup > CLEANUP_INTERVAL_MS) {
    const cleaned = cleanupExpired(now);
    if (cleaned > 0) {
      console.log(`[RateLimit] Fallback: cleaned ${cleaned} expired entries`);
    }
  }

  const localResult = checkRateLimitLocal(key, now);

  if (!localResult.allowed) {
    const retryAfterSec = Math.ceil((localResult.retryAfterMs ?? 0) / 1000);
    console.warn(
      `[RateLimit] Fallback: rate limit exceeded for key ${key.substring(0, 12)}...: ${localResult.current} requests`,
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
