# Plan: Conexión profunda Frontend ↔ Backend — Clasificación Semanal

## Problema actual

El sistema de clasificación semanal está fragmentado en 3 piezas desconectadas:

1. **WhatsApp/Telegram** (`executeWeeklyReport`) — consulta datos reales (`study_sessions` + `topic_progress`) + Claude → pero el resultado se envía por chat y se pierde.
2. **`weekly-insight`** en `schedule-agent.ts` — requiere que el frontend arme y envíe `studentProfile` manualmente. El backend no consolida nada.
3. **No hay persistencia** — ningún reporte semanal se guarda en BD. No hay historial.

## Objetivo

Crear un endpoint unificado `GET /ai/weekly-report` que:
- Consolide **todos** los datos semanales del alumno automáticamente (server-side)
- Genere un análisis con Claude usando datos reales
- Persista el reporte en una tabla `weekly_reports` para historial
- Sea consumible directamente por el frontend
- Reutilice la misma lógica que los bots (eliminando duplicación)

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

  -- Clasificación de temas (lo más valioso)
  weak_topics JSONB NOT NULL DEFAULT '[]',    -- [{topicName, masteryLevel, reason}]
  strong_topics JSONB NOT NULL DEFAULT '[]',  -- [{topicName, masteryLevel}]
  lapsing_cards JSONB NOT NULL DEFAULT '[]',  -- [{cardFront, keyword, lapses}]

  -- Análisis IA
  ai_summary TEXT,                            -- resumen generado por Claude
  ai_strengths JSONB DEFAULT '[]',            -- ["..."]
  ai_weaknesses JSONB DEFAULT '[]',           -- ["..."]
  ai_mastery_trend TEXT,                      -- "improving" | "stable" | "declining"
  ai_recommended_focus JSONB DEFAULT '[]',    -- [{topicName, reason, suggestedMethod}]
  ai_model TEXT,                              -- modelo usado (sonnet/haiku)
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

CREATE POLICY "weekly_reports_insert_service" ON weekly_reports
  FOR INSERT WITH CHECK (true);  -- Solo admin client inserta
```

---

## Paso 2: Función compartida de recolección de datos — `lib/weekly-data-collector.ts`

**Archivo:** `supabase/functions/server/lib/weekly-data-collector.ts`

Esta función centraliza la lógica que hoy está duplicada en WhatsApp y Telegram:

```typescript
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

export async function collectWeeklyData(
  studentId: string,
  institutionId: string,
): Promise<WeeklyRawData>
```

**Fuentes de datos** (5 queries en paralelo, todas existentes):

| Query | Tabla/View | Datos |
|-------|-----------|-------|
| 1 | `study_sessions` (últimos 7 días) | totalSessions, totalReviews, correctReviews |
| 2 | `daily_activities` (últimos 7 días) | daysActive, totalTimeSeconds |
| 3 | `student_stats` | streakAtReport |
| 4 | `mv_student_knowledge_profile` | weakTopics (mastery < 0.5), strongTopics (mastery > 0.85), lapsingCards |
| 5 | `student_xp` | xpEarned (xp_this_week) |

**No requiere nuevas migraciones** — todos estos datos ya existen y están indexados.

---

## Paso 3: Endpoint `GET /ai/weekly-report` + `POST /ai/weekly-report`

**Archivo:** `supabase/functions/server/routes/ai/weekly-report.ts`

### GET `/ai/weekly-report?institution_id=xxx`

- Retorna el reporte más reciente de `weekly_reports` (si existe para esta semana)
- Si no existe → retorna `{ data: null, hint: "generate" }` para que el frontend llame al POST
- Soporta `?history=true&limit=4` para obtener las últimas N semanas

### POST `/ai/weekly-report`

- Body: `{ institutionId: string }`
- Llama `collectWeeklyData()` → obtiene snapshot completo
- Verifica si ya existe reporte para esta semana (idempotente — retorna existente)
- Llama Claude con datos reales para generar análisis
- Persiste en `weekly_reports`
- Retorna el reporte completo

**Prompt a Claude** (reutiliza datos exactos, no requiere que el frontend envíe nada):

```
Datos de estudio semanal del alumno:
- Sesiones completadas: {totalSessions}
- Reviews realizados: {totalReviews}
- Precisión: {accuracyPercent}%
- Tiempo total: {totalTimeSeconds/3600}h
- Días activos: {daysActive}/7
- Racha actual: {streakAtReport} días
- XP ganados: {xpEarned}
- Topics débiles: {weakTopics JSON}
- Topics fuertes: {strongTopics JSON}
- Flashcards con lapses: {lapsingCards JSON}

Genera un análisis semanal con este formato JSON:
{
  "summary": "resumen motivacional de 2-3 oraciones",
  "strengths": ["fortaleza 1", ...],
  "weaknesses": ["debilidad 1", ...],
  "masteryTrend": "improving|stable|declining",
  "recommendedFocus": [
    {"topicName": "...", "reason": "...", "suggestedMethod": "flashcard|quiz|read|review"}
  ]
}
```

---

## Paso 4: Refactorizar bots para usar `collectWeeklyData()`

**Archivos modificados:**
- `routes/whatsapp/async-queue.ts` → `executeWeeklyReport()`
- `routes/telegram/async-queue.ts` → `executeWeeklyReport()`

Cambio: reemplazar las queries duplicadas por:

```typescript
import { collectWeeklyData } from "../../lib/weekly-data-collector.ts";

const rawData = await collectWeeklyData(user_id, institution_id);
// Formatear para WhatsApp/Telegram y enviar
```

Esto elimina ~40 líneas duplicadas en cada archivo y garantiza que bots y frontend usen la misma lógica exacta.

---

## Paso 5: Montar en router de AI

**Archivo modificado:** `routes/ai/index.ts`

```typescript
import { weeklyReportRoutes } from "./weekly-report.ts";
aiRoutes.route("/", weeklyReportRoutes);
```

Rate limit: bucket propio `weekly-report:{userId}`, 5 req/hora (el POST genera IA; el GET no consume IA).

---

## Paso 6: Tests

**Archivo:** `supabase/functions/server/tests/weekly_report_test.ts`

Tests unitarios para `collectWeeklyData()`:
1. Calcula `accuracyPercent` correctamente (edge: 0 reviews → 0%)
2. Filtra `weakTopics` con mastery < 0.5
3. Filtra `strongTopics` con mastery > 0.85
4. `daysActive` nunca excede 7
5. `week_start` siempre es lunes, `week_end` siempre es domingo

---

## Resumen de archivos

| Acción | Archivo | Tipo |
|--------|---------|------|
| CREAR | `supabase/migrations/20260320000001_weekly_reports.sql` | Migración |
| CREAR | `supabase/functions/server/lib/weekly-data-collector.ts` | Lib compartida |
| CREAR | `supabase/functions/server/routes/ai/weekly-report.ts` | Endpoint |
| CREAR | `supabase/functions/server/tests/weekly_report_test.ts` | Tests |
| EDITAR | `supabase/functions/server/routes/ai/index.ts` | Montar ruta |
| EDITAR | `supabase/functions/server/routes/whatsapp/async-queue.ts` | Refactor → usar lib |
| EDITAR | `supabase/functions/server/routes/telegram/async-queue.ts` | Refactor → usar lib |

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
    // Clasificación
    weakTopics: [{ topicName: "Farmacología", masteryLevel: 0.32, reason: "p_know bajo, 4 subtemas < 0.5" }],
    strongTopics: [{ topicName: "Anatomía", masteryLevel: 0.91 }],
    lapsingCards: [{ cardFront: "¿Qué es la IC50?", keyword: "Farmacodinámica", lapses: 4 }],
    // IA
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
    current: { ... },  // semana actual
    history: [          // semanas anteriores
      { weekStart: "2026-03-09", ... },
      { weekStart: "2026-03-02", ... },
    ]
  }
}
```

## Orden de ejecución

1. Migración SQL (tabla `weekly_reports`)
2. `lib/weekly-data-collector.ts` (función compartida)
3. `routes/ai/weekly-report.ts` (GET + POST endpoints)
4. Montar en `routes/ai/index.ts`
5. Refactorizar WhatsApp `executeWeeklyReport`
6. Refactorizar Telegram `executeWeeklyReport`
7. Tests
