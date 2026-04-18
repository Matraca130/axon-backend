# Auditoría del plan — Performance del flujo publish + auto-ingest

Branch: `claude/improve-summary-performance-63Zxa`
Fecha: 2026-04-18

Este documento audita el plan de implementación y define los requisitos pre-flight para ejecutarlo con máxima eficiencia. No es el plan mismo (ver resumen en la conversación); es el control de calidad.

## Tabla de contenidos

1. [Verificación factual de supuestos del plan](#1-verificación-factual-de-supuestos-del-plan)
2. [Calificación del plan](#2-calificación-del-plan)
3. [Requisitos para máxima eficiencia de implementación](#3-requisitos-para-máxima-eficiencia-de-implementación)
   - 3.1 Pre-flight (antes del primer commit)
   - 3.2 Durante implementación (entre commits)
   - 3.3 Mid-plan checkpoint — Verificación de paridad de embeddings
   - 3.4 Pre-Commit 3 — Medición empírica de memoria (NUEVO, ex-A4)
   - 3.5 Post-Commit 3 (validación final)
   - 3.6 Herramientas / ejecución paralela
4. [Cambios sugeridos al plan original](#4-cambios-sugeridos-al-plan-original)
5. [Criterios de éxito del PR](#5-criterios-de-éxito-del-pr)
6. [Resumen ejecutivo](#6-resumen-ejecutivo) — incluye **bloqueante**: confirmar problema de negocio (latencia vs. costo)
7. [Auditoría arquitectónica final](#7-auditoría-arquitectónica-final-lente-de-senior-engineer)
8. [Follow-up tickets](#8-follow-up-tickets-a-abrir-antes-de-mergear)

---

## 1. Verificación factual de supuestos del plan

Antes de implementar, se validaron los supuestos críticos contra el código y las migraciones actuales.

| Supuesto del plan | Estado | Evidencia |
|---|---|---|
| `chunks.embedding` es nullable | ✅ Confirmado | Migración `20260305000003_pgvector_chunks.sql` (DDL inicial) declara `vector` sin NOT NULL; todas las RPC filtran `WHERE ch.embedding IS NOT NULL`. Fallback del Paso 5 es seguro. |
| Dimensión actual = 1536 | ✅ Confirmado | Migración `20260311000001_embedding_migration_1536.sql` + constante `EMBEDDING_DIMENSIONS` en `openai-embeddings.ts`. |
| Los 5 callers de `autoChunkAndEmbed` listados son los únicos | ✅ Confirmado | Grep `autoChunkAndEmbed\(`: `summary-hook.ts` (`onSummaryWrite`), `block-hook.ts` (`onBlockWrite`), `publish-summary.ts` (handler `POST /summaries/:id/publish`), `ingest-pdf.ts` (handler `POST /ai/ingest-pdf`), `re-chunk.ts` (handler `POST /ai/re-chunk`). |
| `generateEmbeddings` batchea a 100 internamente | ✅ Confirmado | Función `generateEmbeddings` en `openai-embeddings.ts`, constante `BATCH_SIZE = 100`. |
| `generateEmbeddings` preserva orden | ✅ Confirmado | `generateEmbeddingBatch` ordena por `index` server-side antes de devolver. |
| Embedding-cache existe (reduce trabajo real) | ✅ Confirmado | `lib/embedding-cache.ts` (`getCachedEmbedding`/`setCachedEmbedding`), integrado en `generateEmbedding` (cache check al inicio). |

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
| H7 | **Sin feature flag / kill-switch**. Si el Commit 3 introduce un bug en prod, el rollback es un revert manual + redeploy (5-15min de exposición). | Media | **Bloqueante** (revisado tras review arquitectónica): añadir env var `AUTO_INGEST_BULK_INSERT_ENABLED` (default `false` en prod, `true` en staging) que conmuta entre ruta nueva (bulk insert con embeddings) y vieja (UPDATE por chunk). Costo: 1 if-statement, 1 línea de config. Permite rollout gradual sin redeploy. |
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

### 3.3 Mid-plan checkpoint — Verificación de paridad de embeddings (post-Commit 1, pre-Commit 2)

Bloqueante. El Commit 1 no cambia comportamiento (solo evita un SELECT duplicado), por lo que es el punto natural para validar que el pipeline actual de embeddings sobre el JSON de bloques funciona correctamente. Si hay un bug latente, debe detectarse aquí — antes de que los Commits 2-3 cambien la generación masiva.

Para 5 summaries reales con bloques (mezcla de tipos: `prose`, `key_point`, `comparison`, `list_detail`):

- [ ] **C1 — Validez del flatten**:
  - Ejecutar `flattenBlocksToMarkdown(blocks)` sobre cada summary.
  - Comparar contra `summaries.content_markdown`. Divergencias son esperables si hubo edits post-publish; logear y aceptar.
  - Verificar que el output no es vacío y no contiene literales `[object Object]` (indicaría un tipo de bloque sin handler).

- [ ] **C2 — Validez de embeddings recién generados**:
  - Llamar `generateEmbedding(flattened)` para cada summary.
  - Verificar `embedding.length === 1536`.
  - Verificar ausencia de `NaN` / `Infinity`: `embedding.every(Number.isFinite)`.
  - Verificar norma L2 ≈ 1.0 (OpenAI los devuelve normalizados): `Math.abs(Math.sqrt(sum) - 1.0) < 0.01`.

- [ ] **C3 — Paridad con embeddings almacenados**:
  - Para cada bloque, calcular cosine similarity entre el embedding nuevo y el de `summary_block_embeddings.embedding`.
  - **Criterio de paso**: similarity ≥ 0.999 si el contenido del bloque no cambió.
  - Similarity entre 0.95-0.999: drift moderado (probable cambio en flatten o truncation) — investigar pero no bloquear.
  - Similarity < 0.95: drift severo, **bloquear** los Commits 2-3 hasta entender la causa (modelo cambió, dimensión cambió, flatten roto).

- [ ] **C4 — Sanity semántica**:
  - Dos bloques `prose` del mismo summary (mismo tema): cosine ≥ 0.7.
  - Dos bloques de summaries distintos sobre temas no relacionados: cosine < 0.5.
  - Si falla, indica que los embeddings no capturan semántica (probable bug en flatten que produce texto basura).

**Cómo ejecutar**: script ad-hoc Deno bajo `scripts/diagnostics/verify_embedding_parity.ts` (no commitear; ejecutar localmente con service role key). Salida: tabla con summary_id, block_id, similarity, pass/fail.

**Si todos los chequeos pasan**: continuar con Commits 2-3 con confianza — solo cambian el *cómo* (batch + bulk insert), no el *qué* (mismo modelo, mismo flatten → mismos embeddings).

### 3.4 Pre-Commit 3 — Medición empírica de memoria (ex-A4)

Bloqueante. Antes de commitear el bulk insert con embeddings inline, medir el límite real de memoria de Deno Edge Functions. La constante `MAX_BATCH_INSERT_CHUNKS` no debe ser un número redondo elegido por intuición; debe ser empírica.

**Procedimiento**:

1. Crear summary de prueba en staging con 1000 chunks sintéticos (texto largo generado).
2. Instrumentar antes y después del bulk insert:
   ```ts
   const memBefore = Deno.memoryUsage();
   // ... bulk insert ...
   const memAfter = Deno.memoryUsage();
   console.log(JSON.stringify({
     event: "memory_probe",
     chunks: chunks.length,
     heapUsed_delta_mb: (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024,
     rss_delta_mb: (memAfter.rss - memBefore.rss) / 1024 / 1024,
   }));
   ```
3. Ejecutar con tamaños: 100, 250, 500, 1000, 2000 chunks. Anotar:
   - Pico de heap.
   - Si la función crashea (ENOMEM, killed by runtime).
   - Latencia del bulk insert (PostgREST puede degradar antes que el runtime).
4. **Definir `MAX_BATCH_INSERT_CHUNKS`** = 50% del tamaño máximo donde la función completó sin warnings, redondeado hacia abajo a múltiplo de 50.

**Salida**: tabla en el PR description con los 5 puntos medidos. Si el límite empírico < 500, ajustar el guardrail H3 de la sección 2.

**Si no es posible medir en staging** (no hay deployment, no hay acceso): documentar explícitamente y elegir 200 (no 500) como valor conservador. Marcar el ticket de seguimiento como prioridad alta.

### 3.5 Post-Commit 3 (validación final)

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

### 3.6 Herramientas / ejecución paralela

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

- [ ] Los 3 commits de implementación (`perf(auto-ingest): preloaded blocks`, `perf(publish): batch + parallel`, `perf(auto-ingest): bulk insert + fused UPDATE`) pushados en orden.
- [ ] CI verde en las 4 jobs (unit, server tests, scanner, integration).
- [ ] Baseline vs post-change documentado en PR description con speedup numérico.
- [ ] `chunks.embedding IS NULL` = 0 en summary de prueba post-publish.
- [ ] Logs conservan compatibilidad con ops alerting (cadenas `[Auto-Ingest] Done`, `Batch embedding failed, falling back to sequential`).
- [ ] Feature flag `AUTO_INGEST_BULK_INSERT_ENABLED` operativo y default a OFF en prod (ver H7 actualizado).
- [ ] 3 follow-up tickets abiertos y enlazados (ver sección 8).
- [ ] Review aprobado (al menos 1 humano revisa Commit 3 — es el más arriesgado).

---

## 6. Resumen ejecutivo

### ⚠️ Pre-condición bloqueante: confirmar el problema de negocio

Este PR reduce **wall time** (latencia percibida del publish: típicamente 30s → 6-12s para summaries grandes). **NO reduce el costo de OpenAI**: el conteo de tokens enviados es idéntico. Antes de implementar, confirmar con producto/finanzas que el problema a resolver es:

- ✅ **Latencia** → este PR es la solución correcta.
- ❌ **Costo de OpenAI** → este PR no ayuda; necesitas chunking incremental (ver A6) o un modelo más barato.
- ❌ **Throughput agregado del sistema** → este PR ayuda parcialmente (libera el Edge Function antes), pero la limitante real es probablemente la cuota de OpenAI.

Sin esta confirmación, hay riesgo de optimizar lo equivocado.

### Estado del plan

El plan es implementable tal como está. Los huecos **H1, H3, H6, H7** son los únicos que recomiendo cerrar **antes** de empezar (baseline, guardrail empírico de memoria, test dedicado, feature flag). Los demás son aceptables como follow-ups o comentarios en código.

Tiempo estimado: Commit 1 ≈ 30min, Commit 2 ≈ 1h (incluye test), Commit 3 ≈ 1.5h (incluye fallback + feature flag). Total ≈ 3h de implementación + 1h de medición empírica de memoria + 30min de checkpoint de paridad. **≈ 4.5h end-to-end.**

---

## 7. Auditoría arquitectónica final (lente de senior engineer)

Esta sección es opinión técnica, no un bloqueo. El plan es **localmente correcto**: aplica buenas prácticas de batching, reduce round-trips y preserva semántica de fallo. Pero como cualquier optimización táctica, deja al descubierto problemas estructurales que conviene nombrar para que no se olviden.

### 7.1 Lo que el plan hace bien

- **Cambios mínimamente invasivos**: parámetro trailing opcional, sin refactors gratuitos. Apropiado para un PR de performance.
- **Preserva la red de seguridad existente**: el fallback secuencial sobrevive — clave en sistemas con dependencia externa flaky (OpenAI).
- **Bisectable**: 3 commits con responsabilidad única. Si Commit 3 rompe prod, `git revert` es preciso.
- **Ataca el cuello de botella correcto**: O(N) round-trips → O(1-2). Es el orden de magnitud que hace falta, no micro-optimizaciones.

### 7.2 Lo que el plan NO resuelve (deuda arquitectónica visible)

Estos son problemas reales que el plan deliberadamente no toca. Algunos son out-of-scope correctos; otros son atajos que generan deuda.

#### A1 — Atomicidad del pipeline (deuda real)

DELETE chunks → INSERT chunks → UPDATE summary es una secuencia no-transaccional ejecutada desde el cliente. Si el Edge Function muere entre DELETE e INSERT, el summary queda sin chunks indefinidamente, sin alerta. La advisory lock previene races concurrentes pero no sobrevive a crashes.

**Solución correcta**: una RPC SQL `auto_ingest_summary(summary_id, chunks_with_embeddings, summary_embedding)` que haga DELETE+INSERT+UPDATE en una transacción. El plan defiere esto explícitamente — coincido con la decisión, pero debe convertirse en un ticket inmediato post-merge, no un "lo vemos algún día".

#### A2 — Coupling y SRP en `publish-summary.ts`

Una sola función de 182 líneas maneja: auth, role check, status validation, fetch, flatten, update, ingest orchestration, embedding batching, error aggregation. Es un God Function. El plan no lo agrava (no añade responsabilidades), pero tampoco lo mejora.

**Solución correcta**: extraer `PublishSummaryPipeline` con métodos `validate()`, `flatten()`, `persist()`, `embed()`. Los tests serían triviales. Out-of-scope para este PR; ticket de seguimiento recomendado.

#### A3 — Logs como contrato de ops alerting

El plan exige preservar las cadenas literales `[Auto-Ingest] Done`, `Batch embedding failed, falling back to sequential` porque hay alerting acoplado a ellas. Esto es **frágil por diseño**: cualquier refactor futuro (incluyendo i18n de logs, structured logging) rompe ops sin aviso de tipos.

**Solución correcta**: emitir eventos estructurados (`{ event: "auto_ingest_done", summary_id, chunks_count, ms }`) y que el alerting consuma el campo `event`, no el mensaje. Out-of-scope; ticket recomendado en el equipo de observabilidad.

#### A4 — Memoria sin presión observada

H3 propone un guardrail de 500 chunks pero el número es arbitrario. No sabemos el límite real de Deno Edge Functions porque nunca se midió. Estamos optimizando un sistema cuyas restricciones operativas son opacas.

**Solución correcta**: instrumentar `Deno.memoryUsage()` antes y después del bulk insert en staging con summaries grandes (1000+ chunks). El número 500 debe ser empírico, no un número redondo.

#### A5 — Costo de OpenAI no se reduce

El PR reduce **wall time** (latencia percibida por el usuario que publica) pero el conteo de tokens enviados a OpenAI es idéntico. Si el problema de negocio es el bill de OpenAI, este PR no ayuda. Si el problema es que los profesores ven un spinner de 30s al publicar, este PR resuelve directamente.

**Asegurarse de que el problema correcto se está atacando.** Vale la pena confirmar con producto/finanzas antes de mergear.

#### A6 — Re-embed full en cada cambio

El hash check (`computeContentHash` + comparación con `existingChunk.content_hash` dentro de `_autoChunkAndEmbedCore`) evita re-trabajo cuando el contenido es idéntico, pero **cualquier edit en cualquier bloque invalida todo el hash y re-genera todos los chunks**. Para un summary con 100 bloques donde el profesor edita 1, se re-embedean los 100. Eso es desperdicio puro.

**Solución correcta**: hash por bloque + chunking incremental. Es un rediseño profundo del pipeline, claramente fuera de scope, pero **es la mejora 10x** real. El PR actual es 2-5x. Nombrar la diferencia en el PR description gestiona expectativas.

#### A7 — La firma `preloadedBlocks` filtra detalle de implementación

Añadir un parámetro opcional para evitar un SELECT duplicado es pragmático pero feo: la API de `autoChunkAndEmbed` ahora expone que internamente hace un fetch de blocks. Un consumidor honesto no debería necesitar saberlo.

**Solución correcta a futuro**: invertir la dependencia. `autoChunkAndEmbed` recibe un `BlocksSource` (function `() => Promise<Block[]>`) que el caller compone como quiere. El caller con blocks ya cargados pasa `() => Promise.resolve(blocks)`; los demás pasan la versión que va a la DB. Out-of-scope para este PR (over-engineering ahora), pero **no convertir `preloadedBlocks` en un patrón** — si aparece un tercer caller que también quiere precarga, refactorizar.

### 7.3 Riesgos operativos no mitigados

| Riesgo | Probabilidad | Impacto | Mitigación que el plan no incluye |
|---|---|---|---|
| Commit 3 introduce silent data loss en producción | Baja | Alto | Feature flag `AUTO_INGEST_BULK_INSERT_ENABLED` con default `false` en prod la primera semana. |
| Test gate de CI no detecta regresión real (cobertura insuficiente sobre `publish-summary.ts`) | Media | Alto | Smoke test E2E contra deployment de staging post-deploy, no solo unit tests. |
| OpenAI cambia formato de respuesta y el batch falla silenciosamente | Baja | Medio | Contract test contra API de OpenAI en CI (semanal, no por PR). |
| Métricas de latencia no se capturan post-deploy → no se valida la mejora | Alta | Bajo | Datadog/Sentry span en `[Auto-Ingest] Done`. Ya falta hoy, no es regresión, pero el PR es buen momento para añadirla. |

### 7.4 Lo que un staff/principal pediría antes de aprobar

Si yo revisara este PR como staff engineer:

1. **No bloquearía el merge** si los chequeos H1/H3/H6/H7 + paridad (3.3) + medición de memoria (3.4) pasan. La dirección es correcta y el cambio es bisectable.
2. **Pediría 3 follow-up tickets explícitos en el PR description**:
   - Ticket A1: convertir DELETE+INSERT a RPC transaccional.
   - Ticket A6: chunking incremental por bloque (la mejora 10x).
   - Ticket de observabilidad: span estructurado en lugar de log scraping.
3. **Pediría confirmación del problema de negocio**: ¿reducción de latencia o de costo? Si es costo, este PR no es la solución.
4. **Pediría el feature flag de Commit 3** (1 línea, retorno enorme en seguridad de rollout).
5. **Aprobaría con "ship it, but please file the follow-ups before merging"**.

### 7.5 Veredicto

**Aprobar con cambios menores.** Es un PR de performance honesto: ataca el cuello de botella correcto con el método correcto y preserva la red de seguridad. La deuda arquitectónica que deja visible (A1-A7) ya existía antes del PR; el PR no la empeora, solo la hace más evidente — lo cual es **bueno**, no malo. Los tickets de seguimiento son la salida correcta.

Lo que **no** se debe hacer: usar este PR como excusa para meter A1-A7. Eso convierte un cambio de 3h en un proyecto de 2 semanas y pierde el momentum del win táctico. Mantener el scope estrecho.

---

## 8. Follow-up tickets (a abrir antes de mergear)

Estos tickets deben crearse **antes del merge** y enlazarse en la PR description. Son la salida formal de A1, A6 y la deuda de observabilidad. Si no se abren, la deuda arquitectónica se pierde y el PR se vuelve un atajo sin compensación futura.

| ID | Título sugerido | Origen | Prioridad | Esfuerzo estimado |
|---|---|---|---|---|
| FT-1 | `auto-ingest`: convertir DELETE+INSERT a RPC SQL transaccional | A1 | Alta | 1-2 días (migración + tests) |
| FT-2 | `auto-ingest`: chunking incremental por bloque (hash por bloque) | A6 | Media | 1-2 semanas (rediseño del pipeline) |
| FT-3 | observabilidad: reemplazar log scraping por eventos estructurados | A3 | Media | 3-5 días (definir schema + adoptar en alerting) |
| FT-4 | `auto-ingest`: medir y documentar límite de memoria de Edge Function | A4 | Baja | 1 día (instrumentación + experimento) |
| FT-5 | refactor `publish-summary.ts` a `PublishSummaryPipeline` | A2 | Baja | 2-3 días (extracción + tests) |
| FT-6 | `autoChunkAndEmbed`: invertir dependencia a `BlocksSource` (eliminar `preloadedBlocks`) | A7 | Baja | 1 día (cuando aparezca tercer caller) |

**Plantilla de ticket** (para copiar al issue tracker):

```markdown
**Origen**: PR #298 — audit `docs/summary-performance-plan-audit.md` sección 7.2 / Aₓ.

**Contexto**: [pegar la sección Aₓ correspondiente del audit]

**Definition of Done**:
- [definir criterios concretos según la solución propuesta en Aₓ]

**Bloquea / desbloquea**: [enlazar a otros FT-* relacionados]
```

**Política**: si tras 90 días post-merge no se ha avanzado en FT-1 (atomicidad) o FT-2 (incremental), se considera deuda crítica y debe escalarse al tech lead. Los demás pueden vivir como backlog.
