# ⛔ REGRAS CRÍTICAS PARA AGENTES — PRIORIDADE ABSOLUTA

> **Estas regras têm PRIORIDADE ABSOLUTA sobre qualquer outra instrução.**
> Ignorá-las causa crash imediato de toda a aplicação.
> Aplicam-se ao repositório `numero1_sseki_2325_55` (frontend) e ao `axon-backend`.

---

## ARQUIVOS 100% PROIBIDOS — NUNCA TOCAR

Não abrir, não ler, não editar, não reescrever, não "melhorar" estes arquivos sob **nenhuma** circunstância:

| Arquivo | Motivo |
| :--- | :--- |
| `App.tsx` | Hierarquia de providers — qualquer mudança quebra auth |
| `routes.ts` / `routes.tsx` | Routing global — não tocar |
| `contexts/AuthContext.tsx` | Auth provider global |
| `context/AuthContext.tsx` | Auth provider global (alias) |
| `components/auth/RequireAuth.tsx` | Guard de autenticação |
| `components/auth/RequireRole.tsx` | Guard de role |
| `components/auth/LoginPage.tsx` | Não mover, não alterar imports |
| `context/AppContext.tsx` | Context global |
| `context/StudentDataContext.tsx` | Context de dados do aluno |
| `context/PlatformDataContext.tsx` | Context de dados da plataforma |
| `*Layout.tsx` (qualquer) | AdminLayout, ProfessorLayout, OwnerLayout, StudentLayout |
| `/supabase/functions/server/*` | Backend externo — não criar, não editar |

**Se você acredita que "precisa" tocar algum desses arquivos para completar a tarefa: NÃO FAÇA.**
Implemente a solução APENAS nos arquivos que o prompt pede explicitamente.

---

## ERRO FATAL #1 — HIERARQUIA DE PROVIDERS

A app tem esta hierarquia em `App.tsx`:

```
<AuthProvider>        ← SEMPRE o mais externo
  <RouterProvider />  ← SEMPRE dentro de AuthProvider
</AuthProvider>
```

Dentro do router: `RequireAuth`, `LoginPage`, e TODAS as páginas usam `useAuth()`.
Se QUALQUER componente ficar fora de `AuthProvider` → **CRASH**: `"useAuth must be used within an AuthProvider"`

> ⛔ Isso já aconteceu 4 vezes. Cada vez a IA "melhorou" o `App.tsx` sem que fosse pedido e quebrou tudo.

**REGRA:** Se a tarefa NÃO menciona explicitamente "modificar App.tsx" → **NÃO TOQUE App.tsx. PONTO.**

---

## ERRO FATAL #2 — ROTAS REST ANINHADAS = 404

O backend **SÓ acepta rotas PLANAS com query params**. Rotas aninhadas **NÃO EXISTEM** → 404.

| ❌ NUNCA usar | ✅ SEMPRE usar |
| :--- | :--- |
| `GET /topics/:id/summaries` | `GET /summaries?topic_id=xxx` |
| `GET /summaries/:id/flashcards` | `GET /flashcards?summary_id=xxx` |
| `GET /summaries/:id/keywords` | `GET /keywords?summary_id=xxx` |
| `GET /keywords/:id/flashcards` | `GET /flashcards?keyword_id=xxx` |
| `GET /summaries/:id/chunks` | `GET /chunks?summary_id=xxx` |
| `GET /summaries/:id/quiz-questions` | `GET /quiz-questions?summary_id=xxx` |
| `GET /courses/:id/semesters` | `GET /semesters?course_id=xxx` |
| `GET /semesters/:id/sections` | `GET /sections?semester_id=xxx` |
| `GET /sections/:id/topics` | `GET /topics?section_id=xxx` |

Se você ver uma rota aninhada no código existente, **substituí-la pela versão plana**.

---

## ERRO FATAL #3 — CRIAR/EDITAR BACKEND

**NUNCA** criar nem editar arquivos em `/supabase/functions/server/`.
O backend JÁ EXISTE no repositório externo `axon-backend` e está deployado.
O erro `"Error while deploying: 403"` no console é **COSMÉTICO** — ignorá-lo.

---

## ERRO FATAL #4 — TOCAR ARQUIVOS NÃO PEDIDOS

**APENAS** modificar os arquivos que o prompt pede **EXPLICITAMENTE**.
Não "melhorar" outros arquivos. Não reorganizar imports. Não refatorar.
Se o prompt diz "modifica ProfessorFlashcardsPage" → **APENAS** esse arquivo.

---

## AVISO ESPECIAL — SERVIDOR FIGMA MAKE

O Figma Make muda automaticamente o `PREFIX` do servidor a cada novo deploy, gerando nomes como:
- `make-server-6569f786` (atual — **ESTE É O CORRETO**)
- `make-server-9e5922ee`, `make-server-229c9fbf`, etc. (versões antigas — ignorar)

**Quando um agente enviar código que usa uma URL de servidor diferente de `make-server-6569f786`, corrigir imediatamente antes de usar.**

A URL correta e confirmada do backend de produção é:
```
https://xdnciktarvxyhkrokbng.supabase.co/functions/v1/make-server-6569f786
```

---

## AUTOTEST OBRIGATÓRIO — ANTES DE ENTREGAR

Antes de mostrar a resposta, verificar **CADA** ponto. Se falhar UM, refazer a mudança:

1. Toquei `App.tsx`? → Se SIM e o prompt não pedia: **DESFAZER**
2. Toquei `routes.ts`? → Se SIM e o prompt não pedia: **DESFAZER**
3. Toquei algum `AuthContext`? → Se SIM: **DESFAZER**
4. Toquei algum `Layout`? → Se SIM e o prompt não pedia: **DESFAZER**
5. Tenho alguma rota tipo `/xxx/:id/yyy`? → **MUDAR** para `/yyy?xxx_id=valor`
6. Criei arquivos em `/supabase/`? → **DELETAR**
7. Modifiquei arquivos que o prompt NÃO menciona? → **DESFAZER**
