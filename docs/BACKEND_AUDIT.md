# Auditoria Completa do Backend Axon v4.4

**Data da Auditoria:** 23 de Fevereiro de 2026
**Autor:** Manus AI
**Ultima atualizacao:** 4 de Marco de 2026

## 1. Introducao

Este documento consolida todas as descobertas da auditoria realizada no backend do projeto Axon (repositorio `Matraca130/axon-backend`) e no banco de dados Supabase associado. O objetivo eh fornecer uma fonte unica e definitiva sobre o estado real da arquitetura, schemas, rotas e fluxos de dados, alem de identificar gaps criticos entre a implementacao atual e os requisitos dos Eventos de Verificacao (EVs).

## 2. Arquitetura e Padroes

O backend eh uma aplicacao **Hono** rodando em **Supabase Edge Functions**, servindo como uma API REST para o frontend. A arquitetura eh modular e segue padroes consistentes.

- **Ponto de Entrada:** `supabase/functions/server/index.ts` monta todos os modulos de rotas.
- **Fabrica de CRUD:** O arquivo `crud-factory.ts` eh o coracao do backend. Ele gera dinamicamente rotas `GET` (lista e por ID), `POST`, `PUT` e `DELETE` para as tabelas do banco de dados, o que reduz drasticamente o codigo repetitivo.
- **Modulos de Rotas:** A logica eh dividida em modulos tematicos em `routes/` (split) e arquivos flat `routes-*.tsx` (small domains), cada um responsavel por um conjunto de endpoints.
- **Autenticacao:** Centralizada no arquivo `db.ts`.

## 3. Autenticacao: O Mecanismo de "Duplo Token"

O sistema de autenticacao eh robusto e seguro, utilizando uma convencao de dois tokens em headers diferentes:

1.  **`Authorization: Bearer <ANON_KEY>`**: Este header eh **sempre** enviado e contem a chave anonima publica da Supabase. Sua funcao eh unicamente para passar pela gateway da API da Supabase e permitir a execucao da Edge Function.

2.  **`X-Access-Token: <USER_JWT>`**: Quando um usuario esta logado, seu JSON Web Token (obtido via `supabase.auth`) eh enviado neste header. Eh este token que o backend Hono utiliza para identificar o usuario e aplicar as politicas de RLS (Row-Level Security) no banco de dados.

Este padrao garante que as chamadas a API sejam autenticadas tanto na camada de infraestrutura da Supabase quanto na camada de aplicacao.

## 4. Analise de Schemas e Rotas

A seguir, o detalhamento das tabelas e rotas mais criticas analisadas.

### 4.1. Usuarios e Permissoes (`profiles` e `memberships`)

- **`profiles`**: Tabela central que armazena dados basicos do usuario (nome, email, avatar). O campo `platform_role` distingue `user` de `platform_admin`.
- **`memberships`**: Tabela de juncao que define o papel de um usuario em uma instituicao. Eh aqui que se define se um usuario eh `owner`, `admin`, `professor` ou `student`.
- **`admin_scopes`**: Tabela que define escopos granulares para administradores e professores (ex: acesso a um curso especifico).

### 4.2. Conteudo e Instrumentos de Avaliacao

| Tabela | Rota CRUD | `createFields` (Campos Aceitos no POST) | Gaps Notaveis |
| :--- | :--- | :--- | :--- |
| `flashcards` | OK `/flashcards` | `keyword_id`, `front`, `back`, `source`, `subtopic_id` | Corrigido (GAP 1) |
| `quiz_questions` | OK `/quiz-questions` | `keyword_id`, `question_type`, `question`, `options`, `correct_answer`, `explanation`, `difficulty`, `source`, `subtopic_id`, `quiz_id` | Corrigido (GAP 1) |
| `quizzes` | OK `/quizzes` | Registrada via crud-factory | Corrigido (GAP 2) |

### 4.3. Fluxo de Estudo e Algoritmos

- **`study_plans` / `study_plan_tasks`**: Possuem rotas CRUD completas e estao **100% integrados** com a `ScheduleView` do frontend.
- **`reviews`**: Tabela de log central. **Nao possui** a coluna `response_time_ms`. Schema real: `id`, `session_id`, `item_id`, `instrument_type`, `grade`, `created_at`.
- **`bkt_states`**: Tabela para o algoritmo Bayesian Knowledge Tracing. Possui rotas `GET` e `POST` manuais. Esta corretamente vinculada a `student_id` e `subtopic_id`.
- **`fsrs_states`**: Tabela para o algoritmo de Spaced Repetition (FSRS). Possui rotas `GET` e `POST` manuais. Esta corretamente vinculada a `student_id` e `flashcard_id`.

### 4.4. Rotas de Inteligencia Artificial (IA)

**Status: IMPLEMENTADO (Marco 2026)**

O modulo AI foi migrado do frontend para o backend principal em `routes/ai/` com 4 endpoints:

| Endpoint | Metodo | Funcao |
|----------|--------|--------|
| `/ai/generate` | POST | Gera flashcards/quiz questions adaptativos via Gemini |
| `/ai/rag-chat` | POST | Chat com busca semantica hibrida (pgvector + full-text) |
| `/ai/ingest-embeddings` | POST | Gera embeddings batch para chunks |
| `/ai/list-models` | GET | Diagnostico: lista modelos disponiveis |

Modelos: `gemini-2.5-flash` (geracao), `gemini-embedding-001` (embeddings, 768 dims).
Ver `docs/AI_PIPELINE.md` para detalhes completos.

As rotas de **auditoria** (`/ai-generations`, `/summary-diagnostics` em `routes/plans/`) continuam separadas — elas registram logs de uso de IA, nao realizam geracao.

## 5. Gaps Criticos e Inconsistencias

### OK GAP 1 CORRIGIDO: `subtopic_id` e `quiz_id` Ignorados pela API

- **Correcao Aplicada:** `subtopic_id` e `quiz_id` foram adicionados aos `createFields`, `updateFields` e `optionalFilters` de `flashcards` e `quiz_questions` no arquivo `routes-student.tsx`.
- **Commit:** `b5fc7f5`

### OK GAP 2 CORRIGIDO: Tabela `quizzes` Inacessivel via API

- **Correcao Aplicada:** Uma nova rota CRUD para `/quizzes` foi registrada em `routes-student.tsx` usando a `crud-factory`.
- **Commit:** `b5fc7f5`

### OK GAP 3 CORRIGIDO: Rotas de Geracao de IA Migradas para Backend

- **Correcao Aplicada:** A logica de geracao de conteudo por IA foi migrada do frontend (`sseki-frontend/gemini.tsx`) para o backend principal em `routes/ai/` (4 endpoints) + `gemini.ts` (helpers).
- **Commits:** Serie de commits D-16 a D-18, PF-01 a PF-09, LA-01 a LA-07
- **Pipeline completo:** Embeddings (ingest) -> Busca hibrida (RAG) -> Geracao adaptativa (Gemini)
- **Seguranca:** DB query antes de Gemini call (PF-05), institution scoping (BUG-3), admin client para embeddings (PF-09)
- **Detalhes:** Ver `docs/AI_PIPELINE.md`

## 6. Divida Tecnica e Pontos de Atencao

### 6.1. URL da Edge Function

- **URL Correta (producao):** `https://xdnciktarvxyhkrokbng.supabase.co/functions/v1/server`
- **URL Figma Make (prototipagem):** `https://xdnciktarvxyhkrokbng.supabase.co/functions/v1/make-server-6569f786`
- **Contexto:** O prefixo `/make-server-*` eh especifico do ambiente de desenvolvimento do Figma Make e **nao deve** ser usado para o backend principal.

### 6.2. Row-Level Security (RLS)

- **Estado Atual:** As tabelas `flashcards`, `quiz_questions` e `quizzes` tem RLS **desabilitado** (`relrowsecurity = false`).
- **Divida Tecnica:** Com RLS desabilitado, a seguranca depende exclusivamente da logica do backend. Para um ambiente de producao, o ideal eh **habilitar RLS** em todas as tabelas e criar `policies` explicitas.

---

## 7. Conclusao Geral

O backend do Axon eh bem estruturado, maduro e consistente, com um uso inteligente da fabrica de CRUD para acelerar o desenvolvimento. Todos os 3 gaps criticos identificados na auditoria original foram corrigidos:

1. OK `subtopic_id` e `quiz_id` disponiveis na API
2. OK Tabela `quizzes` acessivel via CRUD
3. OK Rotas de geracao de IA migradas para o backend com pipeline RAG completo

A principal divida tecnica restante eh habilitar RLS nas tabelas que ainda nao o tem.
