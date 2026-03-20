# Roadmap: Sistema Unificado de Clasificacion Semanal

> **Proyecto:** Axon Backend — Weekly Classification Report
> **Fecha:** 2026-03-20
> **Branch:** `claude/weekly-classification-real-data-PtWkE`
> **Estado:** IMPLEMENTADO

---

## Vision General

```
ANTES (fragmentado)                         DESPUES (unificado)
================================           ================================

  WhatsApp Bot                               Shared Data Collector
  +------------------+                       +-------------------------+
  | study_sessions   |                       | collectWeeklyData()     |
  | topic_progress   |---+                   | - study_sessions        |
  | generateText()   |   |                   | - daily_activities      |
  | emoji + markdown |   |                   | - student_stats         |
  +------------------+   |                   | - knowledge RPC         |
                         |  SIN              | - student_xp            |
  Telegram Bot           | PERSISTENCIA      +-----+-------+-----------+
  +------------------+   |                         |       |
  | study_sessions   |   |                    +----+  +----+----+
  | topic_progress   |---+                    |       |         |
  | generateText()   |                        v       v         v
  | plain text       |                    WhatsApp  Telegram  Frontend
  +------------------+                    (emoji)   (plain)   (full UI)
                                                              |
  Frontend                                                    v
  +------------------+                              +-------------------+
  | NO DATA          |                              | weekly_reports    |
  | solo UI mockup   |                              | (persistido BD)   |
  +------------------+                              +-------------------+
```

---

## Fase 0: Auditoria del Codebase [COMPLETADA]

> Verificacion cruzada de todas las tablas, RPCs, y patrones antes de escribir codigo.

| Item Verificado | Resultado | Impacto en Plan |
|---|---|---|
| `study_sessions` campos | `total_reviews`, `correct_reviews` existen | Sin cambio |
| `daily_activities` / `student_stats` | Tablas base Supabase (produccion) | Sin cambio |
| `topic_progress` | View base, usada por bots | Reemplazada por RPC |
| `mv_student_knowledge_profile` | Matview, nunca query directo | Usar RPC en su lugar |
| `get_student_knowledge_context()` | RPC usada en 5 archivos AI | Patron confirmado |
| `student_xp.xp_this_week` | Existe en gamification | Sin cambio |
| `institution_id` en bot payloads | NO EXISTE en ninguno | `institutionId` opcional |
| Prompts WhatsApp vs Telegram | Difieren (acentos, emojis) | No unificar prompts |
| `generateText()` signature | `{text, tokensUsed}` con fallback | Sin cambio |
| `selectModelForTask("report")` | Retorna `"opus"` | Opus + haiku fallback |
| AI rate limit middleware | 20/hr POST, GET excluido | Usar bucket default |

---

## Fase 1: Capa de Datos [COMPLETADA]

### 1.1 Migracion SQL — `weekly_reports`

**Archivo:** `supabase/migrations/20260320000001_weekly_reports.sql`

```
weekly_reports
+---------------------+------------------+
| Campo               | Tipo             |
+---------------------+------------------+
| id                  | UUID PK          |
| student_id          | UUID FK users    |
| institution_id      | UUID FK inst     |
| week_start          | DATE             |
| week_end            | DATE             |
|---------------------|------------------|
| total_sessions      | INTEGER          |  Datos
| total_reviews       | INTEGER          |  Crudos
| correct_reviews     | INTEGER          |  (snapshot)
| accuracy_percent    | NUMERIC(5,2)     |
| total_time_seconds  | INTEGER          |
| days_active         | INTEGER          |
| streak_at_report    | INTEGER          |
| xp_earned           | INTEGER          |
|---------------------|------------------|
| weak_topics         | JSONB            |  Clasificacion
| strong_topics       | JSONB            |  de Temas
| lapsing_cards       | JSONB            |
|---------------------|------------------|
| ai_summary          | TEXT             |  Analisis
| ai_strengths        | JSONB            |  IA
| ai_weaknesses       | JSONB            |
| ai_mastery_trend    | TEXT             |
| ai_recommended_focus| JSONB            |
| ai_model            | TEXT             |
| ai_tokens_used      | INTEGER          |
| ai_latency_ms       | INTEGER          |
|---------------------|------------------|
| created_at          | TIMESTAMPTZ      |
+---------------------+------------------+
UNIQUE(student_id, institution_id, week_start)
```

**Seguridad (RLS):**
- `SELECT` → solo propios (`student_id = auth.uid()`)
- `INSERT` → solo propios (`student_id = auth.uid()`)
- `ALL` → service_role (admin backend)

**Indexes:**
- `(student_id, created_at DESC)` — lectura rapida por alumno
- `(institution_id, week_start DESC)` — reportes institucionales futuros

---

### 1.2 Data Collector Compartido

**Archivo:** `supabase/functions/server/lib/weekly-data-collector.ts`

```
collectWeeklyData(db, studentId, institutionId?)
                    |
                    v
        +--- Promise.all ---+
        |                   |
  +-----+-----+   +--------+--------+   +-----------+
  | Q1         |   | Q2              |   | Q3        |
  | sessions   |   | daily_activities|   | stats     |
  | (7 dias)   |   | (7 dias)        |   | (streak)  |
  +-----+------+   +--------+--------+   +-----+-----+
        |                   |                   |
        +------- SIEMPRE ---+-------------------+
                            |
        +--- SI institutionId ---+
        |                        |
  +-----+------+    +----------+---------+
  | Q4 (RPC)   |    | Q5                 |
  | knowledge  |    | student_xp         |
  | context    |    | (xp_this_week)     |
  +-----+------+    +----------+---------+
        |                      |
        v                      v
  weakTopics              xpEarned
  strongTopics
  lapsingCards

        RETORNA: WeeklyRawData
```

**Decision clave:** `institutionId` es opcional.
- Bots (WhatsApp/Telegram) NO lo tienen en sus payloads
- El endpoint HTTP SI lo recibe del frontend
- Sin `institutionId` → queries 4 y 5 se omiten, devuelve arrays vacios

---

## Fase 2: API Endpoints [COMPLETADA]

### 2.1 GET `/ai/weekly-report`

```
Cliente                    Backend
  |                          |
  |  GET /ai/weekly-report   |
  |  ?institution_id=xxx     |
  |------------------------->|
  |                          | authenticate(c)
  |                          | requireInstitutionRole()
  |                          | SELECT FROM weekly_reports
  |                          |   WHERE week_start = lunes_actual
  |                          |
  |  { data: report }        |  (si existe)
  |<-------------------------|
  |  { data: null,           |  (si no existe)
  |    hint: "generate" }    |
  |<-------------------------|
```

**Historial:**
```
GET /ai/weekly-report?institution_id=xxx&history=true&limit=4

Response:
{
  data: {
    current: { weekStart: "2026-03-16", ... } | null,
    history: [
      { weekStart: "2026-03-09", ... },
      { weekStart: "2026-03-02", ... },
    ]
  }
}
```

### 2.2 POST `/ai/weekly-report`

```
Cliente                    Backend                     Claude API
  |                          |                            |
  |  POST /ai/weekly-report  |                            |
  |  { institutionId }       |                            |
  |------------------------->|                            |
  |                          | 1. authenticate()          |
  |                          | 2. requireInstitutionRole()|
  |                          | 3. CHECK: ya existe?       |
  |                          |    SI -> return existente   |
  |                          |    (idempotente)            |
  |                          |                            |
  |                          | 4. collectWeeklyData()     |
  |                          |    [5 queries paralelas]   |
  |                          |                            |
  |                          | 5. generateText() -------->|
  |                          |    model: opus             | Analisis
  |                          |    fallback: haiku         | semanal
  |                          |    temp: 0.4               |
  |                          |<---------------------------|
  |                          |                            |
  |                          | 6. INSERT weekly_reports   |
  |                          |    (admin client)          |
  |                          |                            |
  |  { data: report }  201   |                            |
  |<-------------------------|                            |
```

**Graceful degradation:** Si Claude falla, se persiste el reporte con datos crudos sin analisis IA (nunca se pierde data del alumno).

**Rate limit:** Usa el middleware default de AI (20 req/hora por usuario). GET no pasa por middleware.

---

## Fase 3: Refactor de Bots [COMPLETADA]

### Antes vs Despues

```
ANTES (WhatsApp async-queue.ts)          DESPUES
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~           ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
const weekAgo = new Date(...)           import { collectWeeklyData }
const [sessionsRes, progressRes] =         from "../../lib/weekly-data-
  await Promise.all([                        collector.ts";
    db.from("study_sessions")...
    db.from("topic_progress")...        const data = await
  ]);                                     collectWeeklyData(db, user_id);
const sessions = sessionsRes.data;      const { totalSessions,
const totalSessions = sessions.length;    totalReviews,
const totalReviews = sessions.reduce      accuracyPercent: accuracy
  ((sum, s) => ...);                    } = data;
const correctReviews = ...              const weakTopics = data.weakTopics
const accuracy = ...                      .slice(0, 3)
const weakTopics = (progressRes.data      .map(t => t.topicName);
  || []).filter(...).slice(...).map...
                                        // Prompt y formateo intactos
~22 lineas eliminadas                   // (difieren entre bots)
```

**Alcance exacto del refactor:**
- REEMPLAZADO: queries duplicadas + calculos manuales (22 lineas WhatsApp, 20 lineas Telegram)
- INTACTO: `generateText()` calls (prompts diferentes por canal)
- INTACTO: formateo de mensajes (WhatsApp: emojis + markdown, Telegram: plain text)

---

## Fase 4: Testing [COMPLETADA]

**Archivo:** `tests/weekly_data_collector_test.ts`

| # | Test | Que valida |
|---|------|-----------|
| 1 | `getCurrentWeekStart returns Monday` | week_start siempre es lunes |
| 2 | `getCurrentWeekEnd returns Sunday` | week_end siempre es domingo |
| 3 | `weekEnd is 6 days after weekStart` | rango correcto |
| 4 | `formatDate produces YYYY-MM-DD` | formato ISO |
| 5 | `formatDate zero-pads` | enero 5 = "01-05" |
| 6 | `accuracy 0 when 0 reviews` | division por cero |
| 7 | `accuracy rounds to 2 decimals` | 1/3 = 33.33 |
| 8 | `accuracy 100 when all correct` | caso perfecto |
| 9 | `daysActive never exceeds 7` | cap a 7 |
| 10 | `daysActive 0 with no activities` | caso vacio |
| 11 | `null profile maps to empty arrays` | sin institutionId |
| 12 | `weak items map correctly` | RPC shape -> WeeklyRawData |
| 13 | `lapsing items map correctly` | RPC shape -> WeeklyRawData |

---

## Resumen de Archivos Modificados

```
supabase/
  migrations/
    20260320000001_weekly_reports.sql          [NUEVO]  Tabla + RLS

  functions/server/
    lib/
      weekly-data-collector.ts                 [NUEVO]  Shared collector

    routes/ai/
      weekly-report.ts                         [NUEVO]  GET + POST
      index.ts                                 [EDIT]   Mount + import

    routes/whatsapp/
      async-queue.ts                           [EDIT]   -22 lineas -> collectWeeklyData()

    routes/telegram/
      async-queue.ts                           [EDIT]   -20 lineas -> collectWeeklyData()

    tests/
      weekly_data_collector_test.ts            [NUEVO]  13 tests
```

**Balance:** +690 lineas, -52 lineas = +638 neto (la mayoria es codigo nuevo, no inflado)

---

## Contrato API para Frontend

### Respuesta tipo (GET o POST)

```json
{
  "data": {
    "id": "uuid",
    "weekStart": "2026-03-16",
    "weekEnd": "2026-03-22",

    "totalSessions": 12,
    "totalReviews": 87,
    "correctReviews": 71,
    "accuracyPercent": 81.6,
    "totalTimeSeconds": 5400,
    "daysActive": 5,
    "streakAtReport": 8,
    "xpEarned": 320,

    "weakTopics": [
      { "topicName": "Farmacologia", "masteryLevel": 0.32, "reason": "p_know 0.32, 5 intentos" }
    ],
    "strongTopics": [
      { "topicName": "Anatomia", "masteryLevel": 0.91 }
    ],
    "lapsingCards": [
      { "cardFront": "Que es la IC50?", "keyword": "Farmacodinamica", "lapses": 4 }
    ],

    "aiSummary": "Esta semana mejoraste tu precision al 82%...",
    "aiStrengths": ["Constancia: 5/7 dias activos", "Anatomia dominada al 91%"],
    "aiWeaknesses": ["Farmacologia sigue bajo 40%"],
    "aiMasteryTrend": "improving",
    "aiRecommendedFocus": [
      { "topicName": "Farmacologia", "reason": "subtemas debiles", "suggestedMethod": "flashcard" }
    ],
    "aiModel": "opus",
    "createdAt": "2026-03-20T14:30:00Z"
  }
}
```

---

## Decisiones de Arquitectura

| Decision | Alternativa descartada | Razon |
|---|---|---|
| RPC `get_student_knowledge_context` | Query directo a `mv_student_knowledge_profile` | Patron consistente con 5 archivos AI existentes |
| `institutionId` opcional | Obligatorio en todos los canales | Bot payloads no lo incluyen, rompe backward compat |
| Prompts separados por canal | Prompt unificado | WhatsApp usa acentos+emojis, Telegram plaintext |
| Admin client para INSERT | User client con RLS INSERT | Mas seguro, patron existente en otros endpoints |
| Opus + haiku fallback | Sonnet fijo | `selectModelForTask("report")` ya retorna opus |
| Graceful degradation sin IA | Fail completo si Claude falla | Mejor guardar datos crudos que perder todo |
| Idempotencia por semana | Permitir multiples por semana | Evita costos de IA duplicados |
| Rate limit default 20/hr | Bucket propio 5/hr | Simplicidad, el middleware ya existe |
