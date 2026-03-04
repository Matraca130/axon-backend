# RAG Roadmap — Blueprint completo con Gemini

> Plan de implementacion para completar todo lo propuesto en los documentos
> de investigacion (`pgvector-axon-integration.md`, `axon-rag-architecture.md`,
> `chunking-strategies.md`, `hybrid-retrieval.ts`, `adaptive-ia-study.md`),
> adaptado a Gemini como provider inicial.
>
> **Auditoria v4:** 2026-03-04 — Appendix A con helper functions completas.
> v3: 3 errores corregidos, 12 gaps de investigacion integrados.

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

### RPC actualizado completo (Fase 1 + Fase 2 combinadas)

Ver [Appendix A > rag_hybrid_search v2](#a3-rag_hybrid_search-v2-despues-de-fase-1--fase-2) para la funcion completa.

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

### Implementacion completa: `chunker.ts`

Ver [Appendix A > chunkMarkdown()](#a1-chunkertsimplementacion-completa) para el codigo completo.

### Semantic Chunking (upgrade opcional)

Usa `cosineSimilarity()` de [Appendix A](#a2-helper-functions) para detectar cambios de tema:

```typescript
async function semanticChunk(
  text: string,
  similarityThreshold: number = 0.75
): Promise<string[]> {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const embeddings = await Promise.all(
    sentences.map(s => generateEmbedding(s, "RETRIEVAL_DOCUMENT"))
  );

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

Genera multiples reformulaciones de la query. Usa `rrfFusion()` de [Appendix A](#a2-helper-functions).

```typescript
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
  return [message, ...reformulations];
}

// Embed each query, search each, merge with RRF
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
      p_similarity_threshold: 0.25,
    });
    return data || [];
  })
);

const merged = rrfFusion(allResults, 60);  // k=60 standard
const topChunks = merged.slice(0, 5);
```

### 6B. HyDE — Hypothetical Document Embeddings (+20% recall)

```typescript
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

const hypothetical = await hydeExpand(message);
const hydeEmbedding = await generateEmbedding(hypothetical, "RETRIEVAL_DOCUMENT");
```

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

### 6D. Seleccion dinamica de estrategia

```typescript
function selectStrategy(message: string): 'standard' | 'multi_query' | 'hyde' {
  const abstractKeywords = ['por que', 'cual es la importancia', 'que relacion',
    'compara', 'diferencia entre', 'como se relaciona'];
  if (abstractKeywords.some(k => message.toLowerCase().includes(k))) {
    return 'hyde';
  }
  if (message.includes(' y ') || message.includes(' vs ') || message.split(',').length > 1) {
    return 'multi_query';
  }
  return 'standard';
}
```

### Metricas de impacto esperadas

| Estrategia | Recall@10 | Precision@5 | Latencia extra | Costo extra |
|---|---|---|---|---|
| Standard (actual) | baseline | baseline | 0ms | $0 |
| + Multi-Query | +25% | +10% | ~400ms | 4 embeds + 1 gen |
| + HyDE | +20% | +15% | ~300ms | 1 embed + 1 gen |
| + Re-ranking | +5% | +40% | ~200ms | 1 gen |
| Todo combinado | +35% | +50% | ~900ms | 5 embeds + 3 gen |

> **Nota de costo free tier:** Con 15 RPM generate, Multi-Query + HyDE limita
> a ~4 queries RAG/minuto. Considerar activar solo cuando `top_similarity < 0.5`.

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

### Gemini multimodal para PDF

```typescript
// Gemini 2.5 Flash soporta input multimodal
// El PDF se envia como inline_data en base64
const result = await generateText({
  prompt: "Convierte este PDF a markdown limpio. Preserva headers (##), listas y tablas.",
  // Nota: generateText() necesita extension para soportar inline_data
  // Ver: https://ai.google.dev/gemini-api/docs/document-processing
});
```

---

## Fase 8 — IA Adaptativa: NeedScore + Pre-generacion + Calidad

**Prioridad:** MEDIA — mejora la experiencia del alumno significativamente.
**Riesgo:** MEDIO — varios cambios en generate.ts + nuevos endpoints.
**Impacto:** Generacion mas inteligente + mecanismos de calidad.

### 8A. NeedScore integration con `/ai/generate`

El `NeedScore` ya existe en `routes-study-queue.tsx`:
```
NeedScore = 0.40*overdue + 0.30*(1-p_know) + 0.20*fragility + 0.10*novelty
```

**Nuevo endpoint: POST `/ai/generate-smart`**

```typescript
// Body: { summary_id: UUID, action: "flashcard" | "quiz_question" }
// NO requiere keyword_id ni subtopic_id — los elige automaticamente
//
// Pipeline:
//   1. Fetch all subtopics for this summary (via keywords -> subtopics)
//   2. Fetch BKT states for each subtopic (this student)
//   3. Fetch FSRS states for related flashcards (lapses, due dates)
//   4. Calculate NeedScore for each subtopic:
//      overdue  = fsrs.due_at ? 1 - Math.exp(-daysOverdue / 3) : 1.0
//      mastery  = 1 - bkt.p_know
//      fragility = fsrs.lapses / (fsrs.reps + fsrs.lapses + 1)
//      novelty  = fsrs.state === 'new' ? 1.0 : 0.0
//      NeedScore = 0.40*overdue + 0.30*mastery + 0.20*fragility + 0.10*novelty
//   5. Pick the subtopic with highest NeedScore
//   6. Generate flashcard/quiz for THAT subtopic (reuse existing generate logic)
//   7. Return { ...generated, _meta: { chosen_subtopic, need_score, reason } }
```

### 8B. Pre-generacion en background

```typescript
// POST /ai/pre-generate
// Body: { institution_id: UUID, count: 3 }
// Pipeline:
//   1. Get student's top N NeedScore subtopics
//   2. For each, generate a quiz_question (fire-and-forget)
//   3. Return { queued: N, subtopics: [...] }
```

### 8C. Professor notes en prompt de generate.ts (QUICK FIX)

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

### 8D. Rate limit especifico para AI

```typescript
// En routes/ai/index.ts (combiner), agregar middleware:
const AI_RATE_LIMIT = 20; // per user per hour

aiRoutes.use('*', async (c, next) => {
  const userId = c.get('userId');
  const key = `ai:${userId}`;
  // Check distributed rate limit (DB-based, migration 20260303_02)
  // If exceeded: return err(c, "AI rate limit: max 20/hour", 429);
  await next();
});
```

### 8E. Report question / Flag AI content

```sql
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
```

### 8F. Quality dashboard

```typescript
// GET /ai/flagged-content?institution_id=xxx
// Returns quiz_questions + flashcards where source='ai' AND reported_at IS NOT NULL
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

---

## Housekeeping: Quick fixes

### chat.ts — Comentarios stale en header

```
// DICE: gemini-embedding-004   -> DEBE SER: gemini-embedding-001 (fix D-16)
// DICE: Gemini 2.0 Flash       -> DEBE SER: gemini-2.5-flash (fix D-17)
```

### generate.ts — Professor notes faltantes

Ver Fase 8C. Quick fix independiente.

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

## Appendix A — Helper Functions (implementacion completa)

Estas funciones son referenciadas por las fases pero necesitan implementacion.
Colocar en los archivos indicados.

### A.1 `chunker.ts` — Implementacion completa

```typescript
// supabase/functions/server/chunker.ts

export interface ChunkResult {
  content: string;
  order_index: number;
  metadata: {
    header_path: string;
    char_start: number;
    char_end: number;
    token_estimate: number;
    has_overlap: boolean;
  };
}

// Approximate token count (~1 token per 4 chars for Spanish)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Recursive character splitting with overlap
function recursiveSplit(
  text: string,
  chunkSize: number = 512,
  overlap: number = 128,
  separators: string[] = ['\n\n', '\n', '. ', ' ']
): string[] {
  if (text.length <= chunkSize) return [text];

  const separator = separators[0] || '';
  const parts = separator ? text.split(separator) : [text];
  const result: string[] = [];
  let currentChunk = '';

  for (const part of parts) {
    const candidate = currentChunk
      ? currentChunk + separator + part
      : part;

    if (candidate.length > chunkSize && currentChunk) {
      result.push(currentChunk.trim());
      const overlapText = currentChunk.slice(-overlap);
      currentChunk = overlapText + separator + part;
    } else {
      currentChunk = candidate;
    }
  }

  if (currentChunk.trim()) result.push(currentChunk.trim());

  // If chunks are still too large, recurse with next separator
  if (separators.length > 1) {
    return result.flatMap(chunk =>
      chunk.length > chunkSize
        ? recursiveSplit(chunk, chunkSize, overlap, separators.slice(1))
        : [chunk]
    );
  }

  return result;
}

// Detect if a line is inside a markdown list or table
function isListOrTable(line: string): boolean {
  return /^\s*[-*+]\s/.test(line)    // unordered list
    || /^\s*\d+\.\s/.test(line)       // ordered list
    || /^\|/.test(line)               // table row
    || /^\s*>/.test(line);            // blockquote
}

// Find the end of a list/table block starting at lineIndex
function findBlockEnd(lines: string[], startIdx: number): number {
  let i = startIdx;
  while (i < lines.length && isListOrTable(lines[i])) {
    i++;
  }
  return i;
}

export function chunkMarkdown(markdown: string, opts?: {
  targetChars?: number;
  overlapChars?: number;
}): ChunkResult[] {
  const targetChars = opts?.targetChars ?? 512;
  const overlapChars = opts?.overlapChars ?? 128;

  // 1. Parse headers to build sections with header paths
  interface Section {
    headerPath: string;
    content: string;
    charStart: number;
  }

  const lines = markdown.split('\n');
  const sections: Section[] = [];
  const headerStack: string[] = [];
  let currentContent = '';
  let currentStart = 0;
  let charPos = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(/^(#{1,3})\s+(.+)$/);

    if (headerMatch) {
      // Save previous section
      if (currentContent.trim()) {
        sections.push({
          headerPath: headerStack.join(' > ') || 'Root',
          content: currentContent.trim(),
          charStart: currentStart,
        });
      }

      // Update header stack
      const level = headerMatch[1].length;
      const title = headerMatch[2].trim();
      // Pop headers of same or deeper level
      while (headerStack.length >= level) {
        headerStack.pop();
      }
      headerStack.push(title);

      currentContent = '';
      currentStart = charPos + line.length + 1; // +1 for \n
    } else {
      // Check if this line starts a list/table block
      if (isListOrTable(line)) {
        const blockEnd = findBlockEnd(lines, i);
        const blockContent = lines.slice(i, blockEnd).join('\n');
        currentContent += blockContent + '\n\n';
        charPos += blockContent.length + 2;
        i = blockEnd - 1; // -1 because loop will i++
        continue;
      }
      currentContent += line + '\n';
    }
    charPos += line.length + 1;
  }

  // Save last section
  if (currentContent.trim()) {
    sections.push({
      headerPath: headerStack.join(' > ') || 'Root',
      content: currentContent.trim(),
      charStart: currentStart,
    });
  }

  // 2. Within each section, apply recursive splitting
  const chunks: ChunkResult[] = [];
  let orderIndex = 0;

  for (const section of sections) {
    const splitChunks = recursiveSplit(
      section.content, targetChars, overlapChars
    );

    let sectionCharPos = section.charStart;

    for (let i = 0; i < splitChunks.length; i++) {
      const chunkText = splitChunks[i];
      chunks.push({
        content: chunkText,
        order_index: orderIndex++,
        metadata: {
          header_path: section.headerPath,
          char_start: sectionCharPos,
          char_end: sectionCharPos + chunkText.length,
          token_estimate: estimateTokens(chunkText),
          has_overlap: i > 0,
        },
      });
      // Advance position (subtract overlap for next chunk)
      sectionCharPos += chunkText.length - (i < splitChunks.length - 1 ? overlapChars : 0);
    }
  }

  return chunks;
}
```

### A.2 Helper functions

```typescript
// supabase/functions/server/rag-helpers.ts

/**
 * Cosine similarity between two vectors.
 * Used by semantic chunking (Fase 5) to detect topic boundaries.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('Vector dimension mismatch');
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Reciprocal Rank Fusion (RRF)
 * Merges multiple ranked result lists into one.
 * k=60 is the standard constant (from the original RRF paper).
 *
 * Used by Multi-Query Retrieval (Fase 6A) to merge results
 * from different query reformulations.
 *
 * Algorithm:
 *   For each document d across all result lists:
 *     RRF_score(d) = SUM(1 / (k + rank_i(d)))  for each list i
 *   Where rank_i(d) is the 1-based position of d in list i.
 *   If d doesn't appear in list i, it's ignored for that list.
 *
 * @param resultLists - Array of result arrays from different queries
 * @param k - RRF constant (default 60, higher = more weight to lower-ranked results)
 * @returns Merged and re-ranked results, deduplicated by chunk_id
 */
export function rrfFusion<T extends { chunk_id: string }>(
  resultLists: T[][],
  k: number = 60
): T[] {
  const scoreMap = new Map<string, { score: number; item: T }>();

  for (const results of resultLists) {
    for (let rank = 0; rank < results.length; rank++) {
      const item = results[rank];
      const id = item.chunk_id;
      const rrfScore = 1 / (k + rank + 1); // rank is 0-based, RRF uses 1-based

      const existing = scoreMap.get(id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(id, { score: rrfScore, item });
      }
    }
  }

  // Sort by accumulated RRF score descending
  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.item);
}
```

### A.3 `rag_hybrid_search` v2 (despues de Fase 1 + Fase 2)

```sql
-- Reemplaza la funcion actual en migration YYYYMMDD_XX_rag_hybrid_search_v2.sql
-- Cambios vs v1:
--   1. Solo 2 JOINs (chunks + summaries) en vez de 6 (Fase 1: institution_id denormalizado)
--   2. Usa ch.fts stored column en vez de to_tsvector() inline (Fase 2: tsvector column)
--   3. Mantiene CTE de LA-05 (compute cosine once)

CREATE OR REPLACE FUNCTION rag_hybrid_search(
  p_query_embedding vector(768),
  p_query_text TEXT,
  p_institution_id UUID,
  p_summary_id UUID DEFAULT NULL,
  p_match_count INT DEFAULT 5,
  p_similarity_threshold FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  chunk_id UUID,
  summary_id UUID,
  summary_title TEXT,
  content TEXT,
  similarity FLOAT,
  text_rank FLOAT,
  combined_score FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH scored AS (
    SELECT
      ch.id,
      s.id AS s_id,
      s.title AS s_title,
      ch.content AS c_content,
      -- Compute cosine similarity ONCE (LA-05)
      (1 - (ch.embedding <=> p_query_embedding))::FLOAT AS sim,
      -- Fase 2: use stored tsvector column instead of inline to_tsvector()
      ts_rank(
        ch.fts,
        plainto_tsquery('spanish', p_query_text)
      )::FLOAT AS trank
    FROM chunks ch
    -- Fase 1: only 1 JOIN needed (institution_id is on summaries now)
    JOIN summaries s ON s.id = ch.summary_id
    WHERE ch.embedding IS NOT NULL
      AND s.institution_id = p_institution_id   -- Fase 1: direct filter
      AND s.deleted_at IS NULL AND s.is_active = TRUE
      AND (p_summary_id IS NULL OR s.id = p_summary_id)
  )
  SELECT
    scored.id AS chunk_id,
    scored.s_id AS summary_id,
    scored.s_title AS summary_title,
    scored.c_content AS content,
    scored.sim AS similarity,
    scored.trank AS text_rank,
    (0.7 * scored.sim + 0.3 * scored.trank)::FLOAT AS combined_score
  FROM scored
  WHERE scored.sim > p_similarity_threshold
  ORDER BY (0.7 * scored.sim + 0.3 * scored.trank) DESC
  LIMIT p_match_count;
END;
$$;
```

---

## Migracion futura a OpenAI

1. Editar `generateEmbedding()` en `gemini.ts`
2. Cambiar `EMBEDDING_DIMENSIONS` de 768 a 1536
3. Migrations: ALTER columns + function signatures (ver checklist arriba)
4. Re-ingest ALL chunks y summaries
5. Recrear indices HNSW

> **Recomendacion:** No migrar a menos que la calidad de retrieval sea insuficiente.
> El free tier de Gemini es una ventaja durante desarrollo.
