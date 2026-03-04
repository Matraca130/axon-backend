# RAG Roadmap — Blueprint completo con Gemini

> Plan de implementacion para completar todo lo propuesto en los documentos
> `pgvector-axon-integration.md` y `axon-rag-architecture.md`, adaptado a
> Gemini como provider inicial.
>
> **Auditado:** 2026-03-04 — 3 errores corregidos, 7 mejoras agregadas.

---

## Estado actual vs Blueprint

| # | Feature del Blueprint | Estado | Notas |
|---|---|---|---|
| 1 | pgvector extension habilitada | **DONE** | `CREATE EXTENSION vector` en migration `20260305_03` |
| 2 | Columna `embedding` en `chunks` | **DONE** | `vector(768)` — Gemini en vez de OpenAI 1536 |
| 3 | Columna `embedding` en `summaries` | **PENDIENTE** | Blueprint la propone para busqueda coarse-to-fine |
| 4 | Columnas `fts TSVECTOR` generadas | **PARCIAL** | RPC usa `to_tsvector('spanish')` inline (no stored column, no GIN index) |
| 5 | Indices HNSW para vectores en chunks | **DONE** | Migration `20260305_03`, LA-04 fix (m=16, ef=64) |
| 6 | `rag_hybrid_search()` RPC | **DONE** | Cosine 70% + ts_rank 30%, threshold 0.3, top 5, CTE (LA-05) |
| 7 | `rag_query_log` tabla | **PENDIENTE** | Para analytics de queries, latencia, scores |
| 8 | Ruta de ingesta de embeddings | **DONE** | POST `/ai/ingest-embeddings` en `routes/ai/ingest.ts` |
| 9 | Ruta de busqueda semantica + respuesta | **DONE** | POST `/ai/rag-chat` en `routes/ai/chat.ts` |
| 10 | Generacion adaptativa (flashcards/quiz) | **DONE** | POST `/ai/generate` con BKT + perfil alumno |
| 11 | Chunking inteligente (semantico) | **PENDIENTE** | Chunks actuales se crean manual o split basico |
| 12 | Re-ranking con cross-encoders | **PENDIENTE** | Gemini no tiene cross-encoder API dedicada |
| 13 | Ingestion multi-fuente (PDF, API) | **PENDIENTE** | Solo `content_markdown` actualmente |
| 14 | Auth + institution scoping | **DONE** | `resolve_parent_institution()` + CONTENT_WRITE_ROLES |
| 15 | Retry con backoff exponencial | **DONE** | `fetchWithRetry()` en gemini.ts (429/503) |
| 16 | Denormalizacion institution_id | **PENDIENTE** | RPC hace 6-table JOIN por query (nuevo hallazgo) |
| 17 | Feedback loop (thumbs up/down) | **PENDIENTE** | Sin mecanismo para mejorar RAG iterativamente (nuevo hallazgo) |
| 18 | Monitoring de cobertura de embeddings | **PENDIENTE** | No hay forma de ver % chunks con embedding (nuevo hallazgo) |
| 19 | Auto-ingest trigger | **PENDIENTE** | Ingest requiere POST manual (nuevo hallazgo) |

**Resumen: 9/19 completados, 10 pendientes.**

---

## Errores corregidos en esta auditoria

| Error | Que decia | Realidad |
|---|---|---|
| **ERR-1** | Item #5: "Indices HNSW: PENDIENTE — sequential scan" | Ya existe `idx_chunks_embedding` HNSW en migration `20260305_03` (fix LA-04) |
| **ERR-2** | Item #4: "Full-text via `pg_trgm` en el RPC" | El RPC usa `to_tsvector('spanish') + ts_rank()` (PostgreSQL FTS estandar). `pg_trgm` se usa en `search_scoped()` (busqueda global), NO en RAG |
| **ERR-3** | Fase 1 proponia crear indices HNSW como trabajo pendiente | Redundante — el indice ya existe. Se elimina como fase y se reemplaza por denormalizacion |

---

## Fase 1 — Performance: Denormalizar `institution_id` en summaries

**Prioridad:** ALTA — el RPC `rag_hybrid_search()` hace un JOIN de 6 tablas en cada query.
**Riesgo:** MEDIO — requiere migration + trigger + actualizar el RPC.
**Impacto:** Elimina 4 JOINs por query (chunks→summaries→topics→sections→semesters→courses).

### Problema actual

```sql
-- Cada query RAG ejecuta este JOIN chain:
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
-- Archivo: supabase/migrations/YYYYMMDD_01_denorm_institution_id.sql

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
-- (Se dispara cuando se crea un summary o se mueve a otro topic)
CREATE OR REPLACE FUNCTION sync_summary_institution_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
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

### Actualizar `rag_hybrid_search()` RPC

```sql
-- ANTES: 6-table JOIN chain
-- DESPUES: 2-table JOIN (chunks + summaries)
CREATE OR REPLACE FUNCTION rag_hybrid_search(...)
...
AS $$
BEGIN
  RETURN QUERY
  WITH scored AS (
    SELECT
      ch.id, s.id AS s_id, s.title AS s_title, ch.content AS c_content,
      (1 - (ch.embedding <=> p_query_embedding))::FLOAT AS sim,
      ts_rank(to_tsvector('spanish', ch.content),
              plainto_tsquery('spanish', p_query_text))::FLOAT AS trank
    FROM chunks ch
    JOIN summaries s ON s.id = ch.summary_id
    WHERE ch.embedding IS NOT NULL
      AND s.institution_id = p_institution_id          -- <-- directo, sin 4 JOINs
      AND s.deleted_at IS NULL AND s.is_active = TRUE
      AND (p_summary_id IS NULL OR s.id = p_summary_id)
  )
  SELECT ... FROM scored WHERE scored.sim > p_similarity_threshold
  ORDER BY (0.7 * scored.sim + 0.3 * scored.trank) DESC
  LIMIT p_match_count;
END;
$$;
```

### Notas
- Los filtros `deleted_at IS NULL AND is_active = TRUE` para topics/sections/semesters/courses se pierden. Evaluar si son necesarios (¿puede un curso estar inactivo con summaries activos?).
- Alternativa conservadora: solo eliminar courses y semesters del JOIN (mantener topics para el filtro `is_active`).
- La columna se mantiene sincronizada via trigger — zero mantenimiento manual.

---

## Fase 2 — Columnas tsvector generadas + GIN index

**Prioridad:** MEDIA — mejora performance de FTS sin cambiar logica.
**Riesgo:** BAJO — columnas generated son transparentes.
**Impacto:** Ahorra CPU del `to_tsvector()` inline por cada fila evaluada.

### Migration SQL

```sql
-- Archivo: supabase/migrations/YYYYMMDD_02_fts_columns.sql

-- Columna FTS generada para chunks
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('spanish', coalesce(content, ''))
  ) STORED;

-- Indice GIN para busqueda full-text en chunks
CREATE INDEX IF NOT EXISTS idx_chunks_fts
  ON chunks USING gin (fts);

-- Columna FTS generada para summaries
ALTER TABLE summaries
  ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('spanish',
      coalesce(title, '') || ' ' || coalesce(content_markdown, '')
    )
  ) STORED;

-- Indice GIN para busqueda full-text en summaries
CREATE INDEX IF NOT EXISTS idx_summaries_fts
  ON summaries USING gin (fts);
```

### Cambio en `rag_hybrid_search()` RPC

```sql
-- ANTES (inline, computado por cada fila):
ts_rank(to_tsvector('spanish', ch.content), plainto_tsquery('spanish', p_query_text))

-- DESPUES (stored column, pre-computado):
ts_rank(ch.fts, plainto_tsquery('spanish', p_query_text))
```

### Optimizacion avanzada: Pre-filtro FTS

El GIN index abre una optimizacion que hoy no es posible:

```sql
-- Agregar pre-filtro: solo evaluar vector similarity en chunks que
-- tengan algun match de texto. Reduce drasticamente las filas a comparar.
WHERE ch.embedding IS NOT NULL
  AND s.institution_id = p_institution_id
  AND (
    ch.fts @@ plainto_tsquery('spanish', p_query_text)  -- pre-filtro FTS
    OR true  -- fallback: si no hay match FTS, incluir todas (solo vector sim)
  )
```

> **Nota:** El `OR true` anula el pre-filtro. Para activarlo realmente,
> necesitas una estrategia de 2 pasadas: primero FTS-filtered, si hay pocos
> resultados, luego vector-only. Esto es Fase 6 (re-ranking).

### Consideraciones de idioma
- `'spanish'` es el config — funciona para contenido en español.
- Si hay contenido en ingles, considerar `'simple'` como fallback.
- Para multi-idioma real, agregar columna `language` a summaries y usar un config dinamico.

---

## Fase 3 — Embeddings en summaries (coarse-to-fine)

**Prioridad:** MEDIA — permite busqueda en 2 niveles.
**Riesgo:** MEDIO — requiere cambio en ingest + nuevo RPC.
**Impacto:** Queries amplias encuentran mejor match a nivel summary.

### Migration SQL

```sql
-- Archivo: supabase/migrations/YYYYMMDD_03_summary_embeddings.sql

ALTER TABLE summaries
  ADD COLUMN IF NOT EXISTS embedding vector(768);

CREATE INDEX IF NOT EXISTS idx_summaries_embedding_hnsw
  ON summaries
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL;
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
  chunk_id UUID,
  summary_id UUID,
  summary_title TEXT,
  content TEXT,
  summary_similarity FLOAT,
  chunk_similarity FLOAT,
  combined_score FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  -- Paso 1: Top N summaries mas relevantes
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
  -- Paso 2: Top M chunks dentro de esos summaries
  ranked_chunks AS (
    SELECT
      ch.id AS c_id,
      ts.id AS s_id,
      ts.title AS s_title,
      ch.content AS c_content,
      ts.sim AS s_sim,
      (1 - (ch.embedding <=> p_query_embedding))::FLOAT AS c_sim,
      ROW_NUMBER() OVER (ORDER BY ch.embedding <=> p_query_embedding) AS rn
    FROM chunks ch
    JOIN top_summaries ts ON ts.id = ch.summary_id
    WHERE ch.embedding IS NOT NULL
  )
  SELECT
    rc.c_id, rc.s_id, rc.s_title, rc.c_content,
    rc.s_sim, rc.c_sim,
    (0.3 * rc.s_sim + 0.7 * rc.c_sim)::FLOAT AS combined
  FROM ranked_chunks rc
  WHERE rc.rn <= p_top_chunks
  ORDER BY (0.3 * rc.s_sim + 0.7 * rc.c_sim) DESC;
END;
$$;
```

### Uso en `chat.ts`

Para queries amplias (sin `summary_id`), usar `rag_coarse_to_fine_search()`.
Para queries con `summary_id`, seguir usando `rag_hybrid_search()` (ya scoped).

### Notas Gemini
- `gemini-embedding-001` soporta textos largos (hasta ~10k tokens)
- taskType para summaries: `"RETRIEVAL_DOCUMENT"` (no `"RETRIEVAL_QUERY"`)
- Costo: 1 embedding adicional por summary — negligible

---

## Fase 4 — Query logging (`rag_query_log`) + Feedback loop

**Prioridad:** MEDIA — analytics + mejora iterativa.
**Riesgo:** BAJO — tabla nueva, inserts async.
**Impacto:** Permite medir calidad y mejorar el sistema con datos reales.

### Migration SQL

```sql
-- Archivo: supabase/migrations/YYYYMMDD_04_rag_query_log.sql

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
  search_type TEXT DEFAULT 'hybrid',         -- 'hybrid', 'coarse_to_fine'
  model_used TEXT,                           -- 'gemini-embedding-001'
  feedback SMALLINT,                         -- NULL=sin feedback, 1=thumbs up, -1=thumbs down
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indices para analytics
CREATE INDEX IF NOT EXISTS idx_rag_query_log_inst_date
  ON rag_query_log (institution_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rag_query_log_user
  ON rag_query_log (user_id, created_at DESC);
-- Indice para encontrar queries con feedback negativo (para mejorar el sistema)
CREATE INDEX IF NOT EXISTS idx_rag_query_log_negative_feedback
  ON rag_query_log (institution_id, feedback)
  WHERE feedback = -1;

-- RLS
ALTER TABLE rag_query_log ENABLE ROW LEVEL SECURITY;

-- Alumnos ven solo sus propios logs
CREATE POLICY rag_query_log_own_select ON rag_query_log
  FOR SELECT USING (user_id = auth.uid());

-- Owner/Admin ven todos los logs de su institucion
CREATE POLICY rag_query_log_institution_select ON rag_query_log
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = auth.uid()
        AND m.institution_id = rag_query_log.institution_id
        AND m.role IN ('owner', 'admin')
        AND m.is_active = TRUE
    )
  );

-- INSERT: no se necesita policy porque se usa adminClient (bypass RLS)
-- Documentado aqui para que futuros agentes no agreguen una policy innecesaria
```

### Cambio en `routes/ai/chat.ts` — Insert async

```typescript
// Despues de enviar la respuesta al usuario:
const startTime = Date.now(); // agregar al inicio del handler

const logEntry = {
  user_id: user.id,
  institution_id: institutionId,
  query_text: message.substring(0, 500),
  summary_id: summaryId || null,
  results_count: sourcesUsed.length,
  top_similarity: sourcesUsed[0]?.similarity || null,
  avg_similarity: sourcesUsed.length > 0
    ? sourcesUsed.reduce((a, s) => a + s.similarity, 0) / sourcesUsed.length
    : null,
  latency_ms: Date.now() - startTime,
  search_type: 'hybrid',
  model_used: 'gemini-embedding-001',
  feedback: null, // se actualiza despues via PATCH
};

// Fire-and-forget — no bloquear la respuesta
getAdminClient().from('rag_query_log').insert(logEntry).then();
```

### Nuevo endpoint: Feedback

```typescript
// PATCH /ai/rag-feedback
// Body: { log_id: UUID, feedback: 1 | -1 }
// Actualiza el campo feedback del log entry
// Solo el usuario que hizo la query puede dar feedback (RLS)
```

### Endpoint de analytics

```typescript
// GET /ai/rag-analytics?institution_id=xxx&from=2026-03-01&to=2026-03-31
// Retorna:
// {
//   total_queries: 150,
//   avg_similarity: 0.52,
//   avg_latency_ms: 320,
//   feedback_positive: 45,
//   feedback_negative: 8,
//   feedback_rate: 0.35,
//   top_queries: [...],
//   low_similarity_queries: [...]  // para identificar gaps en el contenido
// }
```

### Embedding coverage monitoring

```typescript
// GET /ai/embedding-coverage?institution_id=xxx
// Retorna:
// {
//   total_chunks: 500,
//   chunks_with_embedding: 480,
//   coverage_pct: 96.0,
//   summaries_without_chunks: ["UUID1", "UUID2"],  // summaries sin chunks
//   stale_embeddings: 5  // chunks cuyo content cambio despues del ultimo embedding
// }
```

> **Nota:** `stale_embeddings` requiere agregar un campo `embedded_at TIMESTAMPTZ`
> a la tabla chunks para comparar con `updated_at`.

---

## Fase 5 — Chunking inteligente + Auto-ingest

**Prioridad:** MEDIA-ALTA — chunking actual es basico, afecta calidad de retrieval.
**Riesgo:** MEDIO — requiere re-ingest de todos los chunks.
**Impacto:** Mejor coherencia semantica = mejor retrieval = mejores respuestas.

### Estrategia de chunking para contenido educativo

```
Reglas de chunking para Axon:
1. Respetar headers markdown (## y ###) como limites naturales
2. Target: 300-500 tokens por chunk (sweet spot para embeddings)
3. Overlap: 50 tokens entre chunks consecutivos (preservar contexto)
4. Metadata: guardar header_path (ej: "Capitulo 2 > Seccion 2.1") en metadata JSONB
5. No cortar mid-paragraph — buscar \n\n como punto de corte
6. Listas y tablas: mantener completas (no cortar una lista a la mitad)
```

### Implementacion

Nuevo archivo: `supabase/functions/server/chunker.ts`

```typescript
export interface ChunkResult {
  content: string;
  order_index: number;
  metadata: {
    header_path: string;      // "Cap 2 > Sec 2.1 > Tema X"
    char_start: number;
    char_end: number;
    token_estimate: number;
    has_overlap: boolean;
  };
}

export function chunkMarkdown(markdown: string, opts?: {
  targetTokens?: number;    // default 400
  overlapTokens?: number;   // default 50
  maxTokens?: number;       // default 600
}): ChunkResult[] {
  // 1. Split by headers (## y ###)
  // 2. Dentro de cada seccion, split por paragraphs (\n\n)
  // 3. Merge paragraphs hasta llegar a targetTokens
  // 4. Agregar overlap del chunk anterior
  // 5. Calcular metadata (header_path, char positions, token estimate)
}
```

### Auto-ingest: Endpoint POST `/ai/rechunk-summary`

```typescript
// POST /ai/rechunk-summary
// Body: { summary_id: UUID }
// Pipeline:
//   1. Fetch summary.content_markdown
//   2. chunkMarkdown() → array de chunks
//   3. DELETE chunks viejos de ese summary
//   4. INSERT chunks nuevos
//   5. generateEmbedding() para cada chunk nuevo
//   6. Return { chunks_created, embeddings_generated }
```

### Auto-ingest: DB Trigger (opcional, Fase futura)

```sql
-- Trigger que marca chunks como stale cuando content_markdown cambia
-- NO auto-rechunka (costoso + requiere API call), solo marca
CREATE OR REPLACE FUNCTION mark_chunks_stale()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.content_markdown IS DISTINCT FROM NEW.content_markdown THEN
    UPDATE chunks
    SET embedding = NULL  -- marca como "necesita re-embed"
    WHERE summary_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_summary_content_changed
  AFTER UPDATE OF content_markdown ON summaries
  FOR EACH ROW
  EXECUTE FUNCTION mark_chunks_stale();
```

> **Decision:** El trigger solo invalida embeddings (pone NULL), no rechunka.
> El rechunking se hace via POST `/ai/rechunk-summary` o un batch job.
> Esto evita llamadas Gemini desde un trigger SQL.

### Re-ingesta masiva

```sql
-- Despues de implementar el nuevo chunker:
-- 1. Backup: exportar chunks actuales
-- 2. Re-chunkar via POST /ai/rechunk-summary para cada summary
-- 3. Verificar cobertura via GET /ai/embedding-coverage
```

---

## Fase 6 — Re-ranking con Gemini (JSON scores)

**Prioridad:** BAJA — mejora marginal sobre los resultados actuales.
**Riesgo:** MEDIO — agrega una llamada Gemini extra por query.
**Impacto:** Mejor precision en top-3 resultados.

### Por que no cross-encoders

Gemini no tiene API de cross-encoder (como Cohere Rerank o Jina Reranker).
Pero puede actuar como re-ranker via generacion estructurada.

### Estrategia: Gemini-as-Reranker con JSON scores

La version anterior proponia pedir indices ordenados — esto es fragil
(Gemini puede retornar indices invalidos). Mejor: pedir scores de relevancia.

```typescript
// En routes/ai/chat.ts, despues de rag_hybrid_search():

// 1. Obtener top 10 chunks del hybrid search (en vez de top 5)
// 2. Pedir a Gemini que score cada uno:
const rerankPrompt = `
Dada esta pregunta del alumno: "${message}"

Puntua la relevancia de cada fragmento del 0.0 al 1.0.
Responde SOLO con JSON: [{"index": 0, "score": 0.95}, ...]

${chunks.map((c, i) => `[${i}] ${c.content.substring(0, 300)}`).join('\n\n')}
`;

const result = await generateText({
  prompt: rerankPrompt,
  systemPrompt: "Eres un evaluador de relevancia. Responde solo con JSON.",
  jsonMode: true,
  temperature: 0,
  maxTokens: 200,
});

const scores = parseGeminiJson<Array<{index: number; score: number}>>(result.text);

// 3. Re-ordenar por score y tomar top 5
const reranked = scores
  .sort((a, b) => b.score - a.score)
  .slice(0, 5)
  .map(s => chunks[s.index])
  .filter(Boolean);  // safety: skip invalid indices
```

### Trade-offs

| Ventaja | Desventaja |
|---|---|
| JSON scores es mas robusto que indices | +1 Gemini call por query (~200ms extra) |
| `jsonMode: true` fuerza output JSON valido | Consume tokens del free tier |
| Scores permiten threshold adicional | No tan preciso como cross-encoder dedicado |
| Gemini entiende contexto educativo | Latencia total aumenta ~30% |

### Alternativa futura

- Cohere Rerank API ($1/1000 queries)
- Vertex AI re-ranking nativo
- Jina Reranker (open source, self-hosted)

---

## Fase 7 — Ingestion multi-fuente (PDF, API)

**Prioridad:** BAJA — actualmente los profesores escriben en `content_markdown`.
**Riesgo:** ALTO — parsing de PDF es complejo.
**Impacto:** Desbloquea upload de materiales existentes.

### Arquitectura

```
POST /ai/ingest-document
  -> Detectar tipo (PDF, DOCX, TXT, URL)
  -> Extraer texto via Gemini multimodal (PDF como base64)
  -> Limpiar y normalizar markdown
  -> Guardar en summaries.content_markdown
  -> Chunkar con chunker.ts
  -> Generar embeddings con ingest-embeddings
```

### Limitaciones en Deno/Edge Functions

- `pdf-parse` no funciona en Deno — wasm o servicio externo necesario
- Opcion pragmatica: Gemini 2.5 Flash soporta input multimodal (PDF)
  ```typescript
  // Enviar PDF como base64, pedir markdown limpio
  const pdfBase64 = await readFileAsBase64(file);
  const result = await generateText({
    prompt: "Convierte este PDF a markdown limpio. Preserva headers, listas y tablas.",
    // ... incluir PDF como inline_data
  });
  ```

---

## Orden de implementacion recomendado

```
Fase 1: Denormalizar institution_id  [1 dia]  [SQL + RPC]     [elimina 4 JOINs por query]
  |
Fase 2: Columnas tsvector + GIN     [1 dia]  [SQL + RPC]     [mejora FTS performance]
  |
Fase 4: Query log + feedback         [1 dia]  [SQL + chat.ts] [analytics para iterar]
  |
Fase 5: Chunking + auto-ingest       [2 dias] [nuevo archivo] [mejora calidad RAG]
  |
Fase 3: Embeddings en summaries      [1 dia]  [SQL + ingest]  [coarse-to-fine]
  |
Fase 6: Re-ranking con Gemini        [1 dia]  [chat.ts]       [precision marginal]
  |
Fase 7: Ingestion PDF                [3 dias] [nuevo modulo]  [feature nueva]
```

**Total estimado: ~10 dias de trabajo**

> **Nota:** Fase 4 antes de Fase 5 porque los logs permiten medir
> el impacto del nuevo chunking (comparar metricas antes/despues).

---

## Housekeeping: Bugs menores a corregir

### chat.ts — Comentarios stale en header

El header del archivo dice:
```
// gemini-embedding-004   ← deberia ser gemini-embedding-001 (fix D-16)
// Gemini 2.0 Flash       ← deberia ser gemini-2.5-flash (fix D-17)
```

El codigo es correcto (usa imports de `gemini.ts`), solo los comentarios estan desactualizados.

### Migracion de dimensiones: function signature

Si en el futuro se cambian las dimensiones de embedding, ademas de:
1. `ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(NEW_DIM)`
2. Re-ingest ALL chunks
3. Recrear indices HNSW

Tambien hay que cambiar:
4. **Function signature:** `p_query_embedding vector(768)` en `rag_hybrid_search()`
5. **Function signature:** `p_query_embedding vector(768)` en `rag_coarse_to_fine_search()` (si existe)

Estos puntos no estaban documentados en el roadmap original.

---

## Adaptaciones especificas para Gemini

| Aspecto | Blueprint original (OpenAI) | Adaptacion Gemini |
|---|---|---|
| Modelo embeddings | `text-embedding-3-large` (1536/3072 dims) | `gemini-embedding-001` (768 dims via `outputDimensionality`) |
| Modelo generacion | GPT-4 / GPT-3.5 | `gemini-2.5-flash` (via `GENERATE_MODEL` en gemini.ts) |
| Cross-encoder | Cohere Rerank | Gemini-as-Reranker con JSON scores (Fase 6) |
| API Key | `OPENAI_API_KEY` | `GEMINI_API_KEY` (ya configurada) |
| Costo embeddings | ~$0.13/1M tokens | Gratis (free tier, con rate limit 429) |
| Rate limiting | Token-based | RPM-based (1500 RPM embed, 15 RPM generate free tier) |
| PDF extraction | pdf-parse library | Gemini multimodal (PDF como input) |
| Max input embeddings | 8191 tokens | ~10k tokens (Gemini mas generoso) |

### Migracion futura a OpenAI (si necesario)

1. Editar `generateEmbedding()` en `gemini.ts` para llamar a OpenAI
2. Cambiar `EMBEDDING_DIMENSIONS` de 768 a 1536
3. Migration: `ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(1536)`
4. Migration: `ALTER TABLE summaries ALTER COLUMN embedding TYPE vector(1536)` (si Fase 3 implementada)
5. Actualizar function signatures de `rag_hybrid_search()` y `rag_coarse_to_fine_search()`
6. Re-ingest ALL chunks y summaries (embeddings incompatibles entre modelos)
7. Recrear indices HNSW

> **Recomendacion:** No migrar a menos que la calidad de retrieval con Gemini
> sea insuficiente. El free tier es una ventaja significativa durante desarrollo.