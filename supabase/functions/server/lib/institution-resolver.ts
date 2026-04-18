/**
 * lib/institution-resolver.ts — Shared institution_id resolution helpers
 *
 * Centraliza la lógica de resolución de institution_id que estaba duplicada en:
 *   - xp-hooks.ts (2 helpers + 1 inline)
 *   - crud-factory.ts (2 helpers)
 *   - finals-badge-hooks.ts (1 helper)
 *   - routes-models.ts (1 inline)
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js";

/**
 * Resuelve institution_id usando la RPC resolve_parent_institution.
 * Retorna null si la RPC falla o no encuentra resultado — nunca lanza.
 *
 * @param db     Cliente Supabase
 * @param table  Tabla de origen (ej. "summaries", "topics")
 * @param id     UUID del registro
 */
export async function resolveInstitutionViaRpc(
  db: SupabaseClient,
  table: string,
  id: string,
): Promise<string | null> {
  try {
    const { data, error } = await db.rpc("resolve_parent_institution", {
      p_table: table,
      p_id: id,
    });
    if (error || !data) return null;
    return data as string;
  } catch {
    return null;
  }
}

/**
 * Resuelve institution_id desde un course_id consultando la tabla courses.
 * Retorna null si el curso no existe o no tiene institution_id.
 *
 * @param db       Cliente Supabase
 * @param courseId UUID del curso
 */
export async function resolveInstitutionFromCourse(
  db: SupabaseClient,
  courseId: string,
): Promise<string | null> {
  const { data } = await db
    .from("courses")
    .select("institution_id")
    .eq("id", courseId)
    .single();
  return (data?.institution_id as string) ?? null;
}
