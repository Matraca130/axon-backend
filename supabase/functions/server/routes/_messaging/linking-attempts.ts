/**
 * routes/_messaging/linking-attempts.ts — Shared failure tracker for linking codes
 *
 * Complements the entropy bump in telegram/link.ts and whatsapp/link.ts:
 * even with 10^10 codes, an in-memory per-caller lockout after N failed
 * attempts shuts down abusive probing early and bounds log noise.
 *
 * In-memory only (per Deno isolate). Not distributed — that's acceptable
 * since the per-isolate bucket is already much smaller than the brute-force
 * search space and each isolate enforces its own limit independently.
 */

const MAX_FAILED_ATTEMPTS = 5;
const WINDOW_MS = 60 * 60_000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60_000;

interface AttemptEntry {
  count: number;
  resetAt: number;
}

export interface LinkingAttemptsTracker {
  /** Returns true if this caller may attempt. Does NOT mutate state. */
  allow: (key: string) => boolean;
  /** Record a failed attempt. Caller should call this on every failure. */
  recordFailure: (key: string) => void;
  /** Clear the counter for a caller (on successful link). */
  reset: (key: string) => void;
  /** Diagnostic: current size of the tracker map. */
  getMapSize: () => number;
}

export function createLinkingAttemptsTracker(
  logLabel: string,
): LinkingAttemptsTracker {
  const map = new Map<string, AttemptEntry>();
  let lastCleanup = Date.now();

  function cleanupExpired(now: number): void {
    let cleaned = 0;
    for (const [key, entry] of map) {
      if (now > entry.resetAt) {
        map.delete(key);
        cleaned++;
      }
    }
    lastCleanup = now;
    if (cleaned > 0) {
      console.warn(`[${logLabel}] Cleaned ${cleaned} expired entries`);
    }
  }

  function maybeCleanup(now: number): void {
    if (now - lastCleanup > CLEANUP_INTERVAL_MS) {
      cleanupExpired(now);
    }
  }

  function allow(key: string): boolean {
    const now = Date.now();
    maybeCleanup(now);
    const entry = map.get(key);
    if (!entry || now > entry.resetAt) return true;
    return entry.count < MAX_FAILED_ATTEMPTS;
  }

  function recordFailure(key: string): void {
    const now = Date.now();
    const entry = map.get(key);
    if (!entry || now > entry.resetAt) {
      map.set(key, { count: 1, resetAt: now + WINDOW_MS });
    } else {
      entry.count++;
      if (entry.count === MAX_FAILED_ATTEMPTS) {
        console.warn(
          `[${logLabel}] Lockout triggered for key ${key.slice(0, 12)}... after ${MAX_FAILED_ATTEMPTS} failures`,
        );
      }
    }
  }

  function reset(key: string): void {
    map.delete(key);
  }

  function getMapSize(): number {
    return map.size;
  }

  return { allow, recordFailure, reset, getMapSize };
}
