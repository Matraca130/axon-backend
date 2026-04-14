/**
 * tests/e2e/helpers/cleanup.ts — Cleanup utilities for E2E tests
 * Tracks created entities and deletes them in reverse order after tests.
 */
import { api } from "../../helpers/test-client.ts";

interface TrackedEntity {
  path: string; // e.g. "/topics/uuid"
  id: string;
}

const tracked: TrackedEntity[] = [];

/**
 * Track an entity for cleanup. Entities are cleaned up in LIFO order
 * (last created = first deleted) to respect FK constraints.
 */
export function track(resource: string, id: string): void {
  tracked.push({ path: `/${resource}/${id}`, id });
}

/**
 * Delete all tracked entities in reverse order.
 * Logs failures but does not throw — cleanup is best-effort.
 */
export async function cleanupAll(token: string): Promise<void> {
  const toDelete = [...tracked].reverse();
  tracked.length = 0; // reset

  for (const entity of toDelete) {
    try {
      const r = await api.delete(entity.path, token);
      if (!r.ok) {
        console.warn(`[cleanup] Failed to delete ${entity.path}: ${r.status}`);
      }
    } catch (err) {
      console.warn(`[cleanup] Error deleting ${entity.path}:`, err);
    }
  }
}

/**
 * Reset tracked list without deleting (e.g., if entities were already removed).
 */
export function resetTracking(): void {
  tracked.length = 0;
}
