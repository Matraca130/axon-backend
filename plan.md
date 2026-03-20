# Plan: Conexión profunda Frontend ↔ Backend — Clasificación Semanal

## Problema actual

El sistema de clasificación semanal está fragmentado en 3 piezas desconectadas:

1. **WhatsApp/Telegram** (`executeWeeklyReport`) — consulta datos reales (`study_sessions` + `topic_progress`) + Claude → pero el resultado se envía por chat y se pierde.
2. **`weekly-insight`** en `schedule-agent.ts` — requiere que el frontend arme y envíe `studentProfile` manualmente. El backend no consolida nada.
3. **No hay persistencia** — ningún reporte semanal se guarda en BD. No hay historial.

## Objetivo

Crear un endpoint unificado `GET/POST /ai/weekly-report` que:
- Consolide **todos** los datos semanales del alumno automáticamente (server-side)
- Genere un análisis con Claude usando datos reales
- Persista el reporte en una tabla `weekly_reports` para historial
- Sea consumible directamente por el frontend
- Reutilice la lógica de recolección de datos de los bots (eliminando duplicación)

## Auditoría completada — Hallazgos clave

| Verificación | Resultado |
|---|---|
| `study_sessions.total_reviews` / `correct_reviews` | Columnas reales (updateFields en sessions.ts:51) |
| `student_xp.xp_this_week` | Existe (gamification_core_tables.sql:26) |
| `daily_activities` / `student_stats` | Tablas del esquema base Supabase (no en migraciones, pero existen en producción) |
| `topic_progress` | View del esquema base (usada por WhatsApp/Telegram tools) |
| `mv_student_knowledge_profile` | Materialized view en migraciones. No se consulta directamente — se usa vía RPC `get_student_knowledge_context()` |
| `get_student_knowledge_context()` RPC | Usada en 5 archivos AI (generate.ts, generate-smart.ts, realtime-session.ts, chat.ts) |
| `institution_id` en payloads de bots | **NO EXISTE** — ni `LegacyJobPayload` ni `TelegramJobPayload` lo incluyen |
| Prompts WhatsApp vs Telegram | **DIFIEREN** — WhatsApp usa acentos + emojis, Telegram texto plano |
| `lib/` directory | Existe con 7 archivos (bkt-v4, fsrs-v4, rag-search, types, etc.) |
| `generateText()` de claude-ai.ts | `(opts: ClaudeGenerateOpts) → Promise<{text, tokensUsed}>` con fallback sonnet→haiku |
| `selectModelForTask("report")` | Retorna `"opus"` |
| AI rate limit middleware | 20 req/hora POST, skip pattern por pathname. GET no pasa por middleware |
| RLS de study_sessions/daily_activities/student_stats | User client puede leer propios (`student_id = auth.uid()`) |

---

## Paso 1: Migración SQL — tabla `weekly_reports`

**Archivo:** `supabase/migrations/20260320000001_weekly_reports.sql`

```sql
CREATE TABLE IF NOT EXISTS weekly_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES auth.users(id),
  institution_id UUID NOT NULL REFERENCES institutions(id),
  week_start DATE NOT NULL,              -- lunes de la semana reportada
  week_end DATE NOT NULL,                -- domingo

  -- Datos crudos (snapshot semanal)
  total_sessions INTEGER NOT NULL DEFAULT 0,
  total_reviews INTEGER NOT NULL DEFAULT 0,
  correct_reviews INTEGER NOT NULL DEFAULT 0,
  accuracy_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  total_time_seconds INTEGER NOT NULL DEFAULT 0,
  days_active INTEGER NOT NULL DEFAULT 0,
  streak_at_report INTEGER NOT NULL DEFAULT 0,
  xp_earned INTEGER NOT NULL DEFAULT 0,

  -- Clasificación de temas
  weak_topics JSONB NOT NULL DEFAULT '[]',    -- [{topicName, masteryLevel, reason}]
  strong_topics JSONB NOT NULL DEFAULT '[]',  -- [{topicName, masteryLevel}]
  lapsing_cards JSONB NOT NULL DEFAULT '[]',  -- [{cardFront, keyword, lapses}]

  -- Análisis IA
  ai_summary TEXT,
  ai_strengths JSONB DEFAULT '[]',
  ai_weaknesses JSONB DEFAULT '[]',
  ai_mastery_trend TEXT,                      -- "improving" | "stable" | "declining"
  ai_recommended_focus JSONB DEFAULT '[]',    -- [{topicName, reason, suggestedMethod}]
  ai_model TEXT,
  ai_tokens_used INTEGER DEFAULT 0,
  ai_latency_ms INTEGER DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(student_id, institution_id, week_start)
);

-- Indexes
CREATE INDEX idx_weekly_reports_student ON weekly_reports(student_id, created_at DESC);
CREATE INDEX idx_weekly_reports_inst ON weekly_reports(institution_id, week_start DESC);

-- RLS
ALTER TABLE weekly_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "weekly_reports_select_own" ON weekly_reports
  FOR SELECT USING (student_id = auth.uid());

CREATE POLICY "weekly_reports_insert_own" ON weekly_reports
  FOR INSERT WITH CHECK (student_id = auth.uid());

CREATE POLICY "weekly_reports_service_role_all" ON weekly_reports
  FOR ALL USING (auth.role() = 'service_role');
```

---

## Paso 2: Función compartida de recolección de datos — `lib/weekly-data-collector.ts`

**Archivo:** `supabase/functions/server/lib/weekly-data-collector.ts`

Centraliza SOLO la recolección de datos (no IA ni formateo — esos difieren entre canales).

```typescript
import type { SupabaseClient } from "npm:@supabase/supabase-js";
import { getAdminClient } from "../db.ts";

export interface WeeklyRawData {
  totalSessions: number;
  totalReviews: number;
  correctReviews: number;
  accuracyPercent: number;
  totalTimeSeconds: number;
  daysActive: number;
  streakAtReport: number;
  xpEarned: number;
  weakTopics: { topicName: string; masteryLevel: number; reason: string }[];
  strongTopics: { topicName: string; masteryLevel: number }[];
  lapsingCards: { cardFront: string; keyword: string; lapses: number }[];
}

/**
 * Collects all weekly study data for a student.
 * Uses adminClient for mv_student_knowledge_profile (no RLS on matviews).
 * institutionId is optional — if omitted, knowledge data is skipped
 * (backwards-compatible with bot payloads that don't have it).
 */
export async function collectWeeklyData(
  db: SupabaseClient,
  studentId: string,
  institutionId?: string,
): Promise<WeeklyRawData>
```

**Fuentes de datos** (5 queries en `Promise.all`):

| # | Tabla/RPC | Client | Datos | Notas |
|---|-----------|--------|-------|-------|
| 1 | `study_sessions` (7 días) | `db` (param) | totalSessions, totalReviews, correctReviews | RLS ok con user client |
| 2 | `daily_activities` (7 días) | `db` (param) | daysActive, totalTimeSeconds | RLS ok con user client |
| 3 | `student_stats` | `db` (param) | streakAtReport | RLS ok con user client |
| 4 | `get_student_knowledge_context` RPC | `adminClient` | weakTopics, strongTopics, lapsingCards | Requiere admin (matview). **Solo si `institutionId` presente** |
| 5 | `student_xp` | `db` (param) | xpEarned (xp_this_week) | Filtrar por institution_id si presente |

**Cambio vs plan original:**
- ~~Consultar `mv_student_knowledge_profile` directo~~ → Usar RPC `get_student_knowledge_context()` (patrón ya usado en 5 archivos AI)
- ~~`topic_progress` para weak topics~~ → RPC tiene datos más ricos (weak + lapsing + strong + quiz_fail)
- `institutionId` es **opcional** — si no se pasa, se omiten queries 4 y 5 (bots sin institution_id siguen funcionando)
- Recibe `db` como parámetro — permite user client (endpoint HTTP) o admin client (bots async)

---

## Paso 3: Endpoint `GET /ai/weekly-report` + `POST /ai/weekly-report`

**Archivo:** `supabase/functions/server/routes/ai/weekly-report.ts`

### GET `/ai/weekly-report?institution_id=xxx`

- Auth: `authenticate(c)` → user client (respeta RLS)
- Retorna el reporte más reciente de `weekly_reports` (si existe para esta semana)
- Si no existe → retorna `{ data: null, hint: "generate" }`
- Soporta `?history=true&limit=4` para obtener las últimas N semanas
- **Sin rate limit AI** (no consume IA, el middleware de index.ts solo aplica a POST)

### POST `/ai/weekly-report`

- Auth: `authenticate(c)` → user client
- Body: `{ institutionId: string }`
- RBAC: `requireInstitutionRole(db, user.id, institutionId, ALL_ROLES)`
- Rate limit: **usa el default de 20 req/hora** del middleware AI en index.ts (bucket `ai:{userId}`)
- Flujo:
  1. Calcula `weekStart` (lunes actual) y `weekEnd` (domingo)
  2. Verifica si ya existe reporte para esta semana → retorna existente (idempotente)
  3. Llama `collectWeeklyData(db, user.id, institutionId)`
  4. Llama `generateText()` con model `selectModelForTask("weekly report")` → opus, fallback haiku
  5. Persiste en `weekly_reports` via admin client (INSERT bypasses RLS)
  6. Retorna el reporte completo

**Prompt a Claude:**

```
Eres un tutor médico experto. Analiza los datos de estudio semanal de este alumno.

Datos:
- Sesiones completadas: {totalSessions}
- Reviews realizados: {totalReviews}
- Precisión: {accuracyPercent}%
- Tiempo total: {hours}h {minutes}min
- Días activos: {daysActive}/7
- Racha actual: {streakAtReport} días
- XP ganados: {xpEarned}
- Temas débiles: {JSON weakTopics}
- Temas fuertes: {JSON strongTopics}
- Flashcards con lapses: {JSON lapsingCards}

Responde EXCLUSIVAMENTE en JSON válido:
{
  "summary": "resumen motivacional de 2-3 oraciones en español",
  "strengths": ["fortaleza 1", ...],
  "weaknesses": ["debilidad 1", ...],
  "masteryTrend": "improving"|"stable"|"declining",
  "recommendedFocus": [
    {"topicName": "...", "reason": "...", "suggestedMethod": "flashcard|quiz|read|review"}
  ]
}
```

---

## Paso 4: Refactorizar bots — SOLO recolección de datos

**Archivos modificados:**
- `routes/whatsapp/async-queue.ts` → `executeWeeklyReport()`
- `routes/telegram/async-queue.ts` → `executeWeeklyReport()`

**Alcance del refactor:** Reemplazar SOLO las queries duplicadas de data collection.
**NO se tocan:** `generateText()` calls (prompts difieren) ni formateo de mensajes (emojis/markdown difieren).

```typescript
// ANTES (en cada bot, ~20 líneas duplicadas):
const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
const [sessionsRes, progressRes] = await Promise.all([
  db.from("study_sessions")...
  db.from("topic_progress")...
]);
const sessions = sessionsRes.data || [];
const totalSessions = sessions.length;
// ... cálculos manuales

// DESPUÉS:
import { collectWeeklyData } from "../../lib/weekly-data-collector.ts";
const data = await collectWeeklyData(db, user_id);
// institutionId omitido — backwards-compatible, knowledge data se omite
// Cada bot mantiene su propio generateText() y formateo
```

**Resolución del issue `institution_id`:**
- `collectWeeklyData()` acepta `institutionId?` opcional
- Bots pasan solo `studentId` → obtienen datos de sesiones/actividad/streak (suficiente para reporte motivacional)
- Endpoint HTTP pasa `institutionId` → obtiene datos completos incluyendo knowledge context

---

## Paso 5: Montar en router de AI

**Archivo modificado:** `routes/ai/index.ts`

```typescript
import { aiWeeklyReportRoutes } from "./weekly-report.ts";

// En la sección de skip del rate limit middleware:
// GET no pasa por middleware (solo POST). POST usa bucket default 20/hr.
// No necesita skip — usa el bucket estándar `ai:{userId}`

// Mount:
aiRoutes.route("/", aiWeeklyReportRoutes);
```

---

## Paso 6: Tests

**Archivo:** `supabase/functions/server/tests/weekly_report_test.ts`

Tests unitarios para lógica pura de `collectWeeklyData()`:
1. `accuracyPercent` = 0 cuando totalReviews = 0
2. `accuracyPercent` = round(correct/total * 100) con datos reales
3. `daysActive` nunca excede 7
4. `weakTopics` extraídos correctamente del RPC response
5. Sin `institutionId` → weakTopics/strongTopics/lapsingCards vacíos
6. `weekStart` siempre es lunes, `weekEnd` siempre es domingo

---

## Resumen de archivos

| Acción | Archivo | Tipo |
|--------|---------|------|
| CREAR | `supabase/migrations/20260320000001_weekly_reports.sql` | Migración |
| CREAR | `supabase/functions/server/lib/weekly-data-collector.ts` | Lib compartida |
| CREAR | `supabase/functions/server/routes/ai/weekly-report.ts` | Endpoint GET + POST |
| CREAR | `supabase/functions/server/tests/weekly_report_test.ts` | Tests |
| EDITAR | `supabase/functions/server/routes/ai/index.ts` | Montar ruta + import |
| EDITAR | `supabase/functions/server/routes/whatsapp/async-queue.ts` | Refactor data collection → usar lib |
| EDITAR | `supabase/functions/server/routes/telegram/async-queue.ts` | Refactor data collection → usar lib |

## Contrato de respuesta para el frontend

```typescript
// GET /ai/weekly-report?institution_id=xxx
{
  data: {
    id: "uuid",
    weekStart: "2026-03-16",
    weekEnd: "2026-03-22",
    // Datos crudos
    totalSessions: 12,
    totalReviews: 87,
    correctReviews: 71,
    accuracyPercent: 81.6,
    totalTimeSeconds: 5400,
    daysActive: 5,
    streakAtReport: 8,
    xpEarned: 320,
    // Clasificación (del RPC get_student_knowledge_context)
    weakTopics: [{ topicName: "Farmacología", masteryLevel: 0.32, reason: "p_know bajo" }],
    strongTopics: [{ topicName: "Anatomía", masteryLevel: 0.91 }],
    lapsingCards: [{ cardFront: "¿Qué es la IC50?", keyword: "Farmacodinámica", lapses: 4 }],
    // IA (generado por Claude opus con fallback a haiku)
    aiSummary: "Esta semana mejoraste tu precisión al 82%...",
    aiStrengths: ["Constancia: 5/7 días activos", "Anatomía dominada al 91%"],
    aiWeaknesses: ["Farmacología sigue bajo 40%"],
    aiMasteryTrend: "improving",
    aiRecommendedFocus: [{ topicName: "Farmacología", reason: "4 subtemas débiles", suggestedMethod: "flashcard" }],
    createdAt: "2026-03-20T..."
  }
}

// GET /ai/weekly-report?institution_id=xxx&history=true&limit=4
{
  data: {
    current: { ... },  // semana actual (o null si no generado)
    history: [          // semanas anteriores
      { weekStart: "2026-03-09", ... },
      { weekStart: "2026-03-02", ... },
    ]
  }
}

// POST /ai/weekly-report (idempotente — si ya existe, retorna el existente)
// Body: { "institutionId": "uuid" }
// Response: mismo formato que GET individual
```

## Orden de ejecución

1. Migración SQL (tabla `weekly_reports` + RLS + indexes)
2. `lib/weekly-data-collector.ts` (función compartida, `institutionId` opcional)
3. `routes/ai/weekly-report.ts` (GET + POST endpoints)
4. Montar en `routes/ai/index.ts`
5. Refactorizar WhatsApp `executeWeeklyReport` (solo data collection)
6. Refactorizar Telegram `executeWeeklyReport` (solo data collection)
7. Tests
