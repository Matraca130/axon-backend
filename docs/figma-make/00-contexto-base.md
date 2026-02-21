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
