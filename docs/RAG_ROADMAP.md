# RAG Roadmap — Blueprint completo con Gemini

> Plan de implementacion para completar todo lo propuesto en los documentos
> de investigacion (`pgvector-axon-integration.md`, `axon-rag-architecture.md`,
> `chunking-strategies.md`, `hybrid-retrieval.ts`, `adaptive-ia-study.md`),
> adaptado a Gemini como provider inicial.
>
> **Auditoria v12:** 2026-03-09 — Fase 6 Retrieval Avanzado completada (branch feat/fase6-retrieval-avanzado).
> v11: Fase 8 IA Adaptativa completada (branch feat/fase8-ia-adaptativa).
> v10: Fase 3 coarse-to-fine search completado (branch feat/fase3-summary-embeddings).
> v9: Fase 5 chunking + auto-ingest completado (Issue #30, branch feat/fase5-chunking).
> v8: T-03 (query log + feedback loop) completado (PR #27, migration aplicada).
> v7: T-01 (denorm institution_id + RPC) y T-02 (tsvector + GIN) completados.
> v6: Todos los quick fixes aplicados (INC-1/3/6).
> v5: Cross-audit con codigo fuente real.
> v4: Appendix A con helper functions completas.
> v3: 3 errores corregidos, 12 gaps de investigacion integrados.

---

## Estado actual vs Blueprint + Investigacion

| # | Feature | Estado | Fuente |
|---|---|---|---|
| 1 | pgvector extension habilitada | **DONE** | blueprint |
| 2 | Columna `embedding` en `chunks` | **DONE** | blueprint |
| 3 | Columna `embedding` en `summaries` | **DONE** | blueprint → Fase 3 (migration `20260307_03`) |
| 4 | Columnas `fts TSVECTOR` generadas + GIN | **DONE** | blueprint → T-02 (PR #25) |
| 5 | Indices HNSW para vectores en chunks | **DONE** | blueprint (LA-04) |
| 6 | `rag_hybrid_search()` RPC | **DONE** | blueprint (LA-05) → optimizado T-01 + T-02 |
| 7 | `rag_query_log` tabla | **DONE** | blueprint → T-03 (PR #27) |
| 8 | Ruta de ingesta de embeddings | **DONE** | blueprint |
| 9 | Ruta de busqueda semantica + respuesta | **DONE** | blueprint |
| 10 | Generacion adaptativa (flashcards/quiz) | **DONE** | blueprint |
| 11 | Chunking inteligente (semantico) | **PARCIAL** | blueprint + chunking-strategies |
| 12 | Re-ranking | **DONE** | blueprint + hybrid-retrieval → Fase 6C |
| 13 | Ingestion multi-fuente (PDF, API) | **PENDIENTE** | blueprint |
| 14 | Auth + institution scoping | **DONE** | blueprint |
| 15 | Retry con backoff exponencial | **DONE** | blueprint |
| 16 | Denormalizacion institution_id | **DONE** | auditoria v2 → T-01 (PR #24) |
| 17 | Feedback loop (thumbs up/down) en RAG chat | **DONE** | auditoria v2 → T-03 (PR #27) |
| 18 | Monitoring de cobertura de embeddings | **DONE** | auditoria v2 → T-03 (PR #27) |
| 19 | Auto-ingest trigger | **DONE** | auditoria v2 → Issue #30 |
| 20 | Multi-Query Retrieval (+25% recall) | **DONE** | hybrid-retrieval.ts → Fase 6A |
| 21 | HyDE — Hypothetical Document Embeddings | **DONE** | hybrid-retrieval.ts → Fase 6B |
| 22 | Seleccion dinamica de estrategia de retrieval | **DONE** | hybrid-retrieval.ts → Fase 6D |
| 23 | Semantic Chunking (embedding-based boundaries) | **PENDIENTE** | chunking-strategies |
| 24 | Decision framework para estrategia de chunking | **PARCIAL** | chunking-strategies |
| 25 | NeedScore integration con /ai/generate | **DONE** | adaptive-ia-study → Fase 8A |
| 26 | Pre-generacion en background | **DONE** | adaptive-ia-study → Fase 8D |
| 27 | Rate limit especifico para AI (20/hr) | **DONE** | adaptive-ia-study → `routes/ai/index.ts` (INC-3) |
| 28 | Professor notes (kw_prof_notes) en prompt de generate | **DONE** | adaptive-ia-study → `routes/ai/generate.ts` (INC-6) |
| 29 | Report question / flag AI content | **DONE** | adaptive-ia-study → Fase 8B |
| 30 | Quality dashboard para preguntas AI flaggeadas | **DONE** | adaptive-ia-study → Fase 8C |
| 31 | chat.ts comentarios stale en header | **DONE** | auditoria v2 → `routes/ai/chat.ts` (INC-1) |

**Resumen: 27/31 completados, 2 pendientes, 2 parciales.**

> **Pendientes:**
> - #13 Ingestion multi-fuente (PDF, API) — Fase 7
> - #23 Semantic Chunking (embedding-based boundaries) — fase futura
>
> **Parciales:**
> - #11 Chunking inteligente: Recursive Character implementado como default (Fase 5). Semantic Chunking (embedding-based boundaries, #23) pendiente para fases futuras.
> - #24 Decision framework: Recursive = default implementado. Upgrade automatico a Semantic para docs largos pendiente.

---

## Errores corregidos en auditorias anteriores

| Error | Que decia | Realidad |
|---|---|---|
| **ERR-1** | "Indices HNSW: PENDIENTE" | Ya existe `idx_chunks_embedding` HNSW en migration `20260305_03` (LA-04) |
| **ERR-2** | "Full-text via `pg_trgm` en el RPC" | RPC usa `to_tsvector('spanish') + ts_rank()` (FTS estandar). `pg_trgm` es busqueda global |
| **ERR-3** | Fase 1 proponia crear indices HNSW | Redundante — eliminada, reemplazada por denormalizacion |
| **ERR-4** | Migration `20260305_03` comment: "Gemini text-embedding-004" | Modelo real es `gemini-embedding-001` (fix D-16). Comentario stale en migration aplicada |
| **ERR-5** | `get_course_summary_ids` parametro inconsistente | `ingest.ts` llamaba con `p_institution_id` pero RPC solo aceptaba `p_course_id`. Corregido con migration `20260304_05` que agrega overload `get_institution_summary_ids()` |

---

## Cross-audit: Fixes aplicados (2026-03-04)

> Estos fixes fueron identificados por un analisis cruzado automatizado
> entre este roadmap y el codigo fuente real del backend.

| Fix | INC | Descripcion | Migration/Archivo | Estado |
|---|---|---|---|---|
| Fix 5 | INC-5 | Nuevo RPC `get_institution_summary_ids(p_institution_id)` | `20260304_05` | **DONE** |
| Fix 5b | INC-7 | Denormalizar `institution_id` en summaries + trigger sync | `20260304_06` | **DONE** |
| Fix 6 | INC-4 | BACKEND_MAP.md actualizado de 13 a 26 migrations | `docs/BACKEND_MAP.md` | **DONE** |
| Fix 7 | INC-2 | RAG_ROADMAP.md actualizado con ERR-4, ERR-5, estados | `docs/RAG_ROADMAP.md` | **DONE** |
| Fix 8 | INC-1 | chat.ts header: embedding-001 + 2.5-flash | `routes/ai/chat.ts` | **DONE** |
| Fix 9 | INC-3 | AI rate limit middleware (20/hr via check_rate_limit RPC) | `routes/ai/index.ts` | **DONE** |
| Fix 10 | INC-6 | kw_prof_notes en generate.ts prompt | `routes/ai/generate.ts` | **DONE** |

**Todas las inconsistencias del cross-audit han sido resueltas.**

---

## Fase 1 — Performance: Denormalizar `institution_id` en summaries — DONE

**Prioridad:** ALTA — el RPC `rag_hybrid_search()` hacia un JOIN de 6 tablas en cada query.
**Riesgo:** MEDIO — requiere migration + trigger + actualizar el RPC.
**Impacto:** Elimina 4 JOINs por query (chunks->summaries->topics->sections->semesters->courses).
**Estado:** **DONE** — T-01 (PR #24). Migration `20260304_06` + RPC actualizado en SQL Editor.

### Problema actual

```sql
-- Cada query RAG ejecutaba este JOIN chain:
FROM chunks ch
  JOIN summaries s ON s.id = ch.summary_id
  JOIN topics t ON t.id = s.topic_id
  JOIN sections sec ON sec.id = t.section_id
  JOIN semesters sem ON sem.id = sec.semester_id
  JOIN courses c ON c.id = sem.course_id
WHERE c.institution_id = p_institution_id
```

### Migration SQL

```sql
-- Archivo: supabase/migrations/20260304_06_denorm_institution_id.sql (APPLIED)

-- 1. Agregar columna denormalizada
ALTER TABLE summaries
  ADD COLUMN IF NOT EXISTS institution_id UUID REFERENCES institutions(id);

-- 2. Backfill desde la jerarquia existente
UPDATE summaries s
SET institution_id = c.institution_id
FROM topics t
  JOIN sections sec ON sec.id = t.section_id
  JOIN semesters sem ON sem.id = sec.semester_id
  JOIN courses c ON c.id = sem.course_id
WHERE t.id = s.topic_id
  AND s.institution_id IS NULL;

-- 3. Indice para filtro directo
CREATE INDEX IF NOT EXISTS idx_summaries_institution_id
  ON summaries (institution_id);

-- 4. Trigger para mantener sincronizado
CREATE OR REPLACE FUNCTION sync_summary_institution_id()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  SELECT c.institution_id INTO NEW.institution_id
  FROM topics t
    JOIN sections sec ON sec.id = t.section_id
    JOIN semesters sem ON sem.id = sec.semester_id
    JOIN courses c ON c.id = sem.course_id
  WHERE t.id = NEW.topic_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_summary_institution_sync
  BEFORE INSERT OR UPDATE OF topic_id ON summaries
  FOR EACH ROW
  EXECUTE FUNCTION sync_summary_institution_id();
```

### RPC actualizado completo (Fase 1 + Fase 2 combinadas)

Ver [Appendix A > rag_hybrid_search v2](#a3-rag_hybrid_search-v2-despues-de-fase-1--fase-2) para la funcion completa.

---

## Fase 2 — Columnas tsvector generadas + GIN index — DONE

**Prioridad:** MEDIA — mejora performance de FTS sin cambiar logica.
**Riesgo:** BAJO — columnas generated son transparentes.
**Impacto:** Ahorra CPU de `to_tsvector()` inline por fila + habilita pre-filtro GIN.
**Estado:** **DONE** — T-02 (PR #25). Migration `20260306_03` aplicada en SQL Editor.

### Migration SQL

```sql
-- Archivo: supabase/migrations/20260306_03_tsvector_gin_columns.sql (APPLIED)

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('spanish', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_chunks_fts ON chunks USING gin (fts);

ALTER TABLE summaries
  ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('spanish', coalesce(title, '') || ' ' || coalesce(content_markdown, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_summaries_fts ON summaries USING gin (fts);
```

### Cambio en `rag_hybrid_search()` RPC

```sql
-- ANTES: ts_rank(to_tsvector('spanish', ch.content), ...)
-- DESPUES: ts_rank(ch.fts, ...)  -- stored column, pre-computado
-- Aplicado en el mismo migration file (CREATE OR REPLACE)
```

---

## Fase 3 — Embeddings en summaries (coarse-to-fine) — DONE

**Prioridad:** MEDIA — busqueda en 2 niveles.
**Riesgo:** MEDIO — requiere cambio en ingest + nuevo RPC.
**Impacto:** Queries amplias encuentran mejor match a nivel summary.
**Estado:** **DONE** — Branch `feat/fase3-summary-embeddings`. Migration `20260307_03`.

> **Relacion con investigacion:** Esto es la version "macro" del **Parent-Child Chunking**
> descrito en `chunking-strategies.md`. Summary=parent, Chunks=children.
> La busqueda encuentra el child (chunk) pero usa el parent (summary) para contexto amplio.

### Sub-tasks completados (Fase 3)

| # | Sub-task | Archivo | Commit |
|---|---|---|---|
| 3.1 | Migration: `summaries.embedding vector(768)` + HNSW index + `rag_coarse_to_fine_search()` RPC | `migrations/20260307_03_summary_embeddings.sql` | `ec614b2` |
| 3.2 | `truncateAtWord()` — word-boundary safe truncation utility | `auto-ingest.ts` | `0645aea` |
| 3.3 | `embedSummaryContent()` — standalone summary embedding function + pipeline Step 8 | `auto-ingest.ts` | `0645aea` |
| 3.4 | `ingest.ts` — batch summary embedding via `target="summaries"` param | `routes/ai/ingest.ts` | `0e7248d` |
| 3.5 | `chat.ts` — coarse-to-fine search integration + fallback chain + `normalizeCoarseToFineResults()` | `routes/ai/chat.ts` | `3694e9d` |
| 3.6 | 8 tests for `truncateAtWord()` + type assertion for `AutoIngestResult.summary_embedded` | `tests/fase3_test.ts` | `93ecd92` |
| 3.7 | RAG_ROADMAP.md update (this section) | `docs/RAG_ROADMAP.md` | — |
| A1 | Audit fix: cosine distance computed once per row in `rag_coarse_to_fine_search()` | `migrations/20260307_03_summary_embeddings.sql` | `656ac84` |

### Arquitectura de busqueda (Fase 3)

```
Usuario envia query
    |
    v
generateEmbedding(query, "RETRIEVAL_QUERY") → 768d vector
    |
    v
summary_id dado?
    |
    |-- SI → rag_hybrid_search(summary_id=...)  [FTS + vector, scoped]
    |        searchType = "hybrid"
    |
    +-- NO → rag_coarse_to_fine_search()  [2-stage vector]
             |
             |-- resultados > 0 → normalizeCoarseToFineResults()
             |                   searchType = "coarse_to_fine"
             |
             +-- resultados = 0 → FALLBACK: rag_hybrid_search(summary_id=null)
                                 searchType = "hybrid_fallback"
    |
    v
fetchAdjacentChunks() → assembleContext() → generateText()
    |
    v
Log: search_type = searchType + (wasAugmented ? "_augmented" : "")
```

### Decisiones arquitectonicas clave

| # | Decision | Razonamiento |
|---|---|---|
| D1 | Score = 0.3*summary + 0.7*chunk | El chunk contiene la informacion especifica; 50/50 sobre-rankea summaries con chunks mediocres |
| D2 | Global LIMIT (no per-summary) | Si un summary tiene los 5 mejores chunks, los queremos todos |
| D3 | Partial HNSW index (`WHERE NOT NULL`) | Zero overhead durante transicion; summaries sin embedding no indexados |
| D4 | CTE `summary_scored` computa distancia 1x (A1 fix) | Evita 3x computacion en SELECT/WHERE/ORDER BY |
| D5 | `embedSummaryContent` throws, caller decides | Pipeline (non-fatal) vs batch (counts failed) vs direct (propagates) |
| D6 | `truncateAtWord` max 8000 chars | Gemini embedding-001 soporta ~10K tokens; 8000 chars = 2K-2.5K tokens de margen |
| D7 | Fallback chain: c2f → hybrid → empty | Transicion gradual: summaries sin embedding siguen encontrables via hybrid |

---

## Fase 4 — Query logging + Feedback loop — DONE

**Prioridad:** MEDIA — analytics + mejora iterativa.
**Riesgo:** BAJO — tabla nueva, inserts async.
**Impacto:** Medir calidad y mejorar el sistema con datos reales.
**Estado:** **DONE** — T-03 (PR #27). Migration `20260305_04` aplicada en SQL Editor.

### Migration SQL

```sql
-- Archivo: supabase/migrations/20260305_04_rag_query_log.sql (APPLIED)

CREATE TABLE IF NOT EXISTS rag_query_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  institution_id UUID NOT NULL REFERENCES institutions(id),
  query_text TEXT NOT NULL,
  summary_id UUID REFERENCES summaries(id),
  results_count INT NOT NULL DEFAULT 0,
  top_similarity FLOAT,
  avg_similarity FLOAT,
  latency_ms INT,
  search_type TEXT NOT NULL DEFAULT 'hybrid',
  model_used TEXT,
  feedback SMALLINT CHECK (feedback IN (-1, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rag_query_log_inst_date
  ON rag_query_log (institution_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rag_query_log_user
  ON rag_query_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rag_query_log_negative
  ON rag_query_log (institution_id, feedback) WHERE feedback = -1;

ALTER TABLE rag_query_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY rag_log_select_own ON rag_query_log FOR SELECT
  USING (user_id = auth.uid());
CREATE POLICY rag_log_select_institution ON rag_query_log FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = auth.uid()
      AND m.institution_id = rag_query_log.institution_id
      AND m.role IN ('owner','admin') AND m.is_active = TRUE)
  );
CREATE POLICY rag_log_update_feedback ON rag_query_log FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- INSERT via adminClient (bypass RLS) — no INSERT policy needed
```

### RPCs

```sql
-- rag_analytics_summary(p_institution_id, p_from, p_to) → metricas agregadas
-- rag_embedding_coverage(p_institution_id) → % chunks con embedding
-- Ambos SECURITY DEFINER, validacion de rol admin/owner en el TS code
```

### Endpoints implementados

- `PATCH /ai/rag-feedback` — `{ log_id, feedback: 1|-1 }` — actualiza feedback del usuario
- `GET /ai/rag-analytics?institution_id=&from=&to=` — metricas agregadas (admin/owner)
- `GET /ai/embedding-coverage?institution_id=` — cobertura de embeddings (admin/owner)
- `POST /ai/rag-chat` — ahora devuelve `log_id` en response para vincular feedback

---

## Fase 5 — Chunking inteligente + Auto-ingest — DONE

**Prioridad:** MEDIA-ALTA — chunking actual es basico, afecta calidad directamente.
**Riesgo:** MEDIO — requiere re-ingest.
**Impacto:** Mejor coherencia semantica = mejor retrieval = mejores respuestas.
**Estado:** **DONE** — Issue #30 (branch `feat/fase5-chunking`). Sub-tasks 5.1-5.10 completados.

### Archivos creados/modificados (Fase 5)

| Archivo | Tipo | Descripcion |
|---|---|---|
| `chunker.ts` | Nuevo | Motor de chunking: Recursive Character Splitting con respeto a limites markdown |
| `auto-ingest.ts` | Nuevo | Pipeline puro: fetch summary → chunk → delete old → insert new → embed → update timestamp |
| `summary-hook.ts` | Nuevo | afterWrite hook con 3 gates: update field check, ID extraction, content check |
| `routes/ai/re-chunk.ts` | Nuevo | POST /ai/re-chunk — endpoint sincrono para re-chunking manual (profesor) |
| `routes/ai/index.ts` | Modificado | Mount de `aiReChunkRoutes` |
| `crud-factory.ts` | Modificado | `AfterWriteParams` type + `afterWrite?` callback en CrudConfig + fire-and-forget en POST/PUT |
| `routes/content/crud.ts` | Modificado | `afterWrite: onSummaryWrite` en config de summaries |
| `tests/summary_hook_test.ts` | Nuevo | 9 tests: gate logic (8 skip paths + 1 fire path) |
| Migration `20260307_02` | Nuevo | Columnas `chunk_strategy TEXT DEFAULT 'recursive'` + `last_chunked_at TIMESTAMPTZ` en summaries |

### Sub-tasks completados

| # | Sub-task | Commits |
|---|---|---|
| 5.1 | `chunker.ts` — Recursive Character Splitting | Branch inicial |
| 5.2 | 10 unit tests para chunker + 3 fixes auditoria R2 | Branch inicial |
| 5.3 | Fixtures de test (markdown samples) | Branch inicial |
| 5.4 | Migration: `chunk_strategy` + `last_chunked_at` | Branch inicial |
| 5.5 | `auto-ingest.ts` — funcion pura `autoChunkAndEmbed` + 1 fix R1 | `3026a31` |
| 5.6 | `routes/ai/re-chunk.ts` — POST /ai/re-chunk | `3026a31` |
| 5.7 | Mount `aiReChunkRoutes` en AI module combiner | `01de895` |
| 5.8 | Fire-and-forget hook en POST/PUT summaries | `a883931`, `2b6f5b7`, `de5095f` |
| 5.9 | 9 tests para `onSummaryWrite` gate logic | `aae4eb0`, `3d2fdab` |
| 5.10 | Actualizar RAG_ROADMAP.md | `d1046c4` |

### Decision framework (de `chunking-strategies.md`)

| Estrategia | Calidad | Velocidad | Costo | Recomendado para |
|---|---|---|---|---|
| **Recursive Character** | Buena | Rapida | Gratis | Volumenes altos, contenido bien estructurado |
| **Semantic** | Muy Buena | Media | Bajo (1 embed/parrafo) | Resumenes multi-tema |
| **Parent-Child** | Excelente | Media | Bajo | Contexto completo necesario |
| **Agentic** | Superior | Lenta | Alto (1 LLM call/doc) | Contenido critico de alta prioridad |

### Recomendacion para Axon

**Implementar Recursive Character como default** (gratis, rapido, buen baseline),
con **upgrade a Semantic** para summaries largos (>2000 tokens).

### Implementacion completa: `chunker.ts`

Ver [Appendix A > chunkMarkdown()](#a1-chunkertsimplementacion-completa) para el codigo completo.

---

## Fase 6 — Retrieval avanzado (Multi-Query + HyDE + Re-ranking) — DONE

**Prioridad:** MEDIA — mejora significativa de recall y precision.
**Riesgo:** MEDIO — agrega llamadas Gemini extra (mitigado con degradacion graceful).
**Impacto:** +25-40% recall/precision segun la estrategia.
**Estado:** **DONE** — Branch `feat/fase6-retrieval-avanzado`. Migration `20260309_01`.

> **Fuente:** `hybrid-retrieval.ts` de la investigacion describe 4 estrategias.
> La #1 (Hybrid RRF) ya estaba implementada. Fase 6 implementa #2 (Multi-Query),
> #3 (HyDE), y #4 (Re-ranking) con seleccion dinamica.

### Archivos creados/modificados (Fase 6)

| Archivo | Tipo | Descripcion |
|---|---|---|
| `retrieval-strategies.ts` | Nuevo | Funciones puras: generateMultiQueries, generateHypotheticalDocument, rerankWithGemini, mergeSearchResults, selectStrategy, executeRetrievalEmbedding |
| `routes/ai/chat.ts` | Modificado | Integracion de strategies: N-search loop, merge, rerank, strategy metadata en response |
| `tests/retrieval_strategies_test.ts` | Nuevo | 11 tests: mergeSearchResults (5), selectStrategy (4), score blend (1), priority (1) |
| Migration `20260309_01` | Nuevo | Columnas `retrieval_strategy TEXT` + `rerank_applied BOOLEAN` en rag_query_log |

### Sub-tasks completados

| Par | Sub-tasks | Descripcion | Commits |
|---|---|---|---|
| Par 1 | 6.1 + 6.2 | `retrieval-strategies.ts` + tests unitarios | `ca8ed99` |
| Audit R1 | fix | selectStrategy priority order (historyLength before wordCount) | `a51aa60` |
| Par 2 | 6.3 + 6.4 | Migration `20260309_01` + chat.ts integracion completa | `36eeed6` |
| Docs | 6.5 + 6.6 | BACKEND_MAP.md + RAG_ROADMAP.md v12 | `e983a1b` |

### Arquitectura de retrieval (Fase 6)

```
Usuario envia query + history + optional strategy param
    |
    v
selectStrategy(message, summaryId, historyLength)
  OR client override (body.strategy)
    |
    v
+------------------+--------------------+------------------+
| standard         | multi_query        | hyde             |
| (summaryId dado) | (query larga OR    | (query corta,    |
|                  |  history > 2)      |  ≤5 palabras)    |
+------------------+--------------------+------------------+
    |                    |                    |
    v                    v                    v
1 embedding         3 embeddings          1 embedding
(query original)    (original + 2         (hipotesis de
                     reformulaciones       Gemini, no query)
                     en paralelo, D21)     taskType=DOC, D24)
    |                    |                    |
    +--------------------+--------------------+
    |
    v
POR CADA embedding: search (hybrid o c2f)
    |
    v
mergeSearchResults() — dedup por chunk_id, max score
    |
    v
rerankWithGemini() — Gemini scores 0-10, blend 0.6×rerank + 0.4×original (D23)
    |
    v
fetchAdjacentChunks() → assembleContext() → generateText()
    |
    v
Log: retrieval_strategy + rerank_applied + strategy metadata
```

### Decisiones arquitectonicas (D19-D30)

| # | Decision | Razonamiento |
|---|---|---|
| D19 | Archivo separado `retrieval-strategies.ts` | chat.ts ya tenia 21KB; separar mantiene cohesion |
| D20 | Re-ranking siempre (si >1 resultado) | Gemini-as-Judge mejora precision sin costo de embedding |
| D21 | Embeddings en paralelo (multi-query) | Promise.all para 3 embeddings, ~misma latencia que 1 |
| D22 | Client override via `body.strategy` | Permite testing A/B y debug sin cambiar backend |
| D23 | Score blend 0.6×rerank + 0.4×original | Preserva signal original; Gemini refina, no reemplaza |
| D24 | HyDE reemplaza query (no la combina) | Investigacion muestra que hypothesis embedding es superior |
| D25 | Re-rank usa todos los chunks de input | chat.ts ya limita a 8; re-ranker no necesita su propio limit |
| D26 | Columnas separadas strategy vs search_type | search_type = metodo de busqueda; strategy = tecnica de retrieval |
| D27 | 2 reformulaciones (no 3) | Ahorra RPM de Gemini sin sacrificar recall significativo |
| D28 | Temperature 0.8 para reformulaciones | Diversidad de sinonimos y perspectivas |
| D29 | Temperature 0.0 para re-ranking | Determinismo en scoring de relevancia |
| D30 | Temperature 0.3 para HyDE | Factual pero con algo de variacion |

### Exported types (de `retrieval-strategies.ts`)

```typescript
export interface MatchedChunk {
  chunk_id: string;
  summary_id: string;
  summary_title: string;
  content: string;
  similarity: number;
  text_rank: number;
  combined_score: number;
}

export type RetrievalStrategy = "standard" | "multi_query" | "hyde";

export interface RetrievalEmbeddingOutput {
  embeddings: Array<{ query: string; embedding: number[] }>;
  strategyMeta: Record<string, unknown>;
}
```

### Funciones exportadas

| Funcion | Tipo | Descripcion |
|---|---|---|
| `selectStrategy(msg, summaryId, histLen)` | Pure | Auto-selecciona strategy basada en query characteristics |
| `generateMultiQueries(query)` | Async | Gemini genera 2 reformulaciones (graceful: returns []) |
| `generateHypotheticalDocument(query)` | Async | Gemini genera hipotesis 2-3 oraciones (graceful: returns "") |
| `rerankWithGemini(query, chunks, topK)` | Async | Gemini scores relevancia 0-10, blend con original (graceful: returns original) |
| `mergeSearchResults(sets)` | Pure | Dedup por chunk_id, keep max score, sort descending |
| `executeRetrievalEmbedding(strategy, query, embedFn?)` | Async | Orchestrator: ejecuta embedding(s) segun strategy |

### Cambios en `POST /ai/rag-chat` (chat.ts)

- **Nuevo param:** `strategy?: "auto" | "standard" | "multi_query" | "hyde"` (default: "auto")
- **Import:** MatchedChunk ahora viene de retrieval-strategies.ts (antes inline)
- **Pipeline:** selectStrategy → executeRetrievalEmbedding → N searches → merge → rerank → context
- **Response `_search`:** agrega `strategy`, `rerank_applied`, y metadata de la strategy usada
- **Log:** inserta `retrieval_strategy` y `rerank_applied` en rag_query_log
- **Backward compatible:** sin param `strategy` = "auto" = misma logica que pre-Fase 6

### Migration SQL

```sql
-- Archivo: supabase/migrations/20260309_01_retrieval_strategy_log.sql (PENDING)

ALTER TABLE rag_query_log
  ADD COLUMN IF NOT EXISTS retrieval_strategy TEXT NOT NULL DEFAULT 'standard';

ALTER TABLE rag_query_log
  ADD COLUMN IF NOT EXISTS rerank_applied BOOLEAN NOT NULL DEFAULT FALSE;
```

### Auditoria R1 — Bug corregido

| Issue | Severidad | Fix |
|---|---|---|
| `selectStrategy()` evaluaba `wordCount <= 5` antes de `historyLength > 2` | **Bug** | Reordenar: check historyLength primero (mayor prioridad) |
| `assertNotEquals` importado pero no usado en tests | Low | Removido |

**Tracing del bug:**
```
selectStrategy("¿Y luego?", null, 4)
  ANTES: wordCount=2 ≤ 5 → return "hyde" ← INCORRECTO
  DESPUES: historyLength=4 > 2 → return "multi_query" ← CORRECTO
```

### Advisory issues documentados (no-blocking)

| Issue | Severidad | Descripcion |
|---|---|---|
| A1 | Low | Log INSERT incluye columnas de migration `20260309_01`. Si migration no aplicada, INSERT falla silenciosamente (fire-and-forget). Se autocorrige al aplicar migration. |

### Costo estimado Gemini API (free tier)

| Strategy | Calls Gemini extra | Embeddings extra | Impacto en RPM |
|---|---|---|---|
| standard | 0 (rerank only: +1) | 0 | +1 gen call |
| multi_query | +1 (reformulations) + 1 (rerank) | +2 | +2 gen, +2 embed |
| hyde | +1 (hypothesis) + 1 (rerank) | 0 (reemplaza, no agrega) | +2 gen |

> Free tier: 1500 RPM embed, 15 RPM gen. En el peor caso (multi_query),
> una query usa 3 RPM gen (reformulation + rerank + response) y 3 RPM embed.
> Con 15 RPM gen, maximo ~5 queries/min concurrentes. Aceptable para desarrollo.

---

## Fase 7 — Ingestion multi-fuente (PDF, API)

**Prioridad:** BAJA — actualmente los profesores escriben en `content_markdown`.
**Riesgo:** ALTO — parsing de PDF es complejo.
**Impacto:** Desbloquea upload de materiales existentes.

---

## Fase 8 — IA Adaptativa: NeedScore + Pre-generacion + Calidad — DONE

**Prioridad:** MEDIA — mejora la experiencia del alumno significativamente.
**Riesgo:** MEDIO — varios cambios en generate.ts + nuevos endpoints.
**Impacto:** Generacion mas inteligente + mecanismos de calidad.
**Estado:** **DONE** — Branch `feat/fase8-ia-adaptativa`. 4 pares, 8 sub-tasks completados.

### Archivos creados/modificados (Fase 8)

| Archivo | Tipo | Fase | Descripcion |
|---|---|---|---|
| Migration `20260308_01` | Nuevo | 8A | RPC `get_smart_generate_target()` — NeedScore-based keyword selection |
| `routes/ai/generate-smart.ts` | Nuevo | 8A | POST /ai/generate-smart — adaptive generation with auto-target |
| Migration `20260308_02` | Nuevo | 8B | Tabla `ai_content_reports` + indexes + RLS |
| `routes/ai/report.ts` | Nuevo | 8B | POST /ai/report + PATCH /ai/report/:id — content quality reporting |
| Migration `20260308_03` | Nuevo | 8C | RPC `get_ai_report_stats()` — aggregate quality metrics |
| `routes/ai/report-dashboard.ts` | Nuevo | 8C | GET /ai/report-stats + GET /ai/reports — dashboard + listing |
| `routes/ai/pre-generate.ts` | Nuevo | 8D | POST /ai/pre-generate — bulk content pre-generation |
| `routes/ai/index.ts` | Modificado | ALL | Mount all new sub-modules + rate limit exclusions |

### Sub-tasks completados

| Par | Sub-tasks | Descripcion | Commits |
|---|---|---|---|
| Par 1 | 8.1 + 8.2 | `get_smart_generate_target` RPC + `generate-smart.ts` endpoint | Branch inicial |
| Par 2 | 8.3 + 8.4 | `ai_content_reports` migration + `report.ts` endpoint (POST + PATCH) | Branch |
| Par 3 | 8.5 + 8.6 | `get_ai_report_stats` RPC + `report-dashboard.ts` (GET stats + GET listing) | `9b10d04` |
| Par 4 | 8.7 + 8.8 | `pre-generate.ts` endpoint + mount in index.ts | `c4e6377` |

### Decisiones arquitectonicas aprobadas

| ID | Decision | Justificacion |
|---|---|---|
| D1 | RPC retorna TOP 5 targets, no 1 | Permite dedup en TypeScript sin re-llamar al RPC |
| D2 | Dedup en TypeScript, no SQL | Evita subquery correlacionada en SQL (N+1 risk) |
| D3 | NO refactorizar `generate.ts` | Zero riesgo de regresion en el endpoint existente (SACRED) |
| D9 | Pre-gen tiene bucket de rate limit separado | `ai-pregen:{userId}` (10/hr) vs `ai:{userId}` (20/hr) |
| D14 | Pre-gen usa CONTENT_WRITE_ROLES | Solo profesores/admins pre-generan contenido |
| D15 | Generacion secuencial en pre-gen | Respeta RPM de Gemini, error handling limpio |
| D16 | Respuesta partial-success en pre-gen | 3 de 5 exitosos = retorna los 3 + 2 errores |
| D17 | Sin student profile en pre-gen prompt | Contenido generico para TODOS los students |
| D18 | Keywords por menor cobertura AI | Llena gaps primero (0 items > 3 items) |

### Endpoints implementados (Fase 8)

| Method | Path | File | Auth | Description |
|---|---|---|---|---|
| POST | `/ai/generate-smart` | generate-smart.ts | ALL_ROLES | Adaptive generation (NeedScore auto-target) |
| POST | `/ai/report` | report.ts | ALL_ROLES | Report AI content quality issue |
| PATCH | `/ai/report/:id` | report.ts | CONTENT_WRITE_ROLES | Resolve/dismiss a report |
| GET | `/ai/report-stats` | report-dashboard.ts | CONTENT_WRITE_ROLES | Aggregate quality metrics |
| GET | `/ai/reports` | report-dashboard.ts | CONTENT_WRITE_ROLES | Paginated report listing |
| POST | `/ai/pre-generate` | pre-generate.ts | CONTENT_WRITE_ROLES | Bulk content pre-generation |

### Advisory issues documentados (no-blocking)

| Par | Issue | Severidad | Justificacion |
|---|---|---|---|
| Par 1 | A7: Validacion JSON Gemini pre-existente | Low | `parseGeminiJson()` no valida schema, solo parsea JSON |
| Par 1 | A8: Full keyword scan pre-LIMIT en RPC | Low | RPC scans all keywords, LIMIT 5 at the end |
| Par 2 | A7-TS: Sin state machine en PATCH status | Low | CHECK constraint en DB valida, TS no enforcea transiciones |
| Par 2 | A8-TS: JS clock vs DB now() | Low | `new Date().toISOString()` vs DB `now()` — drift <1s |
| Par 2 | B1: resolution_note sin length check | Low | TEXT column, no CHECK en DB |
| Par 3 | A1: parsePagination() duplicada | Low | No exportada de crud-factory, 6 lineas |
| Par 3 | A2: Filter arrays duplicados | Low | Source of truth es DB CHECK constraint |
| Par 4 | A1: truncateAtWord() en 3 archivos | Low | No exportada, 5 lineas cada una |
| Par 4 | A5: Rate limit cuenta REQUEST no ITEMS | Info | Design decision, 10 req x 5 items = 50 max |

### 8A. NeedScore integration con `/ai/generate-smart` — **DONE**

El `NeedScore` ya existe en `routes-study-queue.tsx`:
```
NeedScore = 0.40*overdue + 0.30*(1-p_know) + 0.20*fragility + 0.10*novelty
```

Implementado como POST `/ai/generate-smart` que:
1. Llama al RPC `get_smart_generate_target()` → top 5 keywords por NeedScore
2. Dedup check: skip keywords con contenido AI reciente (ventana 2h)
3. Elige el mejor target → prompt adaptativo → Gemini → insert → return
4. Temperatura adaptativa segun p_know (0.5 bajo, 0.7 medio, 0.85 alto)
5. Respuesta incluye `_smart` metadata (razon de seleccion, NeedScore, p_know)

Migration: `20260308_01_smart_generate_target_rpc.sql`

### 8B. Report question / Flag AI content — **DONE**

Implementado como:
- `POST /ai/report` — student reporta contenido AI de baja calidad
- `PATCH /ai/report/:id` — profesor/admin resuelve el reporte

Tabla: `ai_content_reports` con status workflow (pending → reviewed → resolved/dismissed).
Auth: POST usa ALL_ROLES (students reportan), PATCH usa CONTENT_WRITE_ROLES (profesores resuelven).
`institution_id` resuelto server-side via `resolve_parent_institution()`.

Migration: `20260308_02_ai_content_reports.sql`

### 8C. Quality dashboard — **DONE**

Implementado como:
- `GET /ai/report-stats?institution_id=&from=&to=` — 14 metricas agregadas via RPC
- `GET /ai/reports?institution_id=&status=&reason=&content_type=&limit=&offset=` — listado paginado

RPC: `get_ai_report_stats()` — counts por status/reason/content_type + avg resolution hours.
Listado: exact count, created_at DESC, filtros validados con isOneOf().
Auth: CONTENT_WRITE_ROLES (profesores ven y resuelven reportes).

Migration: `20260308_03_ai_report_stats_rpc.sql`

### 8D. Pre-generacion en background — **DONE**

Implementado como POST `/ai/pre-generate`:
- Input: `{ summary_id, action, count? }` (max 5 items)
- Seleccion de keywords por menor cobertura AI (fill gaps first)
- Generacion secuencial con partial-success response
- Rate limit separado: `ai-pregen:{userId}`, 10 req/hr
- Sin student profile en prompt (contenido generico)
- Respuesta: `{ generated: [...], errors: [...], _meta: {...} }`

No requirio nueva migration (usa tablas existentes + check_rate_limit RPC).

### 8E. Professor notes en prompt de generate.ts — **DONE** (INC-6)

Aplicado en `routes/ai/generate.ts` y replicado en `generate-smart.ts` y `pre-generate.ts`:
```typescript
const { data: profNotes } = await db
  .from("kw_prof_notes")
  .select("note")
  .eq("keyword_id", keywordId)
  .limit(3);

if (profNotes && profNotes.length > 0) {
  blockContext += "\nNotas del profesor: " +
    profNotes.map((n: { note: string }) => n.note).join("; ");
}
```

### 8F. Rate limit especifico para AI — **DONE** (INC-3)

Aplicado en `routes/ai/index.ts`:
- Middleware `aiRateLimitMiddleware` con `check_rate_limit()` RPC
- 20 req/hr por usuario, solo POST, degradacion graceful
- Usa la tabla `rate_limit_entries` de migration `20260303_02`
- Pre-generate excluido (tiene su propio bucket separado, D9)

---

## Orden de implementacion recomendado

```
Fase 1: Denormalizar institution_id   [DONE]   [T-01, PR #24]   [migration aplicada en SQL Editor]
  |
Fase 2: Columnas tsvector + GIN      [DONE]   [T-02, PR #25]   [migration aplicada en SQL Editor]
  |
Fase 4: Query log + feedback          [DONE]   [T-03, PR #27]   [migration aplicada en SQL Editor]
  |
Fase 5: Chunking + auto-ingest        [DONE]   [Issue #30]      [mejora calidad RAG]
  |
Fase 3: Embeddings en summaries       [DONE]   [Fase 3 branch]  [coarse-to-fine search]
  |
Fase 8: IA adaptativa                 [DONE]   [feat/fase8]     [NeedScore + pre-gen + calidad]
  |
Fase 6: Retrieval avanzado            [DONE]   [feat/fase6]     [Multi-Query + HyDE + re-rank]
  |
Fase 7: Ingestion PDF                 [3 dias] [nuevo modulo]   [feature nueva]
```

**Total estimado: ~3 dias restantes (Fase 7 unicamente)**

---

## Housekeeping: Quick fixes

### INC-1: chat.ts — Comentarios stale en header — **DONE**

Corregido: header ahora dice `gemini-embedding-001` y `Gemini 2.5 Flash`.

### INC-6: generate.ts — Professor notes — **DONE**

Corregido: fetch de `kw_prof_notes` agregado despues del fetch de keyword.

### INC-3: routes/ai/index.ts — AI rate limit — **DONE**

Corregido: middleware con `check_rate_limit()` RPC, 20 req/hr, solo POST.

### Migracion de dimensiones: checklist completa

1. `EMBEDDING_DIMENSIONS` en `gemini.ts`
2. `ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(NEW_DIM)`
3. `ALTER TABLE summaries ALTER COLUMN embedding TYPE vector(NEW_DIM)` (Fase 3 — DONE)
4. Function signature: `p_query_embedding vector(768)` en `rag_hybrid_search()`
5. Function signature: `p_query_embedding vector(768)` en `rag_coarse_to_fine_search()` (Fase 3 — DONE)
6. Re-ingest ALL chunks y summaries
7. Recrear indices HNSW

---

## Adaptaciones especificas para Gemini

| Aspecto | Blueprint original (OpenAI) | Adaptacion Gemini |
|---|---|---|
| Modelo embeddings | `text-embedding-3-large` (1536/3072) | `gemini-embedding-001` (768 via `outputDimensionality`) |
| Modelo generacion | GPT-4 / GPT-3.5 | `gemini-2.5-flash` (via `GENERATE_MODEL`) |
| Cross-encoder | Cohere Rerank | Gemini-as-Reranker JSON scores (Fase 6C) |
| Multi-Query | N/A | Gemini genera reformulaciones (Fase 6A) |
| HyDE | N/A | Gemini genera documento hipotetico (Fase 6B) |
| API Key | `OPENAI_API_KEY` | `GEMINI_API_KEY` (ya configurada) |
| Costo embeddings | ~$0.13/1M tokens | Gratis (free tier, rate limit 429) |
| Rate limiting | Token-based | RPM-based (1500 RPM embed, 15 RPM gen) |
| PDF extraction | pdf-parse | Gemini multimodal (PDF como input) |
| Max input embed | 8191 tokens | ~10k tokens |

---

## Migracion futura a OpenAI

1. Editar `generateEmbedding()` en `gemini.ts`
2. Cambiar `EMBEDDING_DIMENSIONS` de 768 a 1536
3. Migrations: ALTER columns + function signatures (ver checklist arriba)
4. Re-ingest ALL chunks y summaries
5. Recrear indices HNSW

> **Recomendacion:** No migrar a menos que la calidad de retrieval sea insuficiente.
> El free tier de Gemini es una ventaja durante desarrollo.
