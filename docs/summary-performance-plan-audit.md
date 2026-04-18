# Auditoría del plan — Performance del flujo publish + auto-ingest

Branch: `claude/improve-summary-performance-63Zxa`
Fecha: 2026-04-18

Este documento audita el plan de implementación y define los requisitos pre-flight para ejecutarlo con máxima eficiencia. No es el plan mismo (ver resumen en la conversación); es el control de calidad.

---

## 1. Verificación factual de supuestos del plan

Antes de implementar, se validaron los supuestos críticos contra el código y las migraciones actuales.

| Supuesto del plan | Estado | Evidencia |
|---|---|---|
| `chunks.embedding` es nullable | ✅ Confirmado | `20260305000003_pgvector_chunks.sql:25` declara `vector(768)` sin NOT NULL; todas las RPC filtran `WHERE ch.embedding IS NOT NULL`. Fallback del Paso 5 es seguro. |
| Dimensión actual = 1536 | ✅ Confirmado | Migración `20260311000001_embedding_migration_1536.sql` + `EMBEDDING_DIMENSIONS = 1536` en `openai-embeddings.ts:21`. |
| Los 5 callers de `autoChunkAndEmbed` listados son los únicos | ✅ Confirmado | Grep: `summary-hook.ts:91`, `block-hook.ts:116`, `publish-summary.ts:112`, `ingest-pdf.ts:210`, `re-chunk.ts:150`. |
| `generateEmbeddings` batchea a 100 internamente | ✅ Confirmado | `openai-embeddings.ts:153-160`. |
| `generateEmbeddings` preserva orden | ✅ Confirmado | Ordena por `index` server-side (`openai-embeddings.ts:206-208`). |
| Embedding-cache existe (reduce trabajo real) | ✅ Confirmado | `lib/embedding-cache.ts`, integrado en `generateEmbedding`. |

**Conclusión**: ningún supuesto del plan se contradice con el código. Se puede proceder.

---

## 2. Calificación del plan

**Puntuación global**: 8/10. Plan sólido, ejecutable tal cual, pero con huecos en medición y observabilidad.

### Fortalezas
- Referencias `file:line` concretas en cada paso.
- Firma `preloadedBlocks` trailing/opcional → cero breaking-changes para los 4 callers existentes.
- Fallback secuencial explícitamente preservado en Pasos 2 y 5 (criticidad operativa).
- Estrategia de 3 commits bisectable — cada commit es roll-back-able por sí solo.
- Incluye el límite de body de PostgREST (~1MB) y propone chunk de 50 rows.
- Llamadas de test correctas para el stack (Deno + `--allow-env --allow-net`).

### Huecos detectados (ordenados por impacto)

| # | Hueco | Severidad | Mitigación sugerida |
|---|---|---|---|
| H1 | **Sin baseline de medición**. No hay forma de probar cuantitativamente que el cambio mejora la latencia. | Alta | Antes del Commit 1, ejecutar un publish contra un summary con ≥50 bloques y registrar `elapsed_ms` + logs de round-trips. Repetir post-commit 3. Criterio de éxito: p50 publish ≤ 40% del baseline. |
| H2 | **Atomicidad DELETE+INSERT en auto-ingest sigue siendo no-transaccional**. Si falla el INSERT tras el DELETE, el summary queda sin chunks. El plan lo reconoce pero no propone mitigación. | Media | Opción A: diferir el DELETE hasta que el INSERT tenga éxito (INSERT con `summary_id` temporal + swap via RPC). Opción B: aceptar el riesgo y loguear. Recomendado: **documentar el riesgo en un comentario en el código**, no bloquear el PR. |
| H3 | **Memoria pico en Edge Function**. 1000 chunks × 1536 floats × 8B ≈ 12MB solo en embeddings. Deno Edge tiene límites de memoria no documentados en el plan. | Media | Añadir guardrail: si `chunks.length > 500`, caer al modo actual (UPDATE por chunk) o rechazar con error claro. |
| H4 | **Rate-limit de OpenAI con paralelización**. Paso 4 corre ingest + block-embed en paralelo → duplica TPM contra OpenAI para un mismo summary. | Media | Verificar headers `x-ratelimit-remaining-tokens` en logs de staging. Si hay headroom, ok. Si no, serializar los pasos 2+4 pero mantener las optimizaciones 1+3+5+6. |
| H5 | **Concurrencia de publish**. El advisory lock cubre el ingest pero NO el batch de block-embeddings. Dos publish concurrentes harían doble upsert a `summary_block_embeddings`. | Baja | `onConflict: "block_id"` hace el upsert idempotente → no corrompe datos, solo duplica trabajo. Aceptable. Documentar. |
| H6 | **Sin test dedicado para `publish-summary.ts`**. El plan lo menciona como "opcional". | Media | Añadir `tests/publish_summary_test.ts` en Commit 2 con un mock mínimo de `generateEmbeddings` que verifique: (a) 1 sola llamada, (b) 1 sola upsert cuando bloques ≤ 50. Es la única defensa automatizada contra regresiones en este archivo. |
| H7 | **Sin feature flag / kill-switch**. Si el Commit 3 introduce un bug en prod, el rollback es un revert manual. | Baja | No crítico si la cobertura de tests es buena. Alternativa: variable de entorno `DISABLE_BATCH_INSERT_EMBEDDINGS=1` que fuerce la vieja ruta UPDATE-por-chunk. Solo si el equipo lo considera necesario. |
| H8 | **Observabilidad no aumentada**. Los logs actuales no distinguen "batch path" de "fallback secuencial". | Baja | Añadir al log final `path=batch|sequential_fallback` y `db_roundtrips=N` para que ops pueda medir adopción real del fast-path. |
| H9 | **`defaultToNull: false` en `.insert()`** mencionado sin verificar que `supabase-js` lo soporte en esta versión. | Baja | `defaultToNull` existe en supabase-js v2.39+. Verificar `deno.json` o el import map. Si no está, usar `.insert()` default — funciona igual para el caso sin columnas faltantes. |
| H10 | **Sin criterio de "done"** explícito para el PR. | Baja | Añadir al PR description: "p50 publish con 50 bloques baja de X a Y ms; todos los tests del server pasan; manual smoke: publicar un summary y verificar que `chunks.embedding IS NOT NULL` para todas las filas." |

---

## 3. Requisitos para máxima eficiencia de implementación

### 3.1 Pre-flight (antes del primer commit)

Checklist bloqueante — no empezar hasta completar:

- [ ] **Baseline timing**: ejecutar un publish real en dev contra un summary con ≥50 bloques. Registrar:
  - `elapsed_ms` del log de `[Auto-Ingest] Done`.
  - Número de round-trips DB (contar `UPDATE chunks` logs).
  - Duración total HTTP del POST `/summaries/:id/publish`.
- [ ] **Verificar versión de `supabase-js`** en las imports (`npm:@supabase/supabase-js@X.Y.Z`) para confirmar soporte de `.upsert(array)` y `defaultToNull`.
- [ ] **Verificar Deno version** con `deno --version` (CI usa 1.45+, asegurar paridad local).
- [ ] **Env vars para tests**:
  ```
  export OPENAI_API_KEY=...       # real o mocked via DENO_ENV
  export SUPABASE_URL=...
  export SUPABASE_SERVICE_ROLE_KEY=...
  ```
- [ ] **Confirmar que el branch está up-to-date con `main`** (evita conflictos en `auto-ingest.ts` que tiene alta tasa de cambio).
- [ ] **Identificar un summary de prueba** con ≥50 bloques y ≥50 chunks esperados (necesario para que el speedup sea medible).

### 3.2 Durante implementación (entre commits)

Por cada commit:

- [ ] `deno check supabase/functions/server/**/*.ts` — atrapar errores de tipo (especialmente crítico tras Commit 1: el cambio de firma es load-bearing).
- [ ] `deno test supabase/functions/server/tests/summary_hook_test.ts --no-check --allow-env --allow-net` — debe pasar T1-T9 sin cambios.
- [ ] `deno test supabase/functions/server/tests/block-hook.test.ts --no-check --allow-env --allow-net`.
- [ ] Smoke test manual (si hay dev deployment): `curl` un POST `/summaries/:id/publish` y verificar que la respuesta tiene `chunks_count > 0` y `blocks_embedded = total_blocks`.
- [ ] Revisar logs: el string `[Auto-Ingest] Done:` debe seguir apareciendo con misma estructura.

### 3.3 Post-Commit 3 (validación final)

- [ ] **Re-medir** el escenario baseline (mismo summary, mismo hardware). Calcular speedup p50 y p95.
- [ ] **Query de sanidad**:
  ```sql
  SELECT COUNT(*) FILTER (WHERE embedding IS NULL) AS missing,
         COUNT(*) AS total
  FROM chunks
  WHERE summary_id = '<test-id>';
  ```
  Debe dar `missing = 0` en el happy path.
- [ ] Verificar `summary_block_embeddings` no tiene duplicados por `block_id`.
- [ ] Push + PR draft con comparativa baseline/post en la descripción.

### 3.4 Herramientas / ejecución paralela

Para minimizar wall-clock del desarrollo:

- **Commit 1 + Commit 2** son independientes en archivos distintos (`auto-ingest.ts` vs `publish-summary.ts`, con un único touchpoint en la línea 112). Pueden implementarse en paralelo en dos terminales y fusionarse con merge limpio.
- **Commit 3** toca `auto-ingest.ts` pesadamente → debe ir después del Commit 1 en serie.
- **Tests** de los 3 commits pueden correrse en paralelo al final (son independientes por archivo).

---

## 4. Cambios sugeridos al plan original

Mínimos, no alteran la arquitectura:

1. **Agregar medición explícita** al Paso 1: incluir logs `db_roundtrips=N` y `path=batch|fallback` en la línea final de `[Auto-Ingest] Done` (H1, H8).
2. **Agregar guardrail de memoria** al Paso 5: si `chunks.length > 500`, log warn + ruta vieja (H3). Constante `MAX_BATCH_INSERT_CHUNKS = 500`.
3. **Agregar test dedicado** para `publish-summary.ts` en Commit 2 (H6). No bloqueante pero muy recomendado.
4. **Documentar no-atomicidad** con un comentario en `auto-ingest.ts` sobre el DELETE+INSERT (H2).

---

## 5. Criterios de éxito del PR

El PR se considera listo para merge cuando:

- [x] Los 3 commits pushados en orden.
- [ ] CI verde en las 3 jobs (unit, server tests, migration safety).
- [ ] Baseline vs post-change documentado en PR description con speedup numérico.
- [ ] `chunks.embedding IS NULL` = 0 en summary de prueba post-publish.
- [ ] Logs conservan compatibilidad con ops alerting (cadenas `[Auto-Ingest] Done`, `Batch embedding failed, falling back to sequential`).
- [ ] Review aprobado (al menos 1 humano revisa Commit 3 — es el más arriesgado).

---

## 6. Resumen ejecutivo

El plan es implementable tal como está. Los huecos H1, H3, H6 son los únicos que recomiendo cerrar **antes** de empezar (agregar baseline, guardrail, test). Los demás son aceptables como follow-ups o comentarios en código.

Tiempo estimado: Commit 1 ≈ 30min, Commit 2 ≈ 1h (incluye test), Commit 3 ≈ 1.5h (incluye fallback cuidadoso). Total ≈ 3h de implementación + medición.
