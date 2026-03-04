## AI / RAG — Endpoints, Payloads y Pipeline

> **Pending features:** For chunking strategies, retrieval improvements (Multi-Query,
> HyDE, Re-ranking), adaptive IA enhancements, and PDF ingestion, see
> [RAG_ROADMAP.md](../RAG_ROADMAP.md).

### Modelos

| Funcion | Modelo | Dims | Constante en codigo |
|---------|--------|------|---------------------|
| Generacion (flashcards, quiz) | `gemini-2.5-flash` | — | `GENERATE_MODEL` en `gemini.ts` |
| Embeddings | `gemini-embedding-001` | 3072 -> truncado a 768 via `outputDimensionality` | hardcoded en `generateEmbedding()` |
| RAG Chat (respuesta) | `gemini-2.5-flash` | — | usa `generateText()` internamente |

> Para cambiar el modelo de generacion, edita SOLO `GENERATE_MODEL` en `gemini.ts`. Todos los endpoints lo importan de ahi (single source of truth, fix D-18).

### Archivos del modulo AI

```
supabase/functions/server/
├─ gemini.ts                    ← Helpers: generateText(), generateEmbedding(), parseGeminiJson(), GENERATE_MODEL
└─ routes/ai/
   ├─ index.ts                  ← Combiner: monta los 4 sub-modulos
   ├─ generate.ts               ← POST /ai/generate (flashcards + quiz)
   ├─ ingest.ts                 ← POST /ai/ingest-embeddings (batch embeddings)
   ├─ chat.ts                   ← POST /ai/rag-chat (busqueda semantica + respuesta)
   └─ list-models.ts            ← GET  /ai/list-models (diagnostico)
```

### Endpoints AI

---

#### POST `/server/ai/ingest-embeddings`

Genera embeddings para chunks que aun no tienen vector. Paso previo obligatorio para que RAG Chat funcione.

**Body:**
```json
{
  "institution_id": "UUID (requerido)",
  "summary_id": "UUID (opcional — scope a un summary)",
  "batch_size": 50
}
```

**Respuesta exitosa:**
```json
{
  "data": {
    "processed": 12,
    "failed": 0,
    "total_found": 12,
    "errors": []
  }
}
```

**Notas:**
- `batch_size` max 100, default 50
- Requiere rol `professor` u `owner` (CONTENT_WRITE_ROLES)
- Rate-limited: pausa 1s cada 10 embeddings
- Si no hay chunks sin embedding: `{ "data": { "processed": 0, "message": "No chunks without embeddings found" } }`

---

#### POST `/server/ai/generate`

Genera una flashcard o quiz question adaptativa usando Gemini + contexto del alumno.

**Body:**
```json
{
  "action": "flashcard",
  "summary_id": "UUID (requerido)",
  "keyword_id": "UUID (opcional — se resuelve automaticamente del summary)",
  "subtopic_id": "UUID (opcional)",
  "block_id": "UUID (opcional — scope a un summary_block)",
  "wrong_answer": "string (opcional — para retry-on-error)",
  "related": true
}
```

| Campo | Tipo | Requerido | Notas |
|-------|------|-----------|-------|
| `action` | `"flashcard"` o `"quiz_question"` | SI | |
| `summary_id` | UUID | SI | Determina el contenido base |
| `keyword_id` | UUID | NO | Si falta, usa el primer keyword del summary |
| `subtopic_id` | UUID | NO | Agrega contexto BKT del alumno |
| `block_id` | UUID | NO | Scope a un bloque especifico del summary |
| `wrong_answer` | string | NO | Para regenerar despues de error del alumno |
| `related` | boolean | NO | Default true. false = flashcard general del summary |

**Respuesta flashcard:**
```json
{
  "data": {
    "id": "UUID",
    "keyword_id": "UUID",
    "summary_id": "UUID",
    "front": "Que significa que un tema es 'general'?",
    "back": "Se refiere a que abarca una vision amplia y fundamental...",
    "source": "ai",
    "created_by": "UUID",
    "_meta": {
      "model": "gemini-2.5-flash",
      "tokens": { "input": 135, "output": 46 },
      "related": true
    }
  }
}
```

**Respuesta quiz_question:**
```json
{
  "data": {
    "id": "UUID",
    "question_type": "multiple_choice",
    "question": "Cual es la funcion principal de...?",
    "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
    "correct_answer": "A",
    "explanation": "Porque...",
    "difficulty": "medium",
    "source": "ai",
    "_meta": {
      "model": "gemini-2.5-flash",
      "tokens": { "input": 200, "output": 80 },
      "had_wrong_answer": false
    }
  }
}
```

**Errores comunes:**
- `"summary_id is required (UUID)"` — falta summary_id o no es UUID valido
- `"action must be 'quiz_question' or 'flashcard'"` — action invalido
- `"No keywords found for this summary"` — el summary no tiene keywords creados

---

#### POST `/server/ai/rag-chat`

Pregunta con busqueda semantica hibrida (pgvector cosine + full-text via `to_tsvector('spanish')` + `ts_rank()`) + generacion adaptativa.

**Body:**
```json
{
  "message": "Que temas se cubren en este curso?",
  "summary_id": "UUID (opcional — scope la busqueda a un summary)",
  "history": [
    { "role": "user", "content": "pregunta anterior" },
    { "role": "assistant", "content": "respuesta anterior" }
  ]
}
```

| Campo | Tipo | Requerido | Notas |
|-------|------|-----------|-------|
| `message` | string | SI | Max 2000 chars. NO usar `question` |
| `summary_id` | UUID | NO | Sin el, busca en toda la institucion |
| `history` | array | NO | Max 6 entries, cada content truncado a 500 chars |

**Respuesta:**
```json
{
  "data": {
    "response": "Segun el material...",
    "sources": [
      {
        "chunk_id": "UUID",
        "summary_title": "Introduccion a...",
        "similarity": 0.56
      }
    ],
    "tokens": { "input": 115, "output": 64 },
    "profile_used": true
  }
}
```

**Pipeline interno:**
1. Autentica usuario + resuelve institucion
2. Genera embedding del `message` con `generateEmbedding(message, "RETRIEVAL_QUERY")`
3. Llama RPC `rag_hybrid_search()` (pgvector cosine 70% + `ts_rank` FTS 30%, threshold 0.3, top 5)
4. Fetch perfil del alumno via `get_student_knowledge_context()` RPC
5. Construye prompt con contexto RAG + perfil + historial
6. Genera respuesta con `generateText()` (temp 0.5, max 1500 tokens)

---

#### GET `/server/ai/list-models`

Diagnostico: lista todos los modelos disponibles para la API key configurada.

**Body:** ninguno (GET)

**Respuesta:** lista de modelos con sus metodos soportados.

---

### Pipeline RAG Completo (flujo end-to-end)

```
1. Profesor crea Summary con content_markdown
2. Sistema chunka el contenido (tabla chunks)
3. POST /ai/ingest-embeddings → genera vector 768-dim para cada chunk
4. Alumno hace POST /ai/rag-chat con su pregunta
   4a. Se genera embedding de la pregunta (RETRIEVAL_QUERY)
   4b. rag_hybrid_search() busca chunks similares (cosine 70% + ts_rank FTS 30%)
   4c. get_student_knowledge_context() obtiene perfil adaptativo
   4d. Gemini genera respuesta contextualizada
5. POST /ai/generate → genera flashcard/quiz adaptado al nivel del alumno
   5a. Usa BKT state del subtema + perfil del alumno
   5b. Si wrong_answer presente, reformula el concepto
```

### RPCs de PostgreSQL usados por AI

| RPC | Que hace | Usado en |
|-----|----------|----------|
| `resolve_parent_institution(p_table, p_id)` | Sube la jerarquia hasta encontrar la institution_id | generate.ts, chat.ts |
| `rag_hybrid_search(p_query_embedding, p_query_text, p_institution_id, ...)` | Busqueda hibrida: pgvector cosine + `ts_rank` FTS | chat.ts |
| `get_student_knowledge_context(p_student_id, p_institution_id)` | Perfil adaptativo del alumno | generate.ts, chat.ts |
| `get_course_summary_ids(p_institution_id)` | Fallback: summary_ids de una institucion | ingest.ts |

### Ejemplo completo de integracion desde frontend

```typescript
// 1. Ingest embeddings (una vez, o cuando hay chunks nuevos)
await apiCall('/server/ai/ingest-embeddings', {
  method: 'POST',
  body: JSON.stringify({
    institution_id: 'cdf7c6bc-...',
    batch_size: 50
  })
});

// 2. Generar flashcard adaptativa
const flashcard = await apiCall('/server/ai/generate', {
  method: 'POST',
  body: JSON.stringify({
    action: 'flashcard',
    summary_id: '21febe7a-...'
  })
});

// 3. RAG Chat (pregunta con busqueda semantica)
const chat = await apiCall('/server/ai/rag-chat', {
  method: 'POST',
  body: JSON.stringify({
    message: 'Que temas se cubren en este curso?'
  })
});

// 4. RAG Chat con historial (conversacion)
const followUp = await apiCall('/server/ai/rag-chat', {
  method: 'POST',
  body: JSON.stringify({
    message: 'Puedes explicar el primer tema con mas detalle?',
    history: [
      { role: 'user', content: 'Que temas se cubren en este curso?' },
      { role: 'assistant', content: chat.response }
    ]
  })
});
```

### Errores frecuentes y como resolverlos

| Error | Causa | Solucion |
|-------|-------|----------|
| 429 Too Many Requests | Quota de Gemini agotada | Esperar ~37s (auto-retry con backoff en gemini.ts) |
| `"summary_id is required"` | Falta summary_id en generate | Agregar campo summary_id con UUID valido |
| `"message is required"` | Campo incorrecto en rag-chat | Usar `message`, NO `question` |
| `"No chunks without embeddings"` | Ya se procesaron todos | Normal — no es error |
| `"GEMINI_API_KEY not configured"` | Falta secret en Supabase | `supabase secrets set GEMINI_API_KEY=xxx` |
| Similarity baja (< 0.3) | Pocos chunks o contenido no relacionado | Ingest mas summaries o reformular pregunta |
