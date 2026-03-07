# RAG Roadmap — Blueprint completo (Gemini generacion + OpenAI embeddings)

> Plan de implementacion para completar todo lo propuesto en los documentos
> de investigacion (`pgvector-axon-integration.md`, `axon-rag-architecture.md`,
> `chunking-strategies.md`, `hybrid-retrieval.ts`, `adaptive-ia-study.md`),
> adaptado a Gemini como provider de generacion y OpenAI para embeddings.
>
> **Auditoria v14:** 2026-03-11 — 32/32 features completados. Embeddings migrados a OpenAI 1536d.
> v13: 31/31 completados. Pipeline RAG validado end-to-end.
> v12: Fase 6 Retrieval Avanzado completada (branch feat/fase6-retrieval-avanzado).
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
| 3 | Columna `embedding` en `summaries` | **DONE** | blueprint -> Fase 3 (migration `20260307_03`) |
| 4 | Columnas `fts TSVECTOR` generadas + GIN | **DONE** | blueprint -> T-02 (PR #25) |
| 5 | Indices HNSW para vectores en chunks | **DONE** | blueprint (LA-04) |
| 6 | `rag_hybrid_search()` RPC | **DONE** | blueprint (LA-05) -> optimizado T-01 + T-02 |
| 7 | `rag_query_log` tabla | **DONE** | blueprint -> T-03 (PR #27) |
| 8 | Ruta de ingesta de embeddings | **DONE** | blueprint |
| 9 | Ruta de busqueda semantica + respuesta | **DONE** | blueprint |
| 10 | Generacion adaptativa (flashcards/quiz) | **DONE** | blueprint |
| 11 | Chunking inteligente (semantico) | **DONE** | blueprint + chunking-strategies -> Fase 5 + E2E validation |
| 12 | Re-ranking | **DONE** | blueprint + hybrid-retrieval -> Fase 6C |
| 13 | Ingestion multi-fuente (PDF, API) | **DONE** | blueprint -> Fase 7 (Gemini multimodal PDF) |
| 14 | Auth + institution scoping | **DONE** | blueprint |
| 15 | Retry con backoff exponencial | **DONE** | blueprint |
| 16 | Denormalizacion institution_id | **DONE** | auditoria v2 -> T-01 (PR #24) |
| 17 | Feedback loop (thumbs up/down) en RAG chat | **DONE** | auditoria v2 -> T-03 (PR #27) |
| 18 | Monitoring de cobertura de embeddings | **DONE** | auditoria v2 -> T-03 (PR #27) |
| 19 | Auto-ingest trigger | **DONE** | auditoria v2 -> Issue #30 |
| 20 | Multi-Query Retrieval (+25% recall) | **DONE** | hybrid-retrieval.ts -> Fase 6A |
| 21 | HyDE -- Hypothetical Document Embeddings | **DONE** | hybrid-retrieval.ts -> Fase 6B |
| 22 | Seleccion dinamica de estrategia de retrieval | **DONE** | hybrid-retrieval.ts -> Fase 6D |
| 23 | Semantic Chunking (embedding-based boundaries) | **DONE** | chunking-strategies -> validado E2E (strategy: semantic) |
| 24 | Decision framework para estrategia de chunking | **DONE** | chunking-strategies -> auto-upgrade recursive/semantic implementado |
| 25 | NeedScore integration con /ai/generate | **DONE** | adaptive-ia-study -> Fase 8A |
| 26 | Pre-generacion en background | **DONE** | adaptive-ia-study -> Fase 8D |
| 27 | Rate limit especifico para AI (20/hr) | **DONE** | adaptive-ia-study -> `routes/ai/index.ts` (INC-3) |
| 28 | Professor notes (kw_prof_notes) en prompt de generate | **DONE** | adaptive-ia-study -> `routes/ai/generate.ts` (INC-6) |
| 29 | Report question / flag AI content | **DONE** | adaptive-ia-study -> Fase 8B |
| 30 | Quality dashboard para preguntas AI flaggeadas | **DONE** | adaptive-ia-study -> Fase 8C |
| 31 | chat.ts comentarios stale en header | **DONE** | auditoria v2 -> `routes/ai/chat.ts` (INC-1) |
| 32 | Migracion embeddings a OpenAI 1536d | **DONE** | D57-D63 -> PR #43 |

**Resumen: 32/32 completados. Pipeline RAG validado end-to-end.**

---

## Validacion End-to-End (2026-03-09)

| Test | Resultado | Detalle |
|---|---|---|
| Re-deploy Edge Functions | OK | Schema cache actualizado, columna `chunk_strategy` reconocida |
| Ingestion PDF | OK | Status 200, PDF ingerido via Gemini multimodal |
| Re-chunk | OK | 7 chunks creados, strategy: semantic, embeddings generados |
| Recuperacion de huerfanos | OK | Summary `546749da...` recuperado con strategy: semantic |
| RAG Chat | OK | Status 200, strategy: multi_query, respuesta coherente |

### Bugs resueltos en validacion

| Bug | Causa | Solucion |
|---|---|---|
| `chunk_strategy` column not found | Edge Functions cacheaban schema anterior al deploy | `supabase functions deploy server` forzo reload |
| Summaries sin chunks (huerfanos) | Ingestas previas fallaban por el bug anterior | Re-chunk via `/ai/re-chunk` los recupero |

---

## Limitaciones conocidas

1. **504 Gateway Timeout en PDFs grandes**: El free tier de Supabase Edge Functions tiene limite de 60s. PDFs >~5,000 palabras pueden causar timeout.
   - **Workarounds:**
     - Dividir el PDF en fragmentos en el frontend antes de enviar
     - Implementar Two-Phase Ingest como feature formal
     - Contratar plan Pro ($25/mo) -> timeout sube a 150s
   - **Decision:** No prioritario -- uso principal es flashcards, quizzes y PDFs cortos de profesores (D52)

2. **SQL Editor de Supabase**: Inyecta comentarios metadata que rompen strings literales en `COMMENT ON`. Usar siempre una sola linea corta (D51).

---

## Decisiones arquitectonicas globales (D51-D63)

| ID | Decision | Justificacion |
|---|---|---|
| D51 | SQL `COMMENT ON` en una sola linea corta | SQL Editor de Supabase inyecta metadata que rompe strings multilinea |
| D52 | 504 timeout en PDFs grandes: no prioritario | Uso principal: flashcards, quizzes, PDFs cortos. Workarounds documentados |
| D53 | `chunk_strategy` como columna en `chunks` | Trazabilidad de que estrategia genero cada chunk |
| D54 | Re-deploy fuerza schema cache reload | Solucion al error de columna no reconocida en Edge Functions |
| D55 | Multi-query como retrieval strategy default | Mejor recall en preguntas complejas |
| D56 | Posponer metadata-enriched embeddings | Hasta tener +50 cursos o migrar a 1536d+ (ahora cumplido) |
| D57 | Modelo embeddings: `text-embedding-3-large` truncado a 1536d | Matryoshka truncation, 2x mejor recall que Gemini 768d, $0.13/1M tokens |
| D58 | Migracion in-place (`gemini.ts` mismo archivo) | Cero cambios de imports en auto-ingest, retrieval-strategies, ingest |
| D59 | Retry con exponential backoff para OpenAI embeddings | Misma logica `fetchWithRetry` que ya usaba Gemini (3 intentos, 429/503) |
| D60 | Constantes centralizadas: `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` | Single source of truth exportada desde `gemini.ts` |
| D61 | Guard G5: validacion de dimension del vector retornado | `values.length !== EMBEDDING_DIMENSIONS` -> throw (detecta cambios de API) |
| D62 | NULL embeddings existentes antes de ALTER column | 768d incompatible con 1536d. Re-embed post-migration via endpoints existentes |
| D63 | LLM generacion se mantiene en Gemini 2.5 Flash | Migracion a Claude sera feature separado. Generacion != embeddings |

---

## Migracion a OpenAI Embeddings (D57-D63) -- DONE

**PR:** #43 (branch `feat/openai-embeddings-1536`)
**Estado:** DONE -- Pendiente de merge + deploy.

### Que cambio

| Componente | Antes | Despues |
|---|---|---|
| Modelo embeddings | `gemini-embedding-001` | `text-embedding-3-large` |
| Dimensiones | 768 | 1536 (Matryoshka truncation) |
| API Key | `GEMINI_API_KEY` (shared) | `OPENAI_API_KEY` (dedicated) |
| Costo embeddings | Gratis (free tier) | ~$0.13/1M tokens |
| Max input | ~10K tokens | 8191 tokens |
| Modelo generacion | `gemini-2.5-flash` | `gemini-2.5-flash` (sin cambios) |
| PDF extraction | Gemini multimodal | Gemini multimodal (sin cambios) |

### Archivos modificados

| Archivo | Cambio |
|---|---|
| `gemini.ts` | `generateEmbedding()` internamente usa OpenAI. Firma identica. `taskType` ignorado por compat |
| `20260311_01_embedding_openai_1536.sql` | DROP indexes, NULL embeddings, ALTER to vector(1536), recrear RPCs + indexes |

### Archivos NO modificados (cero cambios de imports)

| Archivo | Import que usa |
|---|---|
| `auto-ingest.ts` | `import { generateEmbedding } from "./gemini.ts"` |
| `retrieval-strategies.ts` | `import { generateEmbedding } from "./gemini.ts"` |
| `routes/ai/ingest.ts` | `import { generateEmbedding } from "../../gemini.ts"` |
| `routes/ai/chat.ts` | Solo usa `generateText` (sin cambios) |
| `semantic-chunker.ts` | Recibe `embedFn` inyectado (sin import directo) |

### Post-merge checklist

1. `supabase secrets set OPENAI_API_KEY=sk-...`
2. Run migration `20260311_01` en SQL Editor
3. `supabase functions deploy server`
4. Re-embed chunks: `POST /ai/ingest-embeddings { institution_id, target: "chunks" }`
5. Re-embed summaries: `POST /ai/ingest-embeddings { institution_id, target: "summaries" }`
6. Verificar RAG chat E2E

---

## Arquitectura actual de providers

| Funcion | Provider | Modelo | API Key |
|---|---|---|---|
| Generacion de texto | Gemini | `gemini-2.5-flash` | `GEMINI_API_KEY` |
| Embeddings (vectores) | OpenAI | `text-embedding-3-large` (1536d) | `OPENAI_API_KEY` |
| Extraccion PDF | Gemini | `gemini-2.5-flash` (multimodal) | `GEMINI_API_KEY` |
| Re-ranking | Gemini | `gemini-2.5-flash` (JSON scores) | `GEMINI_API_KEY` |
| Multi-Query reformulations | Gemini | `gemini-2.5-flash` | `GEMINI_API_KEY` |
| HyDE hypothesis | Gemini | `gemini-2.5-flash` | `GEMINI_API_KEY` |

> **Migracion futura a Claude:** Cuando se decida migrar la generacion a Claude (Anthropic),
> solo se necesita crear un `claude.ts` con `generateText()` compatible y actualizar imports
> en los archivos que usan generacion. Los embeddings (OpenAI) NO se tocan.

---

## Migrations aplicadas (completas)

| Migration | Descripcion | Fase | Estado |
|---|---|---|---|
| `20260303_02` | Rate limit entries | INC-3 | APPLIED |
| `20260304_05` | RPC `get_institution_summary_ids` | INC-5 | APPLIED |
| `20260304_06` | Denorm `institution_id` + trigger | Fase 1 | APPLIED |
| `20260305_03` | HNSW index `idx_chunks_embedding` | LA-04 | APPLIED |
| `20260305_04` | `rag_query_log` + RLS + indexes | Fase 4 | APPLIED |
| `20260306_03` | tsvector columns + GIN indexes | Fase 2 | APPLIED |
| `20260307_02` | `chunk_strategy` + `last_chunked_at` | Fase 5 | APPLIED |
| `20260307_03` | `summaries.embedding` + HNSW + c2f RPC | Fase 3 | APPLIED |
| `20260308_01` | RPC `get_smart_generate_target` | Fase 8A | APPLIED |
| `20260308_02` | `ai_content_reports` + RLS | Fase 8B | APPLIED |
| `20260308_03` | RPC `get_ai_report_stats` | Fase 8C | APPLIED |
| `20260309_01` | `retrieval_strategy` + `rerank_applied` cols | Fase 6 | APPLIED |
| `20260311_01` | OpenAI 1536d: ALTER columns + RPCs + HNSW | D57-D63 | **PENDING** |

---

## Migracion de dimensiones: checklist completa -- DONE (D57)

1. `EMBEDDING_DIMENSIONS` en `gemini.ts` -- **DONE** (1536)
2. `ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(1536)` -- **DONE** (migration `20260311_01`)
3. `ALTER TABLE summaries ALTER COLUMN embedding TYPE vector(1536)` -- **DONE** (migration `20260311_01`)
4. Function signature: `p_query_embedding vector(1536)` en `rag_hybrid_search()` -- **DONE** (migration `20260311_01`)
5. Function signature: `p_query_embedding vector(1536)` en `rag_coarse_to_fine_search()` -- **DONE** (migration `20260311_01`)
6. Re-ingest ALL chunks y summaries -- **PENDING** (post-deploy)
7. Recrear indices HNSW -- **DONE** (migration `20260311_01`)

---

## Orden de implementacion (completado)

```
Fase 1: Denormalizar institution_id   [DONE]   [T-01, PR #24]   [migration aplicada]
  |
Fase 2: Columnas tsvector + GIN      [DONE]   [T-02, PR #25]   [migration aplicada]
  |
Fase 4: Query log + feedback          [DONE]   [T-03, PR #27]   [migration aplicada]
  |
Fase 5: Chunking + auto-ingest        [DONE]   [Issue #30]      [recursive + semantic]
  |
Fase 3: Embeddings en summaries       [DONE]   [Fase 3 branch]  [coarse-to-fine search]
  |
Fase 8: IA adaptativa                 [DONE]   [feat/fase8]     [NeedScore + pre-gen + calidad]
  |
Fase 6: Retrieval avanzado            [DONE]   [feat/fase6]     [Multi-Query + HyDE + re-rank]
  |
Fase 7: Ingestion PDF                 [DONE]   [E2E validated]  [Gemini multimodal]
  |
D57-63: OpenAI embeddings 1536d      [DONE]   [PR #43]         [migration pending deploy]
```

**Total: 8/8 fases + 1 migracion completadas. 32/32 features operacionales.**

---

## Changelog

| Version | Fecha | Cambios |
|---|---|---|
| v14 | 2026-03-11 | Migracion embeddings Gemini 768d -> OpenAI text-embedding-3-large 1536d. Decisiones D56-D63. PR #43. Migration `20260311_01`. |
| v13 | 2026-03-09 | 31/31 completados. Pipeline RAG validado E2E. Todas las migrations aplicadas. Decisiones D51-D55 documentadas. Limitaciones conocidas documentadas. |
| v12 | 2026-03-09 | Fase 6 Retrieval Avanzado completada. Decisiones D19-D30. |
| v11 | 2026-03-08 | Fase 8 IA Adaptativa completada. 4 pares, 8 sub-tasks. |
| v10 | 2026-03-07 | Fase 3 coarse-to-fine search. Decisions D1-D7. |
| v9 | 2026-03-07 | Fase 5 chunking + auto-ingest. Issue #30. |
| v8 | 2026-03-06 | T-03 query log + feedback loop. PR #27. |
| v7 | 2026-03-05 | T-01 denorm + T-02 tsvector. PRs #24, #25. |
| v6 | 2026-03-04 | Quick fixes INC-1/3/6 aplicados. |
| v5 | 2026-03-04 | Cross-audit con codigo fuente real. |
| v4 | 2026-03-03 | Appendix A con helper functions. |
| v3 | 2026-03-03 | 3 errores corregidos, 12 gaps integrados. |
