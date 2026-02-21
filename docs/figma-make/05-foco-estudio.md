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

## RUTAS DEL API — FOCO: ESTUDIO Y REPETICION ESPACIADA

Este bloque cubre el flujo de estudio: sesiones, reviews, quizzes, FSRS y estadisticas.

### Flashcards (solo lectura para alumno)
```
GET    /flashcards?summary_id=xxx&keyword_id=xxx(op)
GET    /flashcards/:id
```

### Quiz Questions (solo lectura para alumno)
```
GET    /quiz-questions?summary_id=xxx&keyword_id=xxx(op)&question_type=xxx(op)&difficulty=xxx(op)
GET    /quiz-questions/:id
```

### Study Sessions
```
GET    /study-sessions?course_id=xxx(op)&session_type=xxx(op)
GET    /study-sessions/:id
POST   /study-sessions   { session_type, course_id? }
PUT    /study-sessions/:id   { ended_at?, duration_seconds?, total_reviews?, correct_reviews? }
DELETE /study-sessions/:id
```

### Reviews (inmutables)
```
GET    /reviews?session_id=xxx
POST   /reviews   { session_id, item_id, instrument_type, grade(0-5) }
```

### Quiz Attempts (inmutables)
```
GET    /quiz-attempts?quiz_question_id=xxx | session_id=xxx
POST   /quiz-attempts   { quiz_question_id, answer, is_correct, session_id?, time_taken_ms? }
```

### FSRS States (repeticion espaciada)
```
GET    /fsrs-states?flashcard_id=xxx(op)&state=xxx(op)&due_before=ISO(op)&limit=100&offset=0
POST   /fsrs-states   { flashcard_id, stability?, difficulty?, due_at?, last_review_at?, reps?, lapses?, state? }
```
States: "new" | "learning" | "review" | "relearning"
Upsert por student_id + flashcard_id.

**Algoritmo FSRS sugerido para el frontend:**
1. GET /fsrs-states?due_before={ahora}&state=review → cards que toca repasar
2. Mostrar flashcard al alumno
3. Alumno califica (0-5)
4. POST /reviews { session_id, item_id, instrument_type: "flashcard", grade }
5. Calcular nuevos parametros FSRS en frontend
6. POST /fsrs-states { flashcard_id, stability, difficulty, due_at, reps, state, ... }

### BKT States (conocimiento por subtopic)
```
GET    /bkt-states?subtopic_id=xxx(op)&limit=100&offset=0
POST   /bkt-states   { subtopic_id, p_know?, p_transit?, p_slip?, p_guess?, delta?, total_attempts?, correct_attempts?, last_attempt_at? }
```
Probabilidades [0,1]. Upsert por student_id + subtopic_id.

### Study Plans
```
GET    /study-plans?course_id=xxx(op)&status=xxx(op)
GET    /study-plans/:id
POST   /study-plans   { name, course_id?, status? }
PUT    /study-plans/:id   { name?, status? }
DELETE /study-plans/:id

GET    /study-plan-tasks?study_plan_id=xxx
GET    /study-plan-tasks/:id
POST   /study-plan-tasks   { study_plan_id, item_type, item_id, status?, order_index? }
PUT    /study-plan-tasks/:id   { status?, order_index?, completed_at? }
DELETE /study-plan-tasks/:id
```

### Daily Activities (una por dia)
```
GET    /daily-activities?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=90&offset=0
POST   /daily-activities   { activity_date(YYYY-MM-DD), reviews_count?, correct_count?, time_spent_seconds?, sessions_count? }
```

### Student Stats (lifetime, una por alumno)
```
GET    /student-stats
POST   /student-stats   { current_streak?, longest_streak?, total_reviews?, total_time_seconds?, total_sessions?, last_study_date? }
```
