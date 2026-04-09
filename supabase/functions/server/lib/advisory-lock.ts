/**
 * lib/advisory-lock.ts — PostgreSQL advisory lock helpers for Axon
 *
 * Previene ejecuciones concurrentes de operaciones críticas:
 *   - auto-ingest.ts: chunking de la misma summary en paralelo
 *   - gamification-dispatcher.ts: evaluación de badges post-award
 *   - routes/gamification/streak.ts: compra/reparación de streak freeze
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js";

// ─── Hash ────────────────────────────────────────────────────────

/**
 * FNV-1a 32-bit hash → unsigned integer.
 * Siempre positivo (>>> 0): seguro para pg_try_advisory_lock.
 */
export function advisoryLockKey(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return hash >>> 0; // siempre positivo (unsigned 32-bit)
}

// ─── Low-level primitives ─────────────────────────────────────────

/**
 * Intenta adquirir el advisory lock.
 * - Retorna true si lo adquirió.
 * - Retorna false si ya está tomado por otro proceso.
 * - Lanza Error si el RPC falla (problema de conectividad/permisos).
 */
export async function tryAcquireAdvisoryLock(
  db: SupabaseClient,
  lockKey: number,
): Promise<boolean> {
  const { data, error } = await db.rpc("try_advisory_lock", { lock_key: lockKey });
  if (error) throw new Error(`try_advisory_lock failed: ${error.message}`);
  return data === true;
}

/**
 * Libera el advisory lock.
 * Fire-and-forget safe: absorbe errores con console.warn en lugar de lanzarlos.
 * Siempre debe llamarse en un bloque finally.
 */
export async function releaseAdvisoryLock(
  db: SupabaseClient,
  lockKey: number,
  label: string,
): Promise<void> {
  const { error } = await db.rpc("advisory_unlock", { lock_key: lockKey });
  if (error) {
    console.warn(`[Advisory Lock] release failed for ${label}:`, error.message);
  }
}

// ─── High-level helper ────────────────────────────────────────────

/**
 * Ejecuta fn() bajo advisory lock, siempre liberando en finally.
 *
 * Comportamiento si el lock NO se puede adquirir:
 *   - Llama onSkip() si fue provisto
 *   - Retorna null sin ejecutar fn()
 *
 * Uso: tareas background donde "saltar si bloqueado" es correcto
 * (auto-ingest, gamification post-award). Para rutas HTTP que deben
 * retornar 409, usar tryAcquireAdvisoryLock + releaseAdvisoryLock directamente.
 *
 * @param db        Cliente Supabase con permisos de service_role
 * @param lockKey   Clave derivada con advisoryLockKey()
 * @param label     Etiqueta para logs (ej. "auto-ingest:uuid")
 * @param fn        Tarea a ejecutar bajo el lock
 * @param onSkip    Callback opcional cuando el lock no se adquiere
 */
export async function withAdvisoryLock<T>(
  db: SupabaseClient,
  lockKey: number,
  label: string,
  fn: () => Promise<T>,
  onSkip?: () => void,
): Promise<T | null> {
  const acquired = await tryAcquireAdvisoryLock(db, lockKey);
  if (!acquired) {
    onSkip?.();
    return null;
  }
  try {
    return await fn();
  } finally {
    await releaseAdvisoryLock(db, lockKey, label);
  }
}
