# RAG Roadmap — Blueprint completo con Gemini

> Plan de implementacion para completar todo lo propuesto en los documentos
> de investigacion (`pgvector-axon-integration.md`, `axon-rag-architecture.md`,
> `chunking-strategies.md`, `hybrid-retrieval.ts`, `adaptive-ia-study.md`),
> adaptado a Gemini como provider inicial.
>
> **Auditoria v3:** 2026-03-04 — 3 errores corregidos, 12 gaps de investigacion integrados.

---

## Estado actual vs Blueprint + Investigacion

| # | Feature | Estado | Fuente |
|---|---|---|---|
| 1 | pgvector extension habilitada | **DONE** | blueprint |
| 2 | Columna `embedding` en `chunks` | **DONE** | blueprint |
| 3 | Columna `embedding` en `summaries` | **PENDIENTE** | blueprint |
| 4 | Columnas `fts TSVECTOR` generadas + GIN | **PARCIAL** | blueprint |
| 5 | Indices HNSW para vectores en chunks | **DONE** | blueprint (LA-04) |
| 6 | `rag_hybrid_search()` RPC | **DONE** | blueprint (LA-05) |
| 7 | `rag_query_log` tabla | **PENDIENTE** | blueprint |
| 8 | Ruta de ingesta de embeddings | **DONE** | blueprint |
| 9 | Ruta de busqueda semantica + respuesta | **DONE** | blueprint |
| 10 | Generacion adaptativa (flashcards/quiz) | **DONE** | blueprint |
| 11 | Chunking inteligente (semantico) | **PENDIENTE** | blueprint + chunking-strategies |
| 12 | Re-ranking | **PENDIENTE** | blueprint + hybrid-retrieval |
| 13 | Ingestion multi-fuente (PDF, API) | **PENDIENTE** | blueprint |
| 14 | Auth + institution scoping | **DONE** | blueprint |
| 15 | Retry con backoff exponencial | **DONE** | blueprint |
| 16 | Denormalizacion institution_id | **PENDIENTE** | auditoria v2 |
| 17 | Feedback loop (thumbs up/down) en RAG chat | **PENDIENTE** | auditoria v2 |
| 18 | Monitoring de cobertura de embeddings | **PENDIENTE** | auditoria v2 |
| 19 | Auto-ingest trigger | **PENDIENTE** | auditoria v2 |
| 20 | Multi-Query Retrieval (+25% recall) | **PENDIENTE** | hybrid-retrieval.ts |
| 21 | HyDE — Hypothetical Document Embeddings | **PENDIENTE** | hybrid-retrieval.ts |
| 22 | Seleccion dinamica de estrategia de retrieval | **PENDIENTE** | hybrid-retrieval.ts |
| 23 | Semantic Chunking (embedding-based boundaries) | **PENDIENTE** | chunking-strategies |
| 24 | Decision framework para estrategia de chunking | **PENDIENTE** | chunking-strategies |
| 25 | NeedScore integration con /ai/generate | **PENDIENTE** | adaptive-ia-study |
| 26 | Pre-generacion en background | **PENDIENTE** | adaptive-ia-study |
| 27 | Rate limit especifico para AI (20/hr) | **PENDIENTE** | adaptive-ia-study |
| 28 | Professor notes (kw_prof_notes) en prompt de generate | **PENDIENTE** | adaptive-ia-study |
| 29 | Report question / flag AI content | **PENDIENTE** | adaptive-ia-study |
| 30 | Quality dashboard para preguntas AI flaggeadas | **PENDIENTE** | adaptive-ia-study |
| 31 | chat.ts comentarios stale en header | **PENDIENTE** | auditoria v2 |

**Resumen: 9/31 completados, 22 pendientes.**

---

## Errores corregidos en auditorias anteriores

| Error | Que decia | Realidad |
|---|---|---|
| **ERR-1** | "Indices HNSW: PENDIENTE" | Ya existe `idx_chunks_embedding` HNSW en migration `20260305_03` (LA-04) |
| **ERR-2** | "Full-text via `pg_trgm` en el RPC" | RPC usa `to_tsvector('spanish') + ts_rank()` (FTS estandar). `pg_trgm` es busqueda global |
| **ERR-3** | Fase 1 proponia crear indices HNSW | Redundante — eliminada, reemplazada por denormalizacion |

---

## Fase 1 — Performance: Denormalizar `institution_id` en summaries

**Prioridad:** ALTA — el RPC `rag_hybrid_search()` hace un JOIN de 6 tablas en cada query.
**Riesgo:** MEDIO — requiere migration + trigger + actualizar el RPC.
**Impacto:** Elimina 4 JOINs por query (chunks->summaries->topics->sections->semesters->courses).

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

### Actualizar `rag_hybrid_search()` RPC

```sql
-- DESPUES: 2-table JOIN (chunks + summaries) en vez de 6
FROM chunks ch
  JOIN summaries s ON s.id = ch.summary_id
WHERE ch.embedding IS NOT NULL
  AND s.institution_id = p_institution_id
  AND s.deleted_at IS NULL AND s.is_active = TRUE
  AND (p_summary_id IS NULL OR s.id = p_summary_id)
```

---

## Fase 2 — Columnas tsvector generadas + GIN index

**Prioridad:** MEDIA — mejora performance de FTS sin cambiar logica.
**Riesgo:** BAJO — columnas generated son transparentes.
**Impacto:** Ahorra CPU de `to_tsvector()` inline por fila + habilita pre-filtro GIN.

### Migration SQL

```sql
-- Archivo: supabase/migrations/YYYYMMDD_02_fts_columns.sql

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

---

## Fase 4 — Query logging + Feedback loop

**Prioridad:** MEDIA — analytics + mejora iterativa.
**Riesgo:** BAJO — tabla nueva, inserts async.
**Impacto:** Medir calidad y mejorar el sistema con datos reales.

### Migration SQL

```sql
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
  search_type TEXT DEFAULT 'hybrid',
  model_used TEXT,
  feedback SMALLINT,  -- NULL=sin feedback, 1=thumbs up, -1=thumbs down
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_rag_query_log_inst_date ON rag_query_log (institution_id, created_at DESC);
CREATE INDEX idx_rag_query_log_user ON rag_query_log (user_id, created_at DESC);
CREATE INDEX idx_rag_query_log_negative ON rag_query_log (institution_id, feedback) WHERE feedback = -1;

ALTER TABLE rag_query_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY rag_log_own ON rag_query_log FOR SELECT USING (user_id = auth.uid());
CREATE POLICY rag_log_institution ON rag_query_log FOR SELECT USING (
  EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = auth.uid()
    AND m.institution_id = rag_query_log.institution_id
    AND m.role IN ('owner','admin') AND m.is_active = TRUE)
);
-- INSERT via adminClient (bypass RLS) — no policy needed
```

### Nuevos endpoints

- `PATCH /ai/rag-feedback` — `{ log_id, feedback: 1|-1 }`
- `GET /ai/rag-analytics?institution_id=&from=&to=` — metricas agregadas
- `GET /ai/embedding-coverage?institution_id=` — % chunks con embedding

---

## Fase 5 — Chunking inteligente + Auto-ingest

**Prioridad:** MEDIA-ALTA — chunking actual es basico, afecta calidad directamente.
**Riesgo:** MEDIO — requiere re-ingest.
**Impacto:** Mejor coherencia semantica = mejor retrieval = mejores respuestas.

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

Razon: los resumenes de Axon son contenido educativo con headers markdown claros.
Recursive Character respeta esos headers. Semantic Chunking solo agrega valor
cuando un summary mezcla multiples temas sin headers claros.

### Implementacion: Recursive Character (default)

```typescript
// supabase/functions/server/chunker.ts

export interface ChunkResult {
  content: string;
  order_index: number;
  metadata: {
    header_path: string;      // "Cap 2 > Sec 2.1"
    char_start: number;
    char_end: number;
    token_estimate: number;
    has_overlap: boolean;
  };
}

// Recursive character splitting with overlap
function recursiveSplit(
  text: string,
  chunkSize: number = 512,    // ~400 tokens
  overlap: number = 128,      // ~50 tokens
  separators: string[] = ['\n\n', '\n', '. ', ' ']
): string[] {
  if (text.length <= chunkSize) return [text];

  const separator = separators[0] || '';
  const parts = text.split(separator);
  const result: string[] = [];
  let currentChunk = '';

  for (const part of parts) {
    const candidate = currentChunk
      ? currentChunk + separator + part
      : part;

    if (candidate.length > chunkSize && currentChunk) {
      result.push(currentChunk.trim());
      // Overlap: include tail of previous chunk
      const overlapText = currentChunk.slice(-overlap);
      currentChunk = overlapText + separator + part;
    } else {
      currentChunk = candidate;
    }
  }

  if (currentChunk.trim()) result.push(currentChunk.trim());

  // If any chunk is still too large, recurse with next separator
  if (separators.length > 1) {
    return result.flatMap(chunk =>
      chunk.length > chunkSize
        ? recursiveSplit(chunk, chunkSize, overlap, separators.slice(1))
        : [chunk]
    );
  }

  return result;
}

export function chunkMarkdown(markdown: string, opts?: {
  targetChars?: number;     // default 512 chars (~400 tokens)
  overlapChars?: number;    // default 128 chars (~50 tokens)
}): ChunkResult[] {
  const targetChars = opts?.targetChars ?? 512;
  const overlapChars = opts?.overlapChars ?? 128;

  // 1. Split by headers first (## and ###)
  const headerRegex = /^(#{1,3})\s+(.+)$/gm;
  const sections: { headerPath: string; content: string; start: number }[] = [];
  // ... parse headers, build sections with header_path

  // 2. Within each section, apply recursive splitting
  // 3. Build ChunkResult[] with metadata
  // 4. Preserve lists and tables (don't split mid-list)
}
```

### Implementacion: Semantic Chunking (upgrade opcional)

```typescript
// Solo para summaries donde recursive produce chunks incoherentes
// Usa embeddings para detectar cambios de tema

async function semanticChunk(
  text: string,
  similarityThreshold: number = 0.75
): Promise<string[]> {
  // 1. Split text into sentences
  const sentences = text.split(/(?<=[.!?])\s+/);

  // 2. Embed each sentence
  const embeddings = await Promise.all(
    sentences.map(s => generateEmbedding(s, "RETRIEVAL_DOCUMENT"))
  );

  // 3. Compare consecutive sentence embeddings
  // When cosine similarity drops below threshold, start new chunk
  const chunks: string[] = [];
  let currentChunk = sentences[0];

  for (let i = 1; i < sentences.length; i++) {
    const sim = cosineSimilarity(embeddings[i-1], embeddings[i]);
    if (sim < similarityThreshold) {
      chunks.push(currentChunk);
      currentChunk = sentences[i];
    } else {
      currentChunk += ' ' + sentences[i];
    }
  }
  if (currentChunk) chunks.push(currentChunk);

  return chunks;
}
```

> **Costo:** Semantic chunking requiere 1 embedding por oracion.
> Un summary de 20 oraciones = 20 embeddings. En free tier de Gemini
> esto es viable (1500 RPM), pero para ingesta masiva considerar
> el rate limiting.

### Auto-ingest: POST `/ai/rechunk-summary`

```typescript
// Pipeline:
//   1. Fetch summary.content_markdown
//   2. Decide strategy: recursive (default) or semantic (if >2000 tokens)
//   3. DELETE old chunks for this summary
//   4. INSERT new chunks
//   5. generateEmbedding() for each new chunk
//   6. Return { chunks_created, embeddings_generated, strategy_used }
```

### DB Trigger: Invalidar embeddings cuando content cambia

```sql
CREATE OR REPLACE FUNCTION mark_chunks_stale()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.content_markdown IS DISTINCT FROM NEW.content_markdown THEN
    UPDATE chunks SET embedding = NULL WHERE summary_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_summary_content_changed
  AFTER UPDATE OF content_markdown ON summaries
  FOR EACH ROW EXECUTE FUNCTION mark_chunks_stale();
```

---

## Fase 6 — Retrieval avanzado (Multi-Query + HyDE + Re-ranking)

**Prioridad:** MEDIA — mejora significativa de recall y precision.
**Riesgo:** MEDIO — agrega llamadas Gemini extra.
**Impacto:** +25-40% recall/precision segun la estrategia.

> **Fuente:** `hybrid-retrieval.ts` de la investigacion describe 4 estrategias.
> La #1 (Hybrid RRF) ya esta implementada. Faltan #2, #3, y #4.

### 6A. Multi-Query Retrieval (+25% recall)

Genera multiples reformulaciones de la query para capturar diferentes angulos semanticos.

```typescript
// En chat.ts, ANTES de generar el embedding:

async function expandQuery(message: string): Promise<string[]> {
  const result = await generateText({
    prompt: `Genera 3 reformulaciones de esta pregunta educativa.
Cada una debe capturar un aspecto diferente del tema.
Pregunta original: "${message}"

Responde en JSON: ["reformulacion 1", "reformulacion 2", "reformulacion 3"]`,
    jsonMode: true,
    temperature: 0.7,
    maxTokens: 200,
  });
  const reformulations = parseGeminiJson<string[]>(result.text);
  return [message, ...reformulations]; // original + 3 reformulaciones
}

// Embed each query, search each, merge results with RRF
const queries = await expandQuery(message);
const allResults = await Promise.all(
  queries.map(async (q) => {
    const emb = await generateEmbedding(q, "RETRIEVAL_QUERY");
    const { data } = await db.rpc("rag_hybrid_search", {
      p_query_embedding: JSON.stringify(emb),
      p_query_text: q,
      p_institution_id: institutionId,
      p_summary_id: summaryId,
      p_match_count: 10,
      p_similarity_threshold: 0.25,  // lower threshold for more recall
    });
    return data || [];
  })
);

// RRF fusion: merge and re-rank by reciprocal rank
const merged = rrfFusion(allResults, k=60);
const topChunks = merged.slice(0, 5);
```

**Costo:** +1 Gemini generate call + 3 extra embeddings por query.
**Cuando usarlo:** Queries multi-faceta ("compara fotosintesis con respiracion").

### 6B. HyDE — Hypothetical Document Embeddings (+20% recall en queries abstractas)

Genera un documento hipotetico que responderia la query, luego busca similares a ESE.

```typescript
// En chat.ts, ANTES de generar el embedding:

async function hydeExpand(message: string): Promise<string> {
  const result = await generateText({
    prompt: `Escribe un parrafo educativo de ~100 palabras que responda
esta pregunta de un alumno: "${message}"
Escribe como si fuera parte de un resumen academico.`,
    temperature: 0.3,
    maxTokens: 200,
  });
  return result.text;
}

// Embed the hypothetical answer (closer to documents in embedding space)
const hypothetical = await hydeExpand(message);
const hydeEmbedding = await generateEmbedding(hypothetical, "RETRIEVAL_DOCUMENT");
// Search with hyde embedding — finds documents similar to a "good answer"
```

**Costo:** +1 Gemini generate call + 1 embedding por query.
**Cuando usarlo:** Queries abstractas ("por que es importante X?", "que relacion tiene Y con Z?").

### 6C. Re-ranking con Gemini (JSON scores)

```typescript
const rerankPrompt = `
Dada esta pregunta: "${message}"

Puntua la relevancia de cada fragmento del 0.0 al 1.0.
Responde SOLO con JSON: [{"index": 0, "score": 0.95}, ...]

${chunks.map((c, i) => `[${i}] ${c.content.substring(0, 300)}`).join('\n\n')}
`;

const result = await generateText({
  prompt: rerankPrompt,
  jsonMode: true,
  temperature: 0,
  maxTokens: 200,
});

const scores = parseGeminiJson<Array<{index: number; score: number}>>(result.text);
const reranked = scores.sort((a, b) => b.score - a.score)
  .slice(0, 5).map(s => chunks[s.index]).filter(Boolean);
```

**Costo:** +1 Gemini generate call por query.
**Cuando usarlo:** Siempre (si el presupuesto lo permite) o solo cuando top_similarity < 0.5.

### 6D. Seleccion dinamica de estrategia

Decision tree de `hybrid-retrieval.ts`, adaptado a Gemini:

```typescript
// En chat.ts, decidir estrategia basada en la query:

function selectStrategy(message: string, historyLength: number): 'standard' | 'multi_query' | 'hyde' {
  // Queries abstractas o conceptuales -> HyDE
  const abstractKeywords = ['por que', 'cual es la importancia', 'que relacion',
    'compara', 'diferencia entre', 'como se relaciona'];
  if (abstractKeywords.some(k => message.toLowerCase().includes(k))) {
    return 'hyde';
  }

  // Queries con multiples aspectos -> Multi-Query
  if (message.includes(' y ') || message.includes(' vs ') || message.split(',').length > 1) {
    return 'multi_query';
  }

  // Default: standard hybrid search
  return 'standard';
}
```

> **Nota de costo:** En free tier de Gemini, Multi-Query y HyDE agregan
> 1-4 llamadas extra. Con 15 RPM generate, esto limita a ~4 queries RAG/minuto
> si se usan estrategias avanzadas. Considerar activarlas solo cuando
> `top_similarity < 0.5` (resultados pobres con standard).

### Metricas de impacto esperadas

| Estrategia | Recall@10 | Precision@5 | Latencia extra | Costo extra |
|---|---|---|---|---|
| Standard (actual) | baseline | baseline | 0ms | $0 |
| + Multi-Query | +25% | +10% | ~400ms | 4 embeds + 1 gen |
| + HyDE | +20% | +15% | ~300ms | 1 embed + 1 gen |
| + Re-ranking | +5% | +40% | ~200ms | 1 gen |
| Todo combinado | +35% | +50% | ~900ms | 5 embeds + 3 gen |

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
  -> Generar embeddings via ingest-embeddings
```

### Limitaciones en Deno/Edge Functions

- `pdf-parse` no funciona en Deno
- Opcion pragmatica: Gemini 2.5 Flash soporta input multimodal (PDF como base64)
- Opcion robusta: servicio externo (Unstructured.io) como pre-procesador

---

## Fase 8 — IA Adaptativa: NeedScore + Pre-generacion + Calidad

**Prioridad:** MEDIA — mejora la experiencia del alumno significativamente.
**Riesgo:** MEDIO — varios cambios en generate.ts + nuevos endpoints.
**Impacto:** Generacion mas inteligente + mecanismos de calidad.

> **Fuente:** `adaptive-ia-study.md` describe 6 features que faltan en el roadmap.

### 8A. NeedScore integration con `/ai/generate`

El `NeedScore` ya existe en `routes-study-queue.tsx`:
```
NeedScore = 0.40*overdue + 0.30*(1-p_know) + 0.20*fragility + 0.10*novelty
```

Pero `/ai/generate` no lo usa. El endpoint genera para el keyword/subtopic que
el frontend pide, sin considerar que seria MAS util estudiar.

**Nuevo endpoint: POST `/ai/generate-smart`**

```typescript
// POST /ai/generate-smart
// Body: { summary_id: UUID, action: "flashcard" | "quiz_question" }
// NO requiere keyword_id ni subtopic_id — los elige automaticamente
//
// Pipeline:
//   1. Fetch all subtopics for this summary
//   2. Fetch BKT states for each subtopic (this student)
//   3. Calculate NeedScore for each
//   4. Pick the subtopic with highest NeedScore
//   5. Generate flashcard/quiz for THAT subtopic
//   6. Return { ...generated, _meta: { chosen_subtopic, need_score } }
```

Esto permite al frontend simplemente decir "genera algo util" sin decidir que keyword.

### 8B. Pre-generacion en background

Cuando un alumno inicia una sesion de estudio, pre-generar 2-3 preguntas
en background para los subtopics con mayor NeedScore.

```typescript
// POST /ai/pre-generate
// Body: { institution_id: UUID, count: 3 }
// Pipeline:
//   1. Get student's top 3 NeedScore subtopics
//   2. For each, generate a quiz_question (fire-and-forget)
//   3. Return { queued: 3, subtopics: [...] }
//
// Frontend: llamar al iniciar study session, mostrar preguntas pre-generadas primero
```

### 8C. Professor notes en prompt de generate.ts

El archivo `adaptive-ia-study.md` (lineas 302-312) muestra que las notas
del profesor (`kw_prof_notes`) deben incluirse como contexto.

**El codigo actual en `generate.ts` NO las fetch.** Falta agregar:

```typescript
// En generate.ts, despues de fetch keyword:
const { data: profNotes } = await db
  .from("kw_prof_notes")
  .select("note")
  .eq("keyword_id", keywordId)
  .limit(3);

if (profNotes?.length) {
  blockContext += "\nNotas del profesor: " +
    profNotes.map((n: any) => n.note).join("; ");
}
```

Esto es un quick fix — se puede hacer antes de la Fase 8 completa.

### 8D. Rate limit especifico para AI

El rate limiter actual es global (120 req/min para todo).
`adaptive-ia-study.md` recomienda: "max 20 generaciones por alumno por hora".

```typescript
// En routes/ai/index.ts (combiner), agregar middleware:
const AI_RATE_LIMIT = 20; // per user per hour

aiRoutes.use('*', async (c, next) => {
  const userId = c.get('userId'); // from authenticate()
  const key = `ai:${userId}`;
  // Check rate limit (reuse rate-limit.ts or distributed via DB)
  // If exceeded: return err(c, "AI rate limit: max 20/hour", 429);
  await next();
});
```

### 8E. Report question / Flag AI content

```sql
-- Agregar a quiz_questions y flashcards:
ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS reported_at TIMESTAMPTZ;
ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS reported_by UUID REFERENCES auth.users(id);
ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS report_reason TEXT;

ALTER TABLE flashcards ADD COLUMN IF NOT EXISTS reported_at TIMESTAMPTZ;
ALTER TABLE flashcards ADD COLUMN IF NOT EXISTS reported_by UUID REFERENCES auth.users(id);
ALTER TABLE flashcards ADD COLUMN IF NOT EXISTS report_reason TEXT;
```

```typescript
// POST /ai/report
// Body: { type: "quiz_question" | "flashcard", id: UUID, reason: string }
// Sets reported_at, reported_by, report_reason
```

### 8F. Quality dashboard (endpoint para profesor)

```typescript
// GET /ai/flagged-content?institution_id=xxx
// Retorna quiz_questions y flashcards donde:
//   - source = 'ai' AND reported_at IS NOT NULL
//   - Agrupados por summary
//   - Con info del report (reason, who, when)
```

---

## Orden de implementacion recomendado

```
Fase 1: Denormalizar institution_id   [1 dia]  [SQL + RPC]      [elimina 4 JOINs por query]
  |
Fase 2: Columnas tsvector + GIN      [1 dia]  [SQL + RPC]      [mejora FTS performance]
  |
  +-- Quick fix: prof notes en generate.ts  [15 min]  [1 archivo]
  +-- Quick fix: chat.ts stale comments     [5 min]   [1 archivo]
  |
Fase 4: Query log + feedback          [1 dia]  [SQL + chat.ts]  [analytics para iterar]
  |
Fase 5: Chunking + auto-ingest        [2 dias] [nuevo archivo]  [mejora calidad RAG]
  |
Fase 3: Embeddings en summaries       [1 dia]  [SQL + ingest]   [coarse-to-fine]
  |
Fase 8: IA adaptativa completa        [3 dias] [generate.ts +]  [NeedScore + pre-gen + calidad]
  |                                            [nuevos endpoints]
  |
Fase 6: Retrieval avanzado            [2 dias] [chat.ts]        [Multi-Query + HyDE + re-rank]
  |
Fase 7: Ingestion PDF                 [3 dias] [nuevo modulo]   [feature nueva]
```

**Total estimado: ~15 dias de trabajo** (+ 20 min quick fixes)

> **Notas de orden:**
> - Fase 4 antes de Fase 5 para medir impacto del chunking.
> - Fase 8 antes de Fase 6 porque impacta mas la experiencia del alumno.
> - Fase 6 es la mas "research-heavy" — requiere experimentar con thresholds.
> - Quick fixes (prof notes + stale comments) se pueden hacer en cualquier momento.

---

## Housekeeping: Quick fixes

### chat.ts — Comentarios stale en header

```
// DICE: gemini-embedding-004   → DEBE SER: gemini-embedding-001 (fix D-16)
// DICE: Gemini 2.0 Flash       → DEBE SER: gemini-2.5-flash (fix D-17)
```

### generate.ts — Professor notes faltantes

Agregar fetch de `kw_prof_notes` al prompt (ver Fase 8C).
Este es un quick fix independiente de la Fase 8 completa.

### Migracion de dimensiones: checklist completa

Si en el futuro se cambian dimensiones de embedding:
1. `ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(NEW_DIM)`
2. `ALTER TABLE summaries ALTER COLUMN embedding TYPE vector(NEW_DIM)` (si Fase 3)
3. **Function signature:** `p_query_embedding vector(768)` en `rag_hybrid_search()`
4. **Function signature:** `p_query_embedding vector(768)` en `rag_coarse_to_fine_search()`
5. Re-ingest ALL chunks y summaries
6. Recrear indices HNSW

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

### Migracion futura a OpenAI (si necesario)

1. Editar `generateEmbedding()` en `gemini.ts`
2. Cambiar `EMBEDDING_DIMENSIONS` de 768 a 1536
3. Migrations: ALTER columns + function signatures
4. Re-ingest ALL chunks y summaries
5. Recrear indices HNSW

> **Recomendacion:** No migrar a menos que la calidad de retrieval sea insuficiente.
> El free tier de Gemini es una ventaja durante desarrollo.