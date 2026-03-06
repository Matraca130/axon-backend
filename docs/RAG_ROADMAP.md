# RAG Roadmap — Blueprint completo con Gemini

> Plan de implementacion para completar todo lo propuesto en los documentos
> de investigacion (`pgvector-axon-integration.md`, `axon-rag-architecture.md`,
> `chunking-strategies.md`, `hybrid-retrieval.ts`, `adaptive-ia-study.md`),
> adaptado a Gemini como provider inicial.
>
> **Auditoria v9:** 2026-03-06 — Fase 5 chunking + auto-ingest completado (Issue #30, branch feat/fase5-chunking).
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
| 3 | Columna `embedding` en `summaries` | **PENDIENTE** | blueprint |
| 4 | Columnas `fts TSVECTOR` generadas + GIN | **DONE** | blueprint → T-02 (PR #25) |
| 5 | Indices HNSW para vectores en chunks | **DONE** | blueprint (LA-04) |
| 6 | `rag_hybrid_search()` RPC | **DONE** | blueprint (LA-05) → optimizado T-01 + T-02 |
| 7 | `rag_query_log` tabla | **DONE** | blueprint → T-03 (PR #27) |
| 8 | Ruta de ingesta de embeddings | **DONE** | blueprint |
| 9 | Ruta de busqueda semantica + respuesta | **DONE** | blueprint |
| 10 | Generacion adaptativa (flashcards/quiz) | **DONE** | blueprint |
| 11 | Chunking inteligente (semantico) | **PARCIAL** | blueprint + chunking-strategies |
| 12 | Re-ranking | **PENDIENTE** | blueprint + hybrid-retrieval |
| 13 | Ingestion multi-fuente (PDF, API) | **PENDIENTE** | blueprint |
| 14 | Auth + institution scoping | **DONE** | blueprint |
| 15 | Retry con backoff exponencial | **DONE** | blueprint |
| 16 | Denormalizacion institution_id | **DONE** | auditoria v2 → T-01 (PR #24) |
| 17 | Feedback loop (thumbs up/down) en RAG chat | **DONE** | auditoria v2 → T-03 (PR #27) |
| 18 | Monitoring de cobertura de embeddings | **DONE** | auditoria v2 → T-03 (PR #27) |
| 19 | Auto-ingest trigger | **DONE** | auditoria v2 → Issue #30 |
| 20 | Multi-Query Retrieval (+25% recall) | **PENDIENTE** | hybrid-retrieval.ts |
| 21 | HyDE — Hypothetical Document Embeddings | **PENDIENTE** | hybrid-retrieval.ts |
| 22 | Seleccion dinamica de estrategia de retrieval | **PENDIENTE** | hybrid-retrieval.ts |
| 23 | Semantic Chunking (embedding-based boundaries) | **PENDIENTE** | chunking-strategies |
| 24 | Decision framework para estrategia de chunking | **PARCIAL** | chunking-strategies |
| 25 | NeedScore integration con /ai/generate | **PENDIENTE** | adaptive-ia-study |
| 26 | Pre-generacion en background | **PENDIENTE** | adaptive-ia-study |
| 27 | Rate limit especifico para AI (20/hr) | **DONE** | adaptive-ia-study → `routes/ai/index.ts` (INC-3) |
| 28 | Professor notes (kw_prof_notes) en prompt de generate | **DONE** | adaptive-ia-study → `routes/ai/generate.ts` (INC-6) |
| 29 | Report question / flag AI content | **PENDIENTE** | adaptive-ia-study |
| 30 | Quality dashboard para preguntas AI flaggeadas | **PENDIENTE** | adaptive-ia-study |
| 31 | chat.ts comentarios stale en header | **DONE** | auditoria v2 → `routes/ai/chat.ts` (INC-1) |

**Resumen: 18/31 completados, 11 pendientes, 2 parciales.**

> **Parciales:**
> - #11 Chunking inteligente: Recursive Character implementado como default (Fase 5). Semantic Chunking (embedding-based boundaries, #23) pendiente para fases futuras.
> - #24 Decision framework: Recursive = default implementado. Upgrade automático a Semantic para docs largos pendiente.

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

## Fase 3 — Embeddings en summaries (coarse-to-fine)

**Prioridad:** MEDIA — busqueda en 2 niveles.
**Riesgo:** MEDIO — requiere cambio en ingest + nuevo RPC.
**Impacto:** Queries amplias encuentran mejor match a nivel summary.

> **Relacion con investigacion:** Esto es la version "macro" del **Parent-Child Chunking**
> descrito en `chunking-strategies.md`. Summary=parent, Chunks=children.
> La busqueda encuentra el child (chunk) pero usa el parent (summary) para contexto amplio.

### Migration SQL

```sql
ALTER TABLE summaries ADD COLUMN IF NOT EXISTS embedding vector(768);

CREATE INDEX IF NOT EXISTS idx_summaries_embedding_hnsw
  ON summaries USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64) WHERE embedding IS NOT NULL;
```

### Cambio en `routes/ai/ingest.ts`

```typescript
// Despues de procesar chunks, generar embedding del summary completo
const summaryText = truncateAtWord(
  `${summary.title}. ${summary.content_markdown}`,
  8000 // Gemini embedding soporta hasta ~10k tokens
);
const summaryEmbedding = await generateEmbedding(summaryText, "RETRIEVAL_DOCUMENT");

await adminClient
  .from("summaries")
  .update({ embedding: JSON.stringify(summaryEmbedding) })
  .eq("id", summaryId);
```

### Nuevo RPC: `rag_coarse_to_fine_search()`

```sql
CREATE OR REPLACE FUNCTION rag_coarse_to_fine_search(
  p_query_embedding vector(768),
  p_query_text TEXT,
  p_institution_id UUID,
  p_top_summaries INT DEFAULT 3,
  p_top_chunks INT DEFAULT 5,
  p_similarity_threshold FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  chunk_id UUID, summary_id UUID, summary_title TEXT, content TEXT,
  summary_similarity FLOAT, chunk_similarity FLOAT, combined_score FLOAT
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH top_summaries AS (
    SELECT s.id, s.title,
      (1 - (s.embedding <=> p_query_embedding))::FLOAT AS sim
    FROM summaries s
    WHERE s.embedding IS NOT NULL
      AND s.institution_id = p_institution_id
      AND s.deleted_at IS NULL AND s.is_active = TRUE
      AND (1 - (s.embedding <=> p_query_embedding)) > p_similarity_threshold
    ORDER BY s.embedding <=> p_query_embedding
    LIMIT p_top_summaries
  ),
  ranked_chunks AS (
    SELECT ch.id AS c_id, ts.id AS s_id, ts.title AS s_title,
      ch.content AS c_content, ts.sim AS s_sim,
      (1 - (ch.embedding <=> p_query_embedding))::FLOAT AS c_sim,
      ROW_NUMBER() OVER (ORDER BY ch.embedding <=> p_query_embedding) AS rn
    FROM chunks ch JOIN top_summaries ts ON ts.id = ch.summary_id
    WHERE ch.embedding IS NOT NULL
  )
  SELECT rc.c_id, rc.s_id, rc.s_title, rc.c_content,
    rc.s_sim, rc.c_sim,
    (0.3 * rc.s_sim + 0.7 * rc.c_sim)::FLOAT AS combined
  FROM ranked_chunks rc WHERE rc.rn <= p_top_chunks
  ORDER BY (0.3 * rc.s_sim + 0.7 * rc.c_sim) DESC;
END;
$$;
```

### Integracion en `chat.ts`

```typescript
// Decidir que RPC usar:
if (summaryId) {
  // Con summary_id especifico -> hybrid search (ya scoped)
  results = await db.rpc("rag_hybrid_search", { ... });
} else {
  // Sin summary_id -> coarse-to-fine (busca el mejor summary primero)
  results = await db.rpc("rag_coarse_to_fine_search", { ... });
}
```

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
**Estado:** **DONE** — Issue #30 (branch `feat/fase5-chunking`). Sub-tasks 5.1–5.10 completados.

### Archivos creados/modificados (Fase 5)

| Archivo | Tipo | Descripción |
|---|---|---|
| `chunker.ts` | Nuevo | Motor de chunking: Recursive Character Splitting con respeto a límites markdown |
| `auto-ingest.ts` | Nuevo | Pipeline puro: fetch summary → chunk → delete old → insert new → embed → update timestamp |
| `summary-hook.ts` | Nuevo | afterWrite hook con 3 gates: update field check, ID extraction, content check |
| `routes/ai/re-chunk.ts` | Nuevo | POST /ai/re-chunk — endpoint síncrono para re-chunking manual (profesor) |
| `routes/ai/index.ts` | Modificado | Mount de `aiReChunkRoutes` |
| `crud-factory.ts` | Modificado | `AfterWriteParams` type + `afterWrite?` callback en CrudConfig + fire-and-forget en POST/PUT |
| `routes/content/crud.ts` | Modificado | `afterWrite: onSummaryWrite` en config de summaries |
| `tests/summary_hook_test.ts` | Nuevo | 9 tests: gate logic (8 skip paths + 1 fire path) |
| Migration `20260306_04` | Nuevo | Columnas `chunk_strategy TEXT DEFAULT 'recursive'` + `last_chunked_at TIMESTAMPTZ` en summaries |

### Sub-tasks completados

| # | Sub-task | Commits |
|---|---|---|
| 5.1 | `chunker.ts` — Recursive Character Splitting | Branch inicial |
| 5.2 | 10 unit tests para chunker + 3 fixes auditoría R2 | Branch inicial |
| 5.3 | Fixtures de test (markdown samples) | Branch inicial |
| 5.4 | Migration: `chunk_strategy` + `last_chunked_at` | Branch inicial |
| 5.5 | `auto-ingest.ts` — función pura `autoChunkAndEmbed` + 1 fix R1 | `3026a31` |
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

## Fase 6 — Retrieval avanzado (Multi-Query + HyDE + Re-ranking)

**Prioridad:** MEDIA — mejora significativa de recall y precision.
**Riesgo:** MEDIO — agrega llamadas Gemini extra.
**Impacto:** +25-40% recall/precision segun la estrategia.

> **Fuente:** `hybrid-retrieval.ts` de la investigacion describe 4 estrategias.
> La #1 (Hybrid RRF) ya esta implementada. Faltan #2, #3, y #4.

Ver secciones 6A–6D en versiones anteriores de este documento para detalle de implementacion.

---

## Fase 7 — Ingestion multi-fuente (PDF, API)

**Prioridad:** BAJA — actualmente los profesores escriben en `content_markdown`.
**Riesgo:** ALTO — parsing de PDF es complejo.
**Impacto:** Desbloquea upload de materiales existentes.

---

## Fase 8 — IA Adaptativa: NeedScore + Pre-generacion + Calidad

**Prioridad:** MEDIA — mejora la experiencia del alumno significativamente.
**Riesgo:** MEDIO — varios cambios en generate.ts + nuevos endpoints.
**Impacto:** Generacion mas inteligente + mecanismos de calidad.

### 8A. NeedScore integration con `/ai/generate` — PENDIENTE

El `NeedScore` ya existe en `routes-study-queue.tsx`:
```
NeedScore = 0.40*overdue + 0.30*(1-p_know) + 0.20*fragility + 0.10*novelty
```

Nuevo endpoint propuesto: POST `/ai/generate-smart` que elige subtopic automaticamente.

### 8B. Pre-generacion en background — PENDIENTE

POST `/ai/pre-generate` para generar contenido en background.

### 8C. Professor notes en prompt de generate.ts — **DONE** (INC-6)

Aplicado en `routes/ai/generate.ts`:
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

### 8D. Rate limit especifico para AI — **DONE** (INC-3)

Aplicado en `routes/ai/index.ts`:
- Middleware `aiRateLimitMiddleware` con `check_rate_limit()` RPC
- 20 req/hr por usuario, solo POST, degradacion graceful
- Usa la tabla `rate_limit_entries` de migration `20260303_02`

### 8E. Report question / Flag AI content — PENDIENTE

### 8F. Quality dashboard — PENDIENTE

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
Fase 3: Embeddings en summaries       [1 dia]  [SQL + ingest]   [coarse-to-fine]
  |
Fase 8: IA adaptativa (restante)      [2 dias] [generate.ts +]  [NeedScore + pre-gen + calidad]
  |                                            [nuevos endpoints]
  |
Fase 6: Retrieval avanzado            [2 dias] [chat.ts]        [Multi-Query + HyDE + re-rank]
  |
Fase 7: Ingestion PDF                 [3 dias] [nuevo modulo]   [feature nueva]
```

**Total estimado: ~8 dias restantes**

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
3. `ALTER TABLE summaries ALTER COLUMN embedding TYPE vector(NEW_DIM)` (si Fase 3)
4. Function signature: `p_query_embedding vector(768)` en `rag_hybrid_search()`
5. Function signature: `p_query_embedding vector(768)` en `rag_coarse_to_fine_search()`
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
