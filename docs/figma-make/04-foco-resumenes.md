## Proyecto: Axon v4.4 — Plataforma Educativa

### Arquitectura
- Frontend: React 18 + Vite + Tailwind CSS 4 + shadcn/ui + Lucide icons
- Backend: Hono web server en Supabase Edge Functions (Deno) — YA DESPLEGADO
- Base de datos: Supabase PostgreSQL con 39 tablas y RLS

### Conexion al Backend
Base URL: https://xdnciktarvxyhkrokbng.supabase.co/functions/v1/make-server-6569f786

Headers requeridos en TODAS las peticiones:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhkbmNpa3RhcnZ4eWhrcm9rYm5nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEyMTM4NjAsImV4cCI6MjA4Njc4OTg2MH0._nCGOiOh1bMWvqtQ62d368LlYj5xPI6e7pcsdjDEiYQ
X-Access-Token: {JWT del usuario logueado via supabase.auth}
```

- El header `Authorization` siempre lleva la publicAnonKey (gateway de Supabase).
- El header `X-Access-Token` lleva el JWT del usuario autenticado.
- La ruta `/signup` y `/health` NO necesitan `X-Access-Token`.

### Patron de respuestas
- Exito: `{ "data": ... }`
- Error: `{ "error": "mensaje descriptivo" }`
- Listas paginadas (rutas factory CRUD): `{ "data": { "items": [...], "total": N, "limit": N, "offset": N } }`
  Aplica a: courses, semesters, sections, topics, summaries, chunks, keywords, subtopics, flashcards, quiz-questions, videos, kw-student-notes, text-annotations, video-notes, study-sessions, study-plans, study-plan-tasks, models-3d, model-3d-pins, model-3d-notes, platform-plans, institution-plans, plan-access-rules, institution-subscriptions
- Listas custom (array plano): `{ "data": [...] }`
  Aplica a: institutions, memberships, admin-scopes, keyword-connections, kw-prof-notes, reviews, quiz-attempts, daily-activities, fsrs-states, bkt-states, ai-generations, summary-diagnostics
- Objeto unico o null: `{ "data": { ... } }` o `{ "data": null }`
  Aplica a: GET /:id, reading-states, student-stats

### Paginacion y filtros globales
- Factory CRUD LIST: soporta `?limit=N&offset=N` (default: limit=100, offset=0)
- Tablas con soft-delete aceptan `?include_deleted=true` para mostrar registros borrados
  (sin esto, los borrados estan ocultos por defecto — necesario para descubrir items antes de restaurar)
- Tablas con `order_index` se ordenan por order_index ASC; las demas por created_at ASC

### Login (client-side, no es ruta del server)
```typescript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://xdnciktarvxyhkrokbng.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhkbmNpa3RhcnZ4eWhrcm9rYm5nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEyMTM4NjAsImV4cCI6MjA4Njc4OTg2MH0._nCGOiOh1bMWvqtQ62d368LlYj5xPI6e7pcsdjDEiYQ'
);

// Login
const { data: { session } } = await supabase.auth.signInWithPassword({ email, password });
const accessToken = session?.access_token; // Este va en X-Access-Token

// Verificar sesion existente
const { data: { session: existing } } = await supabase.auth.getSession();

// Logout
await supabase.auth.signOut();
```

### Patron para llamar al API
```typescript
const API_BASE = 'https://xdnciktarvxyhkrokbng.supabase.co/functions/v1/make-server-6569f786';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhkbmNpa3RhcnZ4eWhrcm9rYm5nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEyMTM4NjAsImV4cCI6MjA4Njc4OTg2MH0._nCGOiOh1bMWvqtQ62d368LlYj5xPI6e7pcsdjDEiYQ';

async function apiCall(path: string, options: RequestInit = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ANON_KEY}`,
      'X-Access-Token': accessToken, // JWT del usuario
      ...options.headers,
    },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'API Error');
  return json.data;
}
```

### Diseno
- Dark mode por defecto (bg-zinc-950, text-white)
- Estilo clean, desktop-first, responsive
- Accent color: violet/indigo gradient
- Usar componentes shadcn/ui si estan disponibles
- Iconos: lucide-react

### Jerarquia de datos
Institution -> Course -> Semester -> Section -> Topic -> Summary -> (Chunks, Keywords, Flashcards, Quiz Questions, Videos)
Keywords -> Subtopics, Keyword Connections, Notas del profesor, Notas del alumno

### 3 Roles
- **Student**: ve contenido, estudia, toma notas personales
- **Professor**: crea y edita contenido (summaries, flashcards, quizzes, etc.)
- **Owner**: gestiona la institucion, memberships, planes

---

## RUTAS DEL API — FOCO: RESUMENES

Este bloque cubre TODO lo necesario para construir la experiencia de resumenes:
profesor crea/edita contenido, alumno lee/anota/estudia.

### Summary (el resumen principal) — ordena por order_index
```
GET    /summaries?topic_id=xxx
GET    /summaries/:id
POST   /summaries   { topic_id, title, content_markdown?, status?, order_index? }
PUT    /summaries/:id   { title?, content_markdown?, status?, order_index?, is_active? }
DELETE /summaries/:id   → soft-delete (sets deleted_at + is_active=false)
PUT    /summaries/:id/restore
```
status puede ser: "draft", "published", etc. (string libre)

### Chunks (bloques del resumen) — ordena por order_index
```
GET    /chunks?summary_id=xxx
GET    /chunks/:id
POST   /chunks   { summary_id, content, order_index?, metadata? }
PUT    /chunks/:id   { content?, order_index?, metadata? }
DELETE /chunks/:id   → hard delete
```
metadata es un JSON libre (puede tener tipo de bloque, etc.)

### Keywords (conceptos clave del resumen) — ordena por created_at
```
GET    /keywords?summary_id=xxx
GET    /keywords/:id
POST   /keywords   { summary_id, name, definition?, priority? }
PUT    /keywords/:id   { name?, definition?, priority?, is_active? }
DELETE /keywords/:id   → soft-delete
PUT    /keywords/:id/restore
```

### Subtopics (hijos de keywords) — ordena por order_index, SACRED
```
GET    /subtopics?keyword_id=xxx
GET    /subtopics/:id
POST   /subtopics   { keyword_id, name, order_index? }
PUT    /subtopics/:id   { name?, order_index?, is_active? }
DELETE /subtopics/:id   → soft-delete
PUT    /subtopics/:id/restore
```

### Keyword Connections (relaciones entre keywords)
```
GET    /keyword-connections?keyword_id=xxx
GET    /keyword-connections/:id
POST   /keyword-connections   { keyword_a_id, keyword_b_id, relationship? }
       → orden canonico (a < b) se aplica automaticamente
DELETE /keyword-connections/:id   → hard delete
```

### Notas del Profesor sobre Keywords (upsert)
```
GET    /kw-prof-notes?keyword_id=xxx
GET    /kw-prof-notes/:id
POST   /kw-prof-notes   { keyword_id, note }
       → upsert: una nota por profesor+keyword
DELETE /kw-prof-notes/:id
```

### Flashcards (creadas por profesor, estudiadas por alumno) — ordena por created_at
```
GET    /flashcards?summary_id=xxx&keyword_id=xxx(op)
GET    /flashcards/:id
POST   /flashcards   { summary_id, keyword_id, front, back, source? }
PUT    /flashcards/:id   { front?, back?, source?, is_active? }
DELETE /flashcards/:id   → soft-delete
PUT    /flashcards/:id/restore
```

### Quiz Questions — ordena por created_at
```
GET    /quiz-questions?summary_id=xxx&keyword_id=xxx(op)&question_type=xxx(op)&difficulty=xxx(op)
GET    /quiz-questions/:id
POST   /quiz-questions   { summary_id, keyword_id, question_type, question, correct_answer, options?, explanation?, difficulty?, source? }
PUT    /quiz-questions/:id   { question_type?, question?, options?, correct_answer?, explanation?, difficulty?, source?, is_active? }
DELETE /quiz-questions/:id   → soft-delete
PUT    /quiz-questions/:id/restore
```

### Videos (requiere summary_id) — ordena por order_index, SACRED
```
GET    /videos?summary_id=xxx
GET    /videos/:id
POST   /videos   { summary_id, title, url, platform?, duration_seconds?, order_index? }
PUT    /videos/:id   { title?, url?, platform?, duration_seconds?, order_index?, is_active? }
DELETE /videos/:id   → soft-delete
PUT    /videos/:id/restore
```

### Notas del alumno en keywords (privadas, scopeToUser)
```
GET    /kw-student-notes?keyword_id=xxx
GET    /kw-student-notes/:id
POST   /kw-student-notes   { keyword_id, note }
PUT    /kw-student-notes/:id   { note? }
DELETE /kw-student-notes/:id   → soft-delete (deleted_at only, sin is_active)
PUT    /kw-student-notes/:id/restore
```

### Anotaciones de texto en resumenes (scopeToUser)
```
GET    /text-annotations?summary_id=xxx
GET    /text-annotations/:id
POST   /text-annotations   { summary_id, start_offset, end_offset, color?, note? }
PUT    /text-annotations/:id   { color?, note? }
DELETE /text-annotations/:id   → soft-delete (deleted_at only, sin is_active)
PUT    /text-annotations/:id/restore
```

### Notas en videos con timestamp (scopeToUser)
```
GET    /video-notes?video_id=xxx
GET    /video-notes/:id
POST   /video-notes   { video_id, timestamp_seconds?, note }
PUT    /video-notes/:id   { timestamp_seconds?, note? }
DELETE /video-notes/:id   → soft-delete (deleted_at only, sin is_active)
PUT    /video-notes/:id/restore
```

### Reading State (upsert — una por alumno+summary)
```
GET    /reading-states?summary_id=xxx   → devuelve null si nunca leyo
POST   /reading-states   { summary_id, scroll_position?, time_spent_seconds?, completed?, last_read_at? }
       → upsert automatico por student_id+summary_id
```

### Reordenar
```
PUT /reorder   { table: "chunks"|"summaries"|"subtopics"|"videos", items: [{ id, order_index }] }
```
Maximo 200 items por llamada.
