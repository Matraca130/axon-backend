# RAG Roadmap — Blueprint completo con Gemini

> Plan de implementacion para completar todo lo propuesto en los documentos
> `pgvector-axon-integration.md` y `axon-rag-architecture.md`, adaptado a
> Gemini como provider inicial.

---

## Estado actual vs Blueprint

| # | Feature del Blueprint | Estado | Notas |
|---|---|---|---|
| 1 | pgvector extension habilitada | **DONE** | `CREATE EXTENSION vector` ya ejecutado |
| 2 | Columna `embedding` en `chunks` | **DONE** | `vector(768)` — Gemini en vez de OpenAI 1536 |
| 3 | Columna `embedding` en `summaries` | **PENDIENTE** | Blueprint la propone para busqueda coarse-to-fine |
| 4 | Columnas `fts TSVECTOR` generadas | **PARCIAL** | Full-text se hace via `pg_trgm` en el RPC, no con tsvector dedicado |
| 5 | Indices HNSW para vectores | **PENDIENTE** | Sin indice = sequential scan en cada query |
| 6 | `rag_hybrid_search()` RPC | **DONE** | Cosine similarity + full-text, threshold 0.3, top 5 |
| 7 | `rag_query_log` tabla | **PENDIENTE** | Para analytics de queries, latencia, scores |
| 8 | Ruta de ingesta de embeddings | **DONE** | POST `/ai/ingest-embeddings` en `routes/ai/ingest.ts` |
| 9 | Ruta de busqueda semantica + respuesta | **DONE** | POST `/ai/rag-chat` en `routes/ai/chat.ts` |
| 10 | Generacion adaptativa (flashcards/quiz) | **DONE** | POST `/ai/generate` con BKT + perfil alumno |
| 11 | Chunking inteligente (semantico) | **PENDIENTE** | Chunks actuales se crean manual o split basico |
| 12 | Re-ranking con cross-encoders | **PENDIENTE** | Gemini no tiene cross-encoder API dedicada |
| 13 | Ingestion multi-fuente (PDF, API) | **PENDIENTE** | Solo `content_markdown` actualmente |
| 14 | Auth + institution scoping | **DONE** | `resolve_parent_institution()` + CONTENT_WRITE_ROLES |
| 15 | Retry con backoff exponencial | **DONE** | `fetchWithRetry()` en gemini.ts (429/503) |

**Resumen: 8/15 completados, 7 pendientes.**

---

## Fase 1 — Performance: Indices HNSW

**Prioridad:** ALTA — sin indice, cada query hace sequential scan en todos los vectores.
**Riesgo:** BAJO — solo DDL, no toca codigo.
**Impacto:** Busqueda pasa de O(n) a O(log n).

### Migration SQL

```sql
-- Archivo: supabase/migrations/YYYYMMDD_01_hnsw_indexes.sql

-- Indice HNSW para cosine similarity en chunks
-- m=16, ef_construction=64 son buenos defaults para <100k vectores
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw
  ON chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Indice para el filtro mas comun: chunks por summary_id
-- (ya deberia existir, verificar)
CREATE INDEX IF NOT EXISTS idx_chunks_summary_id
  ON chunks (summary_id);

-- Opcional: indice parcial que excluye chunks sin embedding
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw_partial
  ON chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL;
```

### Verificacion

```sql
-- Confirmar que el indice se usa:
EXPLAIN ANALYZE
SELECT id, 1 - (embedding <=> '[0.1,0.2,...]'::vector) AS similarity
FROM chunks
WHERE embedding IS NOT NULL
ORDER BY embedding <=> '[0.1,0.2,...]'::vector
LIMIT 5;
-- Debe mostrar "Index Scan using idx_chunks_embedding_hnsw"
```

### Notas Gemini
- El indice es sobre `vector(768)` — si cambias dimensiones (ej: a 1024 con un modelo futuro), hay que recrear el indice
- HNSW es mejor que IVFFlat para datasets < 100k vectores (recall mas alto sin necesidad de re-entrenar)

---

## Fase 2 — Columnas tsvector generadas

**Prioridad:** MEDIA — mejora full-text search sin cambiar el RPC.
**Riesgo:** BAJO — columnas generated son transparentes.
**Impacto:** Full-text search usa indice GIN dedicado en vez de `pg_trgm` en runtime.

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

Actualizar el RPC para usar la columna `fts` en vez de `pg_trgm`:

```sql
-- Reemplazar la parte de full-text del RPC:
-- ANTES: similarity basada en pg_trgm
-- DESPUES: ts_rank basada en tsvector
ts_rank(c.fts, plainto_tsquery('spanish', p_query_text)) AS text_rank
```

### Consideraciones de idioma
- `'spanish'` es el config de tsvector — funciona para contenido en espanol
- Si hay contenido en portugues o ingles, considerar `'simple'` como fallback
- O crear una columna por idioma si el contenido es multi-idioma

---

## Fase 3 — Embeddings en summaries (coarse-to-fine)

**Prioridad:** MEDIA — permite busqueda en 2 niveles: primero summary, luego chunks.
**Riesgo:** MEDIO — requiere cambio en ingest + nuevo RPC.
**Impacto:** Queries amplias ("de que trata este curso?") encuentran mejor match a nivel summary.

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

Agregar logica para generar embedding del summary completo:

```typescript
// Despues de procesar chunks, generar embedding del summary
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
-- Estrategia:
-- 1. Buscar summaries similares (top 3)
-- 2. Dentro de esos summaries, buscar chunks similares (top 5)
-- Resultado: chunks mas relevantes dentro de los summaries mas relevantes
```

### Notas Gemini
- Gemini `gemini-embedding-001` soporta textos largos (hasta ~10k tokens)
- El taskType para summaries debe ser `"RETRIEVAL_DOCUMENT"` (no `"RETRIEVAL_QUERY"`)
- Costo: 1 embedding adicional por summary (vs N por chunks) — negligible

---

## Fase 4 — Query logging (`rag_query_log`)

**Prioridad:** MEDIA — analytics para mejorar el sistema iterativamente.
**Riesgo:** BAJO — tabla nueva, insert async.
**Impacto:** Permite analizar: que preguntan los alumnos, que similarity scores obtienen, latencia.

### Migration SQL

```sql
-- Archivo: supabase/migrations/YYYYMMDD_04_rag_query_log.sql

CREATE TABLE IF NOT EXISTS rag_query_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  institution_id UUID NOT NULL REFERENCES institutions(id),
  query_text TEXT NOT NULL,
  summary_id UUID REFERENCES summaries(id),  -- NULL si busqueda global
  results_count INT NOT NULL DEFAULT 0,
  top_similarity FLOAT,                       -- score del mejor resultado
  avg_similarity FLOAT,                       -- score promedio
  latency_ms INT,                             -- tiempo total de la query
  search_type TEXT DEFAULT 'hybrid',          -- 'hybrid', 'vector', 'fts'
  model_used TEXT,                            -- 'gemini-embedding-001'
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indice para analytics por institucion + rango de fechas
CREATE INDEX IF NOT EXISTS idx_rag_query_log_inst_date
  ON rag_query_log (institution_id, created_at DESC);

-- Indice para analytics por usuario
CREATE INDEX IF NOT EXISTS idx_rag_query_log_user
  ON rag_query_log (user_id, created_at DESC);

-- RLS: usuarios solo ven sus propios logs, owners ven todos de su institucion
ALTER TABLE rag_query_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY rag_query_log_own ON rag_query_log
  FOR SELECT USING (user_id = auth.uid());
```

### Cambio en `routes/ai/chat.ts`

Agregar insert async al final del handler (no bloquea la respuesta):

```typescript
// Despues de enviar la respuesta al usuario:
const logEntry = {
  user_id: user.id,
  institution_id: institutionId,
  query_text: message.substring(0, 500),
  summary_id: summaryId || null,
  results_count: sources.length,
  top_similarity: sources[0]?.similarity || null,
  avg_similarity: sources.length > 0
    ? sources.reduce((a, s) => a + s.similarity, 0) / sources.length
    : null,
  latency_ms: Date.now() - startTime,
  search_type: 'hybrid',
  model_used: 'gemini-embedding-001',
};

// Fire-and-forget (no await) — no bloquear la respuesta
adminClient.from('rag_query_log').insert(logEntry).then();
```

### Endpoints de analytics (en `routes/plans/`)

```typescript
// GET /rag-analytics?institution_id=xxx&from=2026-03-01&to=2026-03-31
// Retorna: total_queries, avg_similarity, avg_latency, top_queries, low_similarity_queries
```

---

## Fase 5 — Chunking inteligente

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
    char_start: number;       // posicion en el markdown original
    char_end: number;
    token_estimate: number;   // conteo aproximado de tokens
    has_overlap: boolean;     // true si tiene overlap con chunk anterior
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
  // 5. Calcular metadata
}
```

### Cambio en flujo de ingesta

Opcion A (recomendada): Trigger en DB cuando `summaries.content_markdown` cambia
Opcion B: Endpoint manual POST `/ai/rechunk-summary`

### Re-ingesta

Despues de implementar el nuevo chunker:
```sql
-- 1. Borrar chunks viejos (o marcar como version anterior)
DELETE FROM chunks WHERE summary_id IN (SELECT id FROM summaries);
-- 2. Re-chunkar via el nuevo endpoint
-- 3. Re-ingest embeddings via POST /ai/ingest-embeddings
```

---

## Fase 6 — Re-ranking con Gemini

**Prioridad:** BAJA — mejora marginal sobre los resultados actuales.
**Riesgo:** MEDIO — agrega una llamada Gemini extra por query (costo + latencia).
**Impacto:** Mejor precision en top-3 resultados (importa para respuestas cortas).

### Por que no cross-encoders tradicionales

Gemini no tiene un API de cross-encoder dedicada (como Cohere Rerank o Jina Reranker).
Pero se puede usar Gemini como re-ranker pidiendo un scoring de relevancia.

### Estrategia: Gemini-as-Reranker

```typescript
// En routes/ai/chat.ts, despues de rag_hybrid_search():

// 1. Obtener top 10 chunks del hybrid search (en vez de top 5)
// 2. Pedir a Gemini que re-rankee:
const rerankPrompt = `
Dada esta pregunta del alumno: "${message}"

Y estos ${chunks.length} fragmentos de texto educativo, ordenalos
del mas relevante al menos relevante. Responde SOLO con los indices
en orden, separados por coma.

${chunks.map((c, i) => `[${i}] ${c.content.substring(0, 200)}`).join('\n\n')}
`;

const rerankedOrder = await generateText({
  prompt: rerankPrompt,
  temperature: 0,
  maxTokens: 50,
});

// 3. Tomar los top 5 del re-ranking
```

### Trade-offs

| Ventaja | Desventaja |
|---|---|
| Mejor precision top-3 | +1 Gemini call por query (~200ms extra) |
| Usa el modelo que ya tienes (sin nuevo provider) | Consume tokens del free tier |
| Gemini entiende contexto educativo | No es tan preciso como un cross-encoder dedicado |

### Alternativa futura

Cuando tengas presupuesto:
- Cohere Rerank API ($1/1000 queries) — precision superior
- O migrar a Vertex AI que tiene re-ranking nativo

---

## Fase 7 — Ingestion multi-fuente (PDF, API)

**Prioridad:** BAJA — actualmente los profesores escriben en `content_markdown`.
**Riesgo:** ALTO — parsing de PDF es complejo y propenso a errores.
**Impacto:** Desbloquea upload de materiales existentes (PDFs de clase, slides).

### Arquitectura propuesta

```
POST /ai/ingest-document
  -> Detectar tipo (PDF, DOCX, TXT, URL)
  -> Extraer texto (pdf-parse, mammoth, etc.)
  -> Limpiar y normalizar markdown
  -> Guardar en summaries.content_markdown
  -> Chunkar con chunker.ts
  -> Generar embeddings con ingest-embeddings
```

### Limitaciones en Deno/Edge Functions

- `pdf-parse` no funciona directo en Deno — necesita wasm o un servicio externo
- Opcion pragmatica: usar Gemini para extraer texto de PDF
  ```typescript
  // Gemini 2.5 Flash soporta input multimodal (PDF)
  // Enviar el PDF como base64 y pedir que extraiga el texto en markdown
  ```
- Opcion robusta: servicio externo (Unstructured.io, Apache Tika) como pre-procesador

### Por que esta fase es la ultima

1. La mayoria del contenido se crea directamente en markdown (flujo actual)
2. PDF parsing agrega complejidad y puntos de fallo
3. Mejor invertir primero en mejorar la calidad del RAG con el contenido existente

---

## Orden de implementacion recomendado

```
Fase 1: Indices HNSW              [1 dia]   [SQL only]         [alto impacto, cero riesgo]
  |
Fase 2: Columnas tsvector         [1 dia]   [SQL + RPC update] [mejora FTS]
  |
Fase 4: Query logging             [1 dia]   [SQL + 1 insert]   [analytics para iterar]
  |
Fase 5: Chunking inteligente      [2 dias]  [nuevo archivo]    [mejora calidad RAG]
  |
Fase 3: Embeddings en summaries   [1 dia]   [SQL + ingest.ts]  [coarse-to-fine]
  |
Fase 6: Re-ranking con Gemini     [1 dia]   [chat.ts]          [precision marginal]
  |
Fase 7: Ingestion PDF             [3 dias]  [nuevo modulo]     [feature nueva]
```

**Total estimado: ~10 dias de trabajo**

> **Nota:** La Fase 4 (query logging) se mueve antes de la Fase 5 (chunking)
> porque los logs te permitiran medir el impacto del nuevo chunking
> comparando metricas antes/despues.

---

## Adaptaciones especificas para Gemini

| Aspecto | Blueprint original (OpenAI) | Adaptacion Gemini |
|---|---|---|
| Modelo embeddings | `text-embedding-3-large` (1536/3072 dims) | `gemini-embedding-001` (768 dims via `outputDimensionality`) |
| Modelo generacion | GPT-4 / GPT-3.5 | `gemini-2.5-flash` (via `GENERATE_MODEL` en gemini.ts) |
| Cross-encoder | Cohere Rerank | Gemini-as-Reranker (prompt-based, Fase 6) |
| API Key | `OPENAI_API_KEY` | `GEMINI_API_KEY` (ya configurada) |
| Costo | ~$0.13/1M tokens (embed) | Gratis (free tier, con rate limit 429) |
| Rate limiting | Token-based | RPM-based (15 RPM free tier → backoff en gemini.ts) |
| PDF extraction | pdf-parse library | Gemini multimodal (PDF como input) o servicio externo |
| Max input embeddings | 8191 tokens | ~10k tokens (Gemini es mas generoso) |

### Migracion futura a OpenAI (si necesario)

El codigo esta preparado para cambiar de provider:
1. Editar `generateEmbedding()` en `gemini.ts` para llamar a OpenAI
2. Cambiar `EMBEDDING_DIMENSIONS` de 768 a 1536
3. Migration: `ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(1536)`
4. Re-ingest ALL chunks (embeddings incompatibles entre modelos)
5. Recrear indices HNSW

> **Recomendacion:** No migrar a menos que la calidad de retrieval con Gemini
> sea insuficiente. El free tier de Gemini es una ventaja significativa durante
> desarrollo y testing.
