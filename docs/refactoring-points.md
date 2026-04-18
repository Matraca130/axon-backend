# Puntos de Refactorización — axon-backend

**Fecha:** 2026-04-09  
**Alcance:** `supabase/functions/server/`  
**Rama de análisis:** `claude/find-refactoring-points-itxku`

---

## Resumen Ejecutivo

Se identificaron **15 puntos de refactorización** agrupados en 4 categorías:
duplicación de código, estructura de módulos, tipado débil, y problemas de mantenibilidad.
Los de mayor impacto son los que involucran lógica duplicada en múltiples archivos.

---

## R-01 · `fetchWithRetry` duplicado en `claude-ai.ts` y `gemini.ts`

**Archivos:**
- `claude-ai.ts:47–88` — maneja 429/529/503, etiqueta `[Claude]`
- `gemini.ts:39–81` — maneja 429/503, etiqueta `[Gemini]`

**Problema:** Lógica de retry con backoff exponencial casi idéntica en dos archivos.
Si se modifica la lógica (ej. añadir un código de error o cambiar el límite de retries),
hay que actualizarlo en dos lugares.

**Solución propuesta:** Extraer a `lib/fetch-with-retry.ts` con parámetro
`retryStatuses: number[]` para que cada provider configure sus propios códigos.

---

## R-02 · Tres implementaciones distintas de hash para advisory locks

**Archivos:**
- `auto-ingest.ts:109` — djb2 (`(hash << 5) - hash + charCode`)
- `gamification-dispatcher.ts:35` — FNV-1a (`hash ^= charCode; hash * 0x01000193`)
- `routes/gamification/streak.ts:403` — djb2 idéntico al de `auto-ingest.ts`

**Problema:** Tres funciones de hash diferentes para el mismo propósito (generar una
clave de advisory lock). Si colisionan de forma diferente, dos procesos que deberían
bloquearse mutuamente no lo harán.

**Solución propuesta:** Exportar una única función desde `lib/advisory-lock.ts`:
```ts
export function advisoryLockKey(input: string): number { ... }
export async function withAdvisoryLock<T>(db, key, fn): Promise<T> { ... }
```

---

## R-03 · Patrón advisory lock repetido (acquire → work → release in finally)

**Archivos:**
- `auto-ingest.ts:176–531` — try/finally release
- `gamification-dispatcher.ts:89–158` — try/finally release
- `routes/gamification/streak.ts:153–160` y `295–302` — try/finally release (2 veces)

**Problema:** El mismo boilerplate de 20+ líneas aparece 4 veces. Un error en la
lógica de release hay que corregirlo en todos.

**Solución propuesta:** Helper `withAdvisoryLock(db, lockKey, fn)` del R-02 anterior.

---

## R-04 · `parseGeminiJson` y `parseClaudeJson` son idénticas

**Archivos:**
- `gemini.ts:271–281`
- `claude-ai.ts:415–425`

**Problema:** Implementación byte-a-byte idéntica. El propio comentario en `claude-ai.ts`
dice: *"Same logic as gemini.ts parseGeminiJson (drop-in replacement)"*.

**Solución propuesta:** Eliminar `parseGeminiJson` de `gemini.ts` y que re-exporte
desde `claude-ai.ts`, o extraer a `lib/parse-json.ts` compartido. Los consumidores
de `parseGeminiJson` deben migrarse a `parseClaudeJson`.

---

## R-05 · Resolución de `institution_id` duplicada en múltiples archivos

**Archivos con helpers propios:**
- `xp-hooks.ts:17` — `resolveInstitutionFromSession()`
- `xp-hooks.ts:41` — `resolveInstitutionFromQuizQuestion()`
- `finals-badge-hooks.ts:74` — `resolveInstitutionFromPlan()`
- `crud-factory.ts:160` — `resolveInstitutionFromParent()`
- `crud-factory.ts:186` — `resolveInstitutionFromRow()`

**Archivos que llaman la RPC directamente (sin helper):**
- `xp-hooks.ts:278` — inline `db.rpc("resolve_parent_institution", ...)`
- `routes-models.ts:61` — inline `db.rpc("resolve_parent_institution", ...)`

**Problema:** 5 helpers privados + 2 llamadas inline para la misma lógica. Ninguno
de estos helpers está disponible para otros módulos.

**Solución propuesta:** Exportar helpers de resolución desde `crud-factory.ts` o
crear `lib/institution-resolver.ts` con funciones reutilizables.

---

## R-06 · `_tryAwardBadge` duplica lógica de `badges.ts`

**Archivos:**
- `gamification-dispatcher.ts:302–358`
- `routes/gamification/badges.ts` (función equivalente `tryAwardBadge`)

**Problema:** El comentario en el archivo lo indica explícitamente: *"Mirrors
tryAwardBadge from badges.ts with the same fresh-check + 23505 race handling"*.
Cualquier cambio en la lógica de award (ej. nuevo campo, nueva validación) debe
aplicarse en ambos lugares.

**Solución propuesta:** Extraer `tryAwardBadge` a `lib/badge-award.ts` compartido
e importarlo en ambos archivos.

---

## R-07 · Import dinámico en `gamification-dispatcher.ts` para evitar dependencia circular

**Archivo:** `gamification-dispatcher.ts:173–178`

```ts
const { evaluateSimpleCondition, evaluateCountBadge } = await import(
  "./routes/gamification/helpers.ts"
);
const { awardXP } = await import("./xp-engine.ts");
```

**Problema:** El import dinámico es un workaround para una dependencia circular.
Oculta el grafo de dependencias real y dificulta el análisis estático (tree-shaking,
type checking completo).

**Solución propuesta:** Reestructurar el grafo de dependencias moviendo los tipos/
interfaces compartidos a un módulo neutral (ej. `lib/types.ts` ya existe), para que
`gamification-dispatcher.ts` no dependa de `xp-engine.ts` y viceversa.

---

## R-08 · `GENERATE_MODEL` exportado con el mismo nombre desde `gemini.ts` y `claude-ai.ts`

**Archivos:**
- `gemini.ts:26` — `export const GENERATE_MODEL = "gemini-2.5-flash"`
- `claude-ai.ts:346` — `export const GENERATE_MODEL = "claude-sonnet-4-20250514"`

**Problema:** Mismo nombre de export, valores diferentes. Un consumer que haga
`import { GENERATE_MODEL } from "../../claude-ai.ts"` vs `../../gemini.ts`
obtiene valores completamente distintos. Propenso a bugs silenciosos.

**Solución propuesta:** Renombrar a `GEMINI_GENERATE_MODEL` y `CLAUDE_GENERATE_MODEL`
respectivamente, o centralizar en un registry de modelos.

---

## R-09 · `gemini.ts` exporta `generateText` DEPRECATED sin forzar error

**Archivo:** `gemini.ts:98–148`

**Problema:** La función está marcada como DEPRECATED pero sigue funcionando.
A diferencia de `generateEmbedding()` (que lanza error inmediatamente), `generateText()`
devuelve resultados válidos de Gemini. Si un consumer la llama por error, usa Gemini
para texto en lugar de Claude, sin ninguna advertencia en runtime.

**Solución propuesta:** Hacer que `generateText()` en `gemini.ts` lance un error
inmediato como ya hace `generateEmbedding()`, o eliminar la exportación.

---

## R-10 · `selectModelForTask` usa keyword-matching con strings hardcodeados

**Archivo:** `claude-ai.ts:297–339`

```ts
if (lowerTask.includes("report") || lowerTask.includes("reporte") || ...)
```

**Problema:** 15+ strings hardcodeados en condicionales anidados. Difícil de testear,
fácil de olvidar variantes de palabras. La lógica de "qué tarea requiere qué modelo"
está mezclada con los strings concretos.

**Solución propuesta:** Extraer a un mapa de keywords por modelo:
```ts
const MODEL_KEYWORDS: Record<ClaudeModel, string[]> = {
  opus: ["report", "reporte", "análisis", ...],
  haiku: ["format", "formatear", ...],
  sonnet: [],
};
```

---

## R-11 · Parámetros `db: any` en `crud-factory.ts`

**Archivo:** `crud-factory.ts:160,186,216`

```ts
async function resolveInstitutionFromParent(db: any, ...) { ... }
async function resolveInstitutionFromRow(db: any, ...) { ... }
async function checkContentScope(c, db: any, ...) { ... }
```

**Problema:** `any` desactiva el chequeo de tipos para el cliente Supabase.
El tipo correcto es `SupabaseClient` de `@supabase/supabase-js`.

**Solución propuesta:** Tipar como `SupabaseClient` e importar el tipo. Ya se usa en
`gamification-dispatcher.ts:86` (`const db: SupabaseClient = getAdminClient()`).

---

## R-12 · `autoChunkAndEmbed` retorna early con estructura literal repetida

**Archivo:** `auto-ingest.ts:183–335`

La misma estructura `AutoIngestResult` se construye en 4 lugares distintos con campos
repetidos (`embeddings_generated: 0, embeddings_failed: 0, retried_count: 0`, etc.):

- Línea 183: lock no adquirido
- Línea 258: sin contenido
- Línea 286: contenido sin cambios
- Línea 324: sin chunks

**Solución propuesta:** Helper privado:
```ts
function earlyResult(summaryId: string, strategy: string, t0: number, partial?: Partial<AutoIngestResult>): AutoIngestResult {
  return { summary_id: summaryId, chunks_created: 0, embeddings_generated: 0,
    embeddings_failed: 0, retried_count: 0, strategy_used: strategy,
    summary_embedded: false, skipped_unchanged: false,
    elapsed_ms: Date.now() - t0, ...partial };
}
```

---

## R-13 · `getBonusContext` en `xp-hooks.ts` llama `getAdminClient()` repetidamente

**Archivo:** `xp-hooks.ts:63`

`getBonusContext()` llama `getAdminClient()` internamente. Varios hooks también llaman
`getAdminClient()` antes de llamar `getBonusContext()`, resultando en llamadas redundantes
al singleton (es idempotente, pero confuso).

**Ejemplo en `xpHookForReadingComplete`:**
```ts
const db = getAdminClient();  // línea 277
const bonus = await getBonusContext(userId);  // getBonusContext hace getAdminClient() otra vez
```

**Solución propuesta:** Pasar `db` como parámetro a `getBonusContext(studentId, db?, ...)`.

---

## R-14 · `routes/gamification/streak.ts` tiene lógica de hash duplicada con `auto-ingest.ts`

**Archivos:**
- `auto-ingest.ts:109–115` — `advisoryLockKey()` con djb2
- `routes/gamification/streak.ts:403–410` — `hashCode()` con djb2 idéntico

Las implementaciones son byte-a-byte iguales. Ver R-02.

---

## R-15 · `gemini.ts` aún exporta `getApiKey` sin namespace

**Archivo:** `gemini.ts:34`

```ts
export { getApiKey };
```

`getApiKey` en `gemini.ts` y `getClaudeApiKey` en `claude-ai.ts` cumplen la misma
función pero con nombres diferentes. El nombre genérico `getApiKey` desde gemini
podría confundirse con la clave de Claude.

**Solución propuesta:** Renombrar a `getGeminiApiKey` al exportar para consistencia
con `getClaudeApiKey`.

---

## Prioridad de Refactorización

| ID | Impacto | Esfuerzo | Prioridad |
|----|---------|----------|-----------|
| R-02 + R-03 | Alto — correctness en advisory locks | Bajo | **Alta** |
| R-04 | Alto — código muerto | Bajo | **Alta** |
| R-05 | Alto — mantenibilidad | Medio | **Alta** |
| R-01 | Medio — DRY | Medio | Media |
| R-06 | Medio — correctness en gamification | Medio | Media |
| R-07 | Medio — arquitectura | Alto | Media |
| R-08 + R-09 | Medio — bugs silenciosos | Bajo | Media |
| R-11 | Bajo — type safety | Bajo | Baja |
| R-10 + R-12 + R-13 + R-14 + R-15 | Bajo | Bajo | Baja |
