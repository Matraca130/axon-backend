# Vertex AI / Google Cloud Migration Plan

> **Fecha**: 2026-03-10  
> **Estado**: PLANIFICACION  
> **Autor**: Audit Wave 9 (Claude)  
> **Scope**: Migrar generacion de texto (Gemini) y opcionalmente embeddings (OpenAI) a Google Cloud Vertex AI

---

## Tabla de Contenidos

1. [Estado Actual — Inventario Completo de Integraciones AI](#1-estado-actual)
2. [Por Que Migrar a Vertex AI](#2-por-que-migrar)
3. [Decisiones Arquitecturales](#3-decisiones-arquitecturales)
4. [Fase 1 — Setup de GCP](#fase-1)
5. [Fase 2 — Capa de Autenticacion](#fase-2)
6. [Fase 3 — Migracion de Generacion de Texto](#fase-3)
7. [Fase 4 — Decision de Embeddings](#fase-4)
8. [Fase 5 — Migracion de WhatsApp Handler](#fase-5)
9. [Fase 6 — Testing, Feature Flags y Rollback](#fase-6)
10. [Checklist Final Pre-Produccion](#checklist)
11. [Riesgos y Mitigaciones](#riesgos)
12. [Estimacion de Esfuerzo](#estimacion)

---

<a id="1-estado-actual"></a>
## 1. Estado Actual — Inventario Completo de Integraciones AI

### 1.1 Archivos Core (los que hablan con APIs externas)

| # | Archivo | API | Funcion | Endpoint |
|---|---------|-----|---------|----------|
| 1 | `server/gemini.ts` | Gemini | `generateText()` | `generativelanguage.googleapis.com/v1beta` |
| 2 | `server/gemini.ts` | Gemini | `extractTextFromPdf()` | mismo endpoint (multimodal) |
| 3 | `server/gemini.ts` | Gemini | `fetchWithRetry()` | helper HTTP con retry |
| 4 | `server/gemini.ts` | Gemini | `getApiKey()` | lee `GEMINI_API_KEY` de env |
| 5 | `server/openai-embeddings.ts` | OpenAI | `generateEmbedding()` | `api.openai.com/v1/embeddings` |

### 1.2 Archivos Consumidores (importan de los core)

| # | Archivo | Importa de `gemini.ts` | Importa de `openai-embeddings.ts` | Uso |
|---|---------|----------------------|----------------------------------|-----|
| 6 | `routes/ai/generate.ts` | `generateText`, `parseGeminiJson`, `GENERATE_MODEL` | — | Genera 1 flashcard/quiz (manual) |
| 7 | `routes/ai/generate-smart.ts` | `generateText`, `parseGeminiJson`, `GENERATE_MODEL` | — | Genera 1-10 items (adaptativo BKT) |
| 8 | `routes/ai/pre-generate.ts` | `generateText`, `parseGeminiJson`, `GENERATE_MODEL` | — | Bulk pre-gen para profesores |
| 9 | `routes/ai/chat.ts` | `generateText` | — (via retrieval-strategies) | RAG chat con contexto |
| 10 | `routes/ai/ingest-pdf.ts` | `extractTextFromPdf` | — (via auto-ingest) | PDF upload + extraction |
| 11 | `routes/whatsapp/handler.ts` | `getApiKey`, `GENERATE_MODEL`, `fetchWithRetry` | — | Bot WhatsApp (llamadas directas!) |
| 12 | `server/retrieval-strategies.ts` | `generateText`, `parseGeminiJson` | `generateEmbedding` | Multi-Query, HyDE, Re-ranking |
| 13 | `server/auto-ingest.ts` | — | `generateEmbedding` | Pipeline chunk + embed |
| 14 | `server/semantic-chunker.ts` | — | — (recibe `embedFn` inyectado) | Chunking semantico |
| 15 | `routes/ai/ingest.ts` | — | `generateEmbedding` | Batch embedding manual |

### 1.3 Variables de Entorno Actuales

```
GEMINI_API_KEY    → API key para generativelanguage.googleapis.com
OPENAI_API_KEY    → API key para api.openai.com
```

### 1.4 URLs Actuales

```
Gemini Text:  https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={API_KEY}
Gemini PDF:   mismo endpoint con inline_data (multimodal)
OpenAI Embed: https://api.openai.com/v1/embeddings
```

### 1.5 Modelos Actuales

| Proposito | Modelo | Dimensiones | Costo aprox |
|-----------|--------|-------------|-------------|
| Generacion de texto | `gemini-2.5-flash` | N/A | Gratis (Google AI Studio) |
| Extraccion PDF | `gemini-2.5-flash` (multimodal) | N/A | Gratis |
| Embeddings | `text-embedding-3-large` (OpenAI) | 1536d (truncado) | $0.13/M tokens |

### 1.6 Diagrama de Dependencias

```
                    +-----------------+
                    |   gemini.ts     |
                    |  (text gen)     |
                    +--------+--------+
                             |
            +----------------+----------------+-------------------+
            |                |                |                   |
     generate.ts    generate-smart.ts   chat.ts          handler.ts (WA)
     pre-generate.ts   ingest-pdf.ts   retrieval-strategies.ts
                                              |
                                    +---------+---------+
                                    |                   |
                                    |  openai-embeddings.ts
                                    |   (embeddings)    |
                                    +---------+---------+
                                              |
                              +---------------+---------------+
                              |               |               |
                       auto-ingest.ts  retrieval-strat.ts  ingest.ts
                              |
                    semantic-chunker.ts
                    (recibe embedFn)
```

---

<a id="2-por-que-migrar"></a>
## 2. Por Que Migrar a Vertex AI

### Ventajas

| Aspecto | Google AI Studio (actual) | Vertex AI (propuesto) |
|---------|--------------------------|----------------------|
| **Autenticacion** | API Key en URL (riesgo si se filtra) | Service Account + OAuth2 (IAM) |
| **Rate Limits** | 15 RPM free tier | Configurable, mucho mas alto |
| **SLA** | Sin SLA | 99.9% SLA |
| **Region** | Automatica (Google elige) | Tu eliges (ej: us-central1) |
| **Logging** | Ninguno | Cloud Logging + Monitoring |
| **Billing** | Free tier, luego pay-as-you-go | Pay-as-you-go con alertas |
| **VPC** | Internet publico | VPC Service Controls opcional |
| **Compliance** | Basico | SOC 2, HIPAA, ISO 27001 |
| **Modelos** | Solo Gemini | Gemini + Claude + Llama + custom |

### Desventajas

| Aspecto | Impacto |
|---------|--------|
| Complejidad de auth | Media — necesitas JWT signing en Deno |
| Costo | Vertex AI cobra desde el primer request |
| Setup inicial | Proyecto GCP + Service Account + IAM |

---

<a id="3-decisiones-arquitecturales"></a>
## 3. Decisiones Arquitecturales

### D-CLOUD-01: Solo migrar generacion de texto (Gemini) inicialmente
**Embeddings se quedan en OpenAI** hasta que haya una razon fuerte para cambiar.
- Cambiar modelo de embeddings = re-embeber TODOS los chunks y summaries
- Cambiar dimensiones = ALTER TABLE + recrear indexes HNSW
- Riesgo altisimo para beneficio marginal

### D-CLOUD-02: Wrapper pattern — NO cambiar interfaz publica
`gemini.ts` sigue exportando las mismas funciones (`generateText`, `extractTextFromPdf`, etc.).
Solo cambia la implementacion interna (URL + auth).

### D-CLOUD-03: Feature flag `USE_VERTEX_AI`
Si `USE_VERTEX_AI=true` en env → usa Vertex AI endpoint.
Si no → sigue usando Google AI Studio (actual).
Permite rollback instantaneo.

### D-CLOUD-04: Auth via Service Account JSON key
En Deno (Supabase Edge Functions), no hay `google-auth-library`.
Usamos firma JWT manual con la clave privada del Service Account.

---

<a id="fase-1"></a>
## Fase 1 — Setup de GCP

### 1.1 Crear o seleccionar proyecto GCP

```bash
# Si no tienes proyecto
gcloud projects create axon-ai-prod --name="Axon AI Production"
gcloud config set project axon-ai-prod
```

### 1.2 Habilitar Vertex AI API

```bash
gcloud services enable aiplatform.googleapis.com
```

### 1.3 Crear Service Account

```bash
# Crear service account
gcloud iam service-accounts create axon-vertex-ai \
  --display-name="Axon Vertex AI" \
  --description="Service account for Axon backend AI calls"

# Asignar rol
gcloud projects add-iam-policy-binding axon-ai-prod \
  --member="serviceAccount:axon-vertex-ai@axon-ai-prod.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```

### 1.4 Generar JSON key

```bash
gcloud iam service-accounts keys create vertex-ai-key.json \
  --iam-account=axon-vertex-ai@axon-ai-prod.iam.gserviceaccount.com
```

### 1.5 Guardar como Supabase Secret

```bash
# El JSON key completo como un solo secret
supabase secrets set GCP_SERVICE_ACCOUNT_KEY="$(cat vertex-ai-key.json)"
supabase secrets set GCP_PROJECT_ID="axon-ai-prod"
supabase secrets set GCP_REGION="us-central1"
supabase secrets set USE_VERTEX_AI="true"
```

### 1.6 Habilitar billing

Vertex AI requiere billing habilitado. Configurar:
- Budget alert a $50/mes (empezar conservador)
- Notificaciones al 50%, 80%, 100%

```bash
# En GCP Console: Billing > Budgets & alerts > Create budget
# O via gcloud:
gcloud billing budgets create \
  --billing-account=BILLING_ACCOUNT_ID \
  --display-name="Axon AI Budget" \
  --budget-amount=50USD \
  --threshold-rule=percent=50 \
  --threshold-rule=percent=80 \
  --threshold-rule=percent=100
```

---

<a id="fase-2"></a>
## Fase 2 — Capa de Autenticacion

### 2.1 El Problema

Vertex AI no usa API keys. Usa OAuth2 access tokens obtenidos via Service Account.
En Deno (Supabase Edge Functions), `google-auth-library` NO esta disponible.
Necesitamos firmar JWTs manualmente.

### 2.2 Crear `vertex-auth.ts`

Nuevo archivo: `supabase/functions/server/vertex-auth.ts`

```typescript
/**
 * vertex-auth.ts — GCP Service Account auth for Deno
 *
 * Signs a JWT with the service account's private key,
 * exchanges it for an OAuth2 access token via Google's token endpoint.
 * Caches the token until 5 minutes before expiry.
 */

import { encode as base64url } from "https://deno.land/std@0.208.0/encoding/base64url.ts";

interface ServiceAccountKey {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let cachedToken: CachedToken | null = null;

function getServiceAccountKey(): ServiceAccountKey {
  const raw = Deno.env.get("GCP_SERVICE_ACCOUNT_KEY");
  if (!raw) throw new Error("[Axon Fatal] GCP_SERVICE_ACCOUNT_KEY not configured");
  return JSON.parse(raw) as ServiceAccountKey;
}

export function getProjectId(): string {
  const projectId = Deno.env.get("GCP_PROJECT_ID");
  if (!projectId) {
    // Fallback: read from service account key
    return getServiceAccountKey().project_id;
  }
  return projectId;
}

export function getRegion(): string {
  return Deno.env.get("GCP_REGION") || "us-central1";
}

async function signJwt(
  header: Record<string, string>,
  payload: Record<string, unknown>,
  privateKeyPem: string,
): Promise<string> {
  // Import PEM private key
  const pemBody = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\n/g, "");

  const keyData = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  // Build JWT
  const headerB64 = base64url(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );

  const signatureB64 = base64url(new Uint8Array(signature));
  return `${signingInput}.${signatureB64}`;
}

export async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (5 min buffer)
  if (cachedToken && cachedToken.expiresAt > Date.now() + 300_000) {
    return cachedToken.accessToken;
  }

  const sa = getServiceAccountKey();
  const now = Math.floor(Date.now() / 1000);

  const jwt = await signJwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: sa.client_email,
      sub: sa.client_email,
      aud: sa.token_uri,
      iat: now,
      exp: now + 3600, // 1 hour
      scope: "https://www.googleapis.com/auth/cloud-platform",
    },
    sa.private_key,
  );

  // Exchange JWT for access token
  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`GCP token exchange failed (${res.status}): ${errBody}`);
  }

  const data = await res.json();
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
  };

  return cachedToken.accessToken;
}
```

---

<a id="fase-3"></a>
## Fase 3 — Migracion de Generacion de Texto

### 3.1 Cambios en `gemini.ts`

El archivo `gemini.ts` es el UNICO que necesita cambiar para migrar la generacion de texto.
Todos los consumidores importan de aca — el wrapper pattern (D-CLOUD-02) hace que el cambio sea transparente.

#### Antes (actual):
```typescript
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function getApiKey(): string {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("[Axon Fatal] GEMINI_API_KEY not configured");
  return key;
}

// En generateText():
const url = `${GEMINI_BASE}/${model}:generateContent?key=${key}`;
```

#### Despues (Vertex AI):
```typescript
import { getAccessToken, getProjectId, getRegion } from "./vertex-auth.ts";

const USE_VERTEX = Deno.env.get("USE_VERTEX_AI") === "true";

// Google AI Studio (legacy)
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Vertex AI
function getVertexBase(): string {
  const region = getRegion();
  const project = getProjectId();
  return `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/google/models`;
}

// En generateText():
async function buildRequest(model: string, body: Record<string, unknown>) {
  if (USE_VERTEX) {
    const token = await getAccessToken();
    const url = `${getVertexBase()}/${model}:generateContent`;
    return {
      url,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body,
    };
  } else {
    const key = getApiKey();
    const url = `${GEMINI_BASE}/${model}:generateContent?key=${key}`;
    return {
      url,
      headers: { "Content-Type": "application/json" },
      body,
    };
  }
}
```

### 3.2 Diferencias de Request Format

Google AI Studio y Vertex AI usan el **mismo formato de request/response** para Gemini.
La unica diferencia es la URL y la autenticacion.

```
// Google AI Studio:
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=API_KEY

// Vertex AI:
POST https://us-central1-aiplatform.googleapis.com/v1/projects/PROJECT/locations/REGION/publishers/google/models/gemini-2.5-flash:generateContent
Authorization: Bearer ACCESS_TOKEN
```

El body JSON es IDENTICO. No hay que cambiar ningun prompt ni formato.

### 3.3 Archivos Afectados

| Archivo | Cambio necesario |
|---------|------------------|
| `gemini.ts` | Refactor `generateText()` y `extractTextFromPdf()` para usar `buildRequest()` |
| `vertex-auth.ts` | NUEVO — auth helper |
| Todos los demas | **CERO cambios** (importan de gemini.ts) |

### 3.4 Excepcion: `handler.ts` (WhatsApp)

Ver [Fase 5](#fase-5) — este archivo construye URLs directamente.

---

<a id="fase-4"></a>
## Fase 4 — Decision de Embeddings

### 4.1 Opcion A: Mantener OpenAI Embeddings (RECOMENDADO)

| Pro | Contra |
|-----|--------|
| Zero cambios | Dependencia en 2 proveedores (GCP + OpenAI) |
| Sin re-embedding | Costo de OpenAI ($0.13/M tokens) |
| Sin migracion de pgvector | |
| Sin downtime | |

**Esfuerzo: 0 horas.**

### 4.2 Opcion B: Migrar a Vertex AI Embeddings

| Pro | Contra |
|-----|--------|
| Un solo proveedor (GCP) | Re-embeber TODOS los chunks (~6hrs proceso) |
| Potencialmente mas barato | ALTER TABLE vector(1536) → vector(768) |
| Misma factura GCP | Recrear HNSW indexes (downtime ~10min) |
| | Actualizar 5+ RPCs de pgvector |
| | Riesgo de degradacion de calidad de busqueda |

Modelos disponibles en Vertex AI:
- `text-embedding-005` (768d, EN)
- `text-multilingual-embedding-002` (768d, multilingue)

**Esfuerzo: ~20 horas + downtime.**

#### Si eliges Opcion B, los pasos serian:

1. Crear nueva migration SQL:
```sql
-- Cambiar columnas de embedding
ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(768);
ALTER TABLE summaries ALTER COLUMN embedding TYPE vector(768);

-- Recrear HNSW indexes
DROP INDEX IF EXISTS idx_chunks_embedding_hnsw;
DROP INDEX IF EXISTS idx_summaries_embedding_hnsw;
CREATE INDEX idx_chunks_embedding_hnsw ON chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX idx_summaries_embedding_hnsw ON summaries
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
```

2. Actualizar `openai-embeddings.ts` → `vertex-embeddings.ts`:
```typescript
export const EMBEDDING_MODEL = "text-multilingual-embedding-002";
export const EMBEDDING_DIMENSIONS = 768;
```

3. Re-embeber todo el contenido existente:
```typescript
// Script one-shot (NO en produccion)
const { data: chunks } = await adminDb.from("chunks").select("id, content");
for (const chunk of chunks) {
  const embedding = await generateEmbedding(chunk.content); // nuevo modelo
  await adminDb.from("chunks").update({ embedding: JSON.stringify(embedding) }).eq("id", chunk.id);
}
```

4. Actualizar RPCs: `rag_hybrid_search`, `rag_coarse_to_fine_search`

### 4.3 Recomendacion

**Opcion A (mantener OpenAI) para el lanzamiento.**
Migrar embeddings despues de validar que Vertex AI funciona bien para generacion de texto.

---

<a id="fase-5"></a>
## Fase 5 — Migracion de WhatsApp Handler

### 5.1 El Problema

`handler.ts` es el UNICO archivo que NO usa `gemini.ts` para sus llamadas.
Construye URLs directamente:

```typescript
// handler.ts linea 3:
import { getApiKey, GENERATE_MODEL, fetchWithRetry } from "../../gemini.ts";

// En callGemini() y transcribeVoiceMessage():
const apiKey = getApiKey();
const url = `${GEMINI_BASE}/${GENERATE_MODEL}:generateContent?key=${apiKey}`;
```

Esto NO es compatible con Vertex AI (que usa Bearer token, no API key en URL).

### 5.2 Solucion

Crear una funcion `buildGeminiUrl()` exportada desde `gemini.ts`:

```typescript
// Agregar a gemini.ts:
export async function buildGeminiRequest(
  model: string,
): Promise<{ url: string; authHeaders: Record<string, string> }> {
  if (USE_VERTEX) {
    const token = await getAccessToken();
    return {
      url: `${getVertexBase()}/${model}:generateContent`,
      authHeaders: { "Authorization": `Bearer ${token}` },
    };
  }
  const key = getApiKey();
  return {
    url: `${GEMINI_BASE}/${model}:generateContent?key=${key}`,
    authHeaders: {},
  };
}
```

Y en `handler.ts`, cambiar:

```typescript
// ANTES:
const apiKey = getApiKey();
const url = `${GEMINI_BASE}/${GENERATE_MODEL}:generateContent?key=${apiKey}`;
const res = await fetchWithRetry(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}, timeout, retries);

// DESPUES:
import { buildGeminiRequest, GENERATE_MODEL, fetchWithRetry } from "../../gemini.ts";

const { url, authHeaders } = await buildGeminiRequest(GENERATE_MODEL);
const res = await fetchWithRetry(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...authHeaders },
  body: JSON.stringify(body),
}, timeout, retries);
```

### 5.3 Archivos a Modificar

| Archivo | Cambio |
|---------|--------|
| `gemini.ts` | Exportar `buildGeminiRequest()` |
| `handler.ts` | Usar `buildGeminiRequest()` en `callGemini()` y `transcribeVoiceMessage()` |

---

<a id="fase-6"></a>
## Fase 6 — Testing, Feature Flags y Rollback

### 6.1 Feature Flag

```bash
# Activar Vertex AI:
supabase secrets set USE_VERTEX_AI=true

# Rollback instantaneo:
supabase secrets set USE_VERTEX_AI=false
# (no requiere deploy, las Edge Functions leen env en cada request)
```

### 6.2 Plan de Testing

| Test | Comando / Accion | Resultado Esperado |
|------|-------------------|--------------------|
| Health check | `GET /api/v1/health` | `{ services: { gemini: true, openai: true, vertex: true } }` |
| Generate flashcard | `POST /ai/generate` con action=flashcard | 201 con flashcard generada |
| Generate quiz | `POST /ai/generate` con action=quiz_question | 201 con pregunta |
| RAG chat | `POST /ai/rag-chat` con message | 200 con response + sources |
| PDF extraction | `POST /ai/ingest-pdf` con PDF | 200 con summary creada |
| WhatsApp text | Enviar mensaje de texto al bot | Respuesta del tutor |
| WhatsApp voice | Enviar audio al bot | Transcripcion + respuesta |
| Smart generate | `POST /ai/generate-smart` con action=flashcard | 201 con _smart metadata |
| Pre-generate | `POST /ai/pre-generate` con summary_id | 201 con items generados |
| Embeddings (sin cambio) | `POST /ai/ingest-embeddings` | Embeddings generados correctamente |

### 6.3 Monitoreo Post-Migracion

```sql
-- Query para verificar latencia post-migracion
SELECT
  date_trunc('hour', created_at) AS hour,
  AVG(latency_ms) AS avg_latency,
  MAX(latency_ms) AS max_latency,
  COUNT(*) AS requests
FROM rag_query_log
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY hour
ORDER BY hour DESC;
```

### 6.4 Rollback Plan

1. **Instantaneo**: `supabase secrets set USE_VERTEX_AI=false`
2. **Si hay tokens cacheados invalidos**: Esperar 5 minutos (cache TTL)
3. **Si Vertex AI esta down**: El flag automaticamente redirige a Google AI Studio
4. **Datos**: Cero migracion de datos necesaria (solo cambia el proveedor de API)

---

<a id="checklist"></a>
## Checklist Final Pre-Produccion

- [ ] **GCP**: Proyecto creado y billing habilitado
- [ ] **GCP**: Vertex AI API habilitada
- [ ] **GCP**: Service Account creado con `roles/aiplatform.user`
- [ ] **GCP**: JSON key generado y almacenado de forma segura
- [ ] **GCP**: Budget alert configurado ($50/mes inicial)
- [ ] **Supabase**: `GCP_SERVICE_ACCOUNT_KEY` guardado como secret
- [ ] **Supabase**: `GCP_PROJECT_ID` guardado como secret
- [ ] **Supabase**: `GCP_REGION` guardado como secret
- [ ] **Codigo**: `vertex-auth.ts` creado y testeado
- [ ] **Codigo**: `gemini.ts` refactored con `buildRequest()` y feature flag
- [ ] **Codigo**: `handler.ts` actualizado para usar `buildGeminiRequest()`
- [ ] **Codigo**: Health check actualizado para reportar status de Vertex AI
- [ ] **Testing**: Todos los 10 tests de la tabla 6.2 pasando
- [ ] **Testing**: Latencia promedio <= 2x de la actual
- [ ] **Monitoring**: Query de monitoreo configurado
- [ ] **Deploy**: Feature flag `USE_VERTEX_AI=false` (desactivado)
- [ ] **Deploy**: Deploy del codigo
- [ ] **Deploy**: Activar flag `USE_VERTEX_AI=true`
- [ ] **Deploy**: Monitorear 1 hora
- [ ] **Post-deploy**: Verificar facturacion GCP despues de 24h

---

<a id="riesgos"></a>
## Riesgos y Mitigaciones

| # | Riesgo | Probabilidad | Impacto | Mitigacion |
|---|--------|-------------|---------|------------|
| R1 | JWT signing falla en Deno | Media | Alto | Test exhaustivo de `vertex-auth.ts` con diferentes key formats |
| R2 | Token cache corruption | Baja | Medio | Cache con TTL de 55 min (token dura 60), fallback a re-fetch |
| R3 | Vertex AI mas lento que AI Studio | Media | Bajo | Monitorear latencia, rollback si >2x |
| R4 | Cambio de formato de respuesta | Muy baja | Alto | Vertex AI usa mismo formato que AI Studio para Gemini |
| R5 | Costo inesperado | Media | Medio | Budget alert + dashboard de uso diario |
| R6 | Service Account key expira | Baja | Alto | Alertas en GCP, rotacion cada 90 dias |
| R7 | `handler.ts` tiene 2 call sites | Baja | Medio | Ambos (`callGemini` + `transcribeVoice`) migrados en misma PR |

---

<a id="estimacion"></a>
## Estimacion de Esfuerzo

| Fase | Tarea | Horas estimadas |
|------|-------|-----------------|
| 1 | Setup GCP (proyecto, SA, billing) | 2h |
| 2 | `vertex-auth.ts` (JWT signing + token cache) | 4h |
| 3 | Refactor `gemini.ts` (buildRequest + flag) | 3h |
| 5 | Refactor `handler.ts` (2 call sites) | 2h |
| 6 | Testing completo (10 tests) | 3h |
| 6 | Deploy + monitoreo | 2h |
| **Total (sin embeddings)** | | **~16h** |
| 4B | Migracion de embeddings (opcional) | +20h |

---

## Bonus: TERCERA copia de `truncateAtWord` descubierta

Durante esta auditoria se descubrio que `pre-generate.ts` (linea 74) y `generate.ts` (linea 42) TAMBIEN tienen copias locales de `truncateAtWord()`. Son la 3ra y 4ta copia respectivamente.

| Archivo | Tipo |
|---------|------|
| `auto-ingest.ts` | **Canonico** (exported) |
| `generate-smart.ts` | Corregido en PR #61 (ahora importa de auto-ingest) |
| `pre-generate.ts` | **PENDIENTE** — copia local |
| `generate.ts` | **PENDIENTE** — copia local |

Recomendacion: crear PR `fix/dedup-truncateAtWord-remaining` que limpie las 2 copias restantes.

---

> **Siguiente paso**: Resolver [HIDE-01](./HIDDEN_RISKS.md) (FK verification) y mergear PR #57 y #58 ANTES de empezar esta migracion. La migracion a Vertex AI debe hacerse sobre una base de codigo limpia y estable.
