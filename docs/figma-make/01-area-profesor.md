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

## RUTAS DEL API — AREA PROFESOR (Crear contenido)

Todas las rutas requieren autenticacion (Authorization + X-Access-Token).
Las tablas SACRED usan soft-delete (deleted_at). Las demas usan hard delete.

### Content Tree (todo el arbol en una llamada)
```
GET /content-tree?institution_id=xxx
```
Devuelve: courses -> semesters -> sections -> topics (solo activos, ordenados por order_index)

### Courses (requiere institution_id)
```
GET    /courses?institution_id=xxx
GET    /courses/:id
POST   /courses   { institution_id, name, description?, order_index? }
PUT    /courses/:id   { name?, description?, order_index?, is_active? }
DELETE /courses/:id   → hard delete
```

### Semesters (requiere course_id)
```
GET    /semesters?course_id=xxx
GET    /semesters/:id
POST   /semesters   { course_id, name, order_index? }
PUT    /semesters/:id   { name?, order_index?, is_active? }
DELETE /semesters/:id
```

### Sections (requiere semester_id)
```
GET    /sections?semester_id=xxx
GET    /sections/:id
POST   /sections   { semester_id, name, order_index? }
PUT    /sections/:id   { name?, order_index?, is_active? }
DELETE /sections/:id
```

### Topics (requiere section_id)
```
GET    /topics?section_id=xxx
GET    /topics/:id
POST   /topics   { section_id, name, order_index? }
PUT    /topics/:id   { name?, order_index?, is_active? }
DELETE /topics/:id
```

### Summaries (requiere topic_id) — SACRED, soft-delete
```
GET    /summaries?topic_id=xxx
GET    /summaries/:id
POST   /summaries   { topic_id, title, content_markdown?, status?, order_index? }
PUT    /summaries/:id   { title?, content_markdown?, status?, order_index?, is_active? }
DELETE /summaries/:id   → soft-delete (sets deleted_at + is_active=false)
PUT    /summaries/:id/restore   → restaurar borrado
```

### Chunks (requiere summary_id) — bloques de un resumen
```
GET    /chunks?summary_id=xxx
GET    /chunks/:id
POST   /chunks   { summary_id, content, order_index?, metadata? }
PUT    /chunks/:id   { content?, order_index?, metadata? }
DELETE /chunks/:id   → hard delete
```

### Keywords (requiere summary_id) — SACRED, soft-delete
```
GET    /keywords?summary_id=xxx
GET    /keywords/:id
POST   /keywords   { summary_id, name, definition?, priority? }
PUT    /keywords/:id   { name?, definition?, priority?, is_active? }
DELETE /keywords/:id   → soft-delete
PUT    /keywords/:id/restore
```

### Subtopics (requiere keyword_id) — SACRED, soft-delete
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
GET    /keyword-connections?keyword_id=xxx   → conexiones de ambos lados
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

### Flashcards (requiere summary_id) — SACRED, soft-delete
```
GET    /flashcards?summary_id=xxx&keyword_id=xxx(opcional)
GET    /flashcards/:id
POST   /flashcards   { summary_id, keyword_id, front, back, source? }
PUT    /flashcards/:id   { front?, back?, source?, is_active? }
DELETE /flashcards/:id   → soft-delete
PUT    /flashcards/:id/restore
```

### Quiz Questions (requiere summary_id) — SACRED, soft-delete
```
GET    /quiz-questions?summary_id=xxx&keyword_id=xxx(op)&question_type=xxx(op)&difficulty=xxx(op)
GET    /quiz-questions/:id
POST   /quiz-questions   { summary_id, keyword_id, question_type, question, correct_answer, options?, explanation?, difficulty?, source? }
PUT    /quiz-questions/:id   { question_type?, question?, options?, correct_answer?, explanation?, difficulty?, source?, is_active? }
DELETE /quiz-questions/:id   → soft-delete
PUT    /quiz-questions/:id/restore
```

### Videos (requiere summary_id) — SACRED, orderable
```
GET    /videos?summary_id=xxx
GET    /videos/:id
POST   /videos   { summary_id, title, url, platform?, duration_seconds?, order_index? }
PUT    /videos/:id   { title?, url?, platform?, duration_seconds?, order_index?, is_active? }
DELETE /videos/:id   → soft-delete
PUT    /videos/:id/restore
```

### Modelos 3D (requiere topic_id) — SACRED
```
GET    /models-3d?topic_id=xxx
GET    /models-3d/:id
POST   /models-3d   { topic_id, title, file_url, file_format?, thumbnail_url?, file_size_bytes?, order_index? }
PUT    /models-3d/:id   { title?, file_url?, file_format?, thumbnail_url?, file_size_bytes?, order_index?, is_active? }
DELETE /models-3d/:id   → soft-delete
PUT    /models-3d/:id/restore
```

### Pins de Modelos 3D (requiere model_id)
```
GET    /model-3d-pins?model_id=xxx&keyword_id=xxx(op)
GET    /model-3d-pins/:id
POST   /model-3d-pins   { model_id, geometry, keyword_id?, pin_type?, normal?, label?, color?, description?, order_index? }
PUT    /model-3d-pins/:id   { keyword_id?, pin_type?, geometry?, normal?, label?, color?, description?, order_index? }
DELETE /model-3d-pins/:id   → hard delete
```

### Reordenar (cualquier tabla con order_index)
```
PUT /reorder   { table: "courses"|"semesters"|"sections"|"topics"|"summaries"|"chunks"|"subtopics"|"videos"|"models_3d"|"model_3d_pins"|"study_plan_tasks", items: [{ id, order_index }] }
```
Maximo 200 items por llamada.
