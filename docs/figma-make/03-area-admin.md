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

## RUTAS DEL API — AREA ADMIN/OWNER (Gestion)

Todas autenticadas. Las operaciones de admin estan protegidas por RLS.

### Auth
```
POST   /signup   { email, password, full_name? }
       → NO necesita X-Access-Token
       → Crea auth user + profile atomicamente
       → Password minimo 8 caracteres

GET    /me       → perfil del usuario logueado (tabla profiles)
PUT    /me       { full_name?, avatar_url? }
```

### Health (publico)
```
GET    /health   → { status: "ok", version: "4.4", timestamp: "..." }
```

### Institutions
```
GET    /institutions              → lista las instituciones del usuario (via memberships activas)
       → devuelve cada institution con membership_id y role del usuario
GET    /institutions/:id
POST   /institutions   { name, slug, logo_url?, settings? }
       → slug: 3-50 chars, lowercase alfanumerico + guiones, no empieza/termina con guion
       → crea automaticamente membership de owner para el usuario
PUT    /institutions/:id   { name?, slug?, logo_url?, settings?, is_active? }
DELETE /institutions/:id   → soft-deactivate (is_active = false)
```

### Memberships
```
GET    /memberships?institution_id=xxx
GET    /memberships/:id
POST   /memberships   { user_id, institution_id, role, institution_plan_id? }
       → role: "student" | "professor" | "owner"
PUT    /memberships/:id   { role?, institution_plan_id?, is_active? }
DELETE /memberships/:id   → soft-deactivate
```

### Admin Scopes (permisos granulares por membership)
```
GET    /admin-scopes?membership_id=xxx
POST   /admin-scopes   { membership_id, scope_type, scope_id? }
DELETE /admin-scopes/:id   → hard delete
```

### Platform Plans (catalogo global de precios)
```
GET    /platform-plans
GET    /platform-plans/:id
POST   /platform-plans   { name, slug, description?, price_cents?, billing_cycle?, max_students?, max_courses?, max_storage_mb?, features? }
PUT    /platform-plans/:id   { name?, slug?, description?, price_cents?, billing_cycle?, max_students?, max_courses?, max_storage_mb?, features?, is_active? }
DELETE /platform-plans/:id
```

### Institution Plans (planes de una institucion)
```
GET    /institution-plans?institution_id=xxx
GET    /institution-plans/:id
POST   /institution-plans   { institution_id, name, description?, price_cents?, billing_cycle?, is_default? }
PUT    /institution-plans/:id   { name?, description?, price_cents?, billing_cycle?, is_default?, is_active? }
DELETE /institution-plans/:id
```

### Plan Access Rules (que contenido ve cada plan)
```
GET    /plan-access-rules?plan_id=xxx
GET    /plan-access-rules/:id
POST   /plan-access-rules   { plan_id, scope_type, scope_id }
PUT    /plan-access-rules/:id   { scope_type?, scope_id? }
DELETE /plan-access-rules/:id   → hard delete
```

### Institution Subscriptions
```
GET    /institution-subscriptions?institution_id=xxx
GET    /institution-subscriptions/:id
POST   /institution-subscriptions   { institution_id, plan_id, status?, current_period_start?, current_period_end? }
PUT    /institution-subscriptions/:id   { plan_id?, status?, current_period_start?, current_period_end? }
DELETE /institution-subscriptions/:id
```

### AI Generations (log inmutable — solo LIST + POST)
```
GET    /ai-generations?institution_id=xxx&generation_type=xxx(op)&limit=50&offset=0
POST   /ai-generations   { institution_id, generation_type, source_summary_id?, source_keyword_id?, items_generated?, model_used? }
       → requested_by se setea automaticamente del usuario
```

### Summary Diagnostics (log inmutable — solo LIST + POST)
```
GET    /summary-diagnostics?summary_id=xxx&diagnostic_type=xxx(op)
POST   /summary-diagnostics   { summary_id, content, ai_generation_id?, parent_diagnostic_id?, diagnostic_type?, structured_data?, model_used?, prompt_version? }
       → requested_by se setea automaticamente
```
