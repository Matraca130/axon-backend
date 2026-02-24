# Auditoria Completa do Backend Axon v4.4

**Data da Auditoria:** 23 de Fevereiro de 2026
**Autor:** Manus AI

## 1. Introdução

Este documento consolida todas as descobertas da auditoria realizada no backend do projeto Axon (repositório `Matraca130/axon-backend`) e no banco de dados Supabase associado. O objetivo é fornecer uma fonte única e definitiva sobre o estado real da arquitetura, schemas, rotas e fluxos de dados, além de identificar gaps críticos entre a implementação atual e os requisitos dos Eventos de Verificação (EVs).

## 2. Arquitetura e Padrões

O backend é uma aplicação **Hono** rodando em **Supabase Edge Functions**, servindo como uma API REST para o frontend. A arquitetura é modular e segue padrões consistentes.

- **Ponto de Entrada:** `supabase/functions/server/index.tsx` monta todos os módulos de rotas.
- **Fábrica de CRUD:** O arquivo `crud-factory.ts` é o coração do backend. Ele gera dinamicamente rotas `GET` (lista e por ID), `POST`, `PUT` e `DELETE` para as tabelas do banco de dados, o que reduz drasticamente o código repetitivo.
- **Módulos de Rotas:** A lógica é dividida em 7 arquivos de rotas temáticos (ex: `routes-content.tsx`, `routes-student.tsx`, `routes-study.tsx`), cada um responsável por um conjunto de endpoints.
- **Autenticação:** Centralizada no arquivo `db.ts`.

## 3. Autenticação: O Mecanismo de "Duplo Token"

O sistema de autenticação é robusto e seguro, utilizando uma convenção de dois tokens em headers diferentes:

1.  **`Authorization: Bearer <ANON_KEY>`**: Este header é **sempre** enviado e contém a chave anônima pública da Supabase. Sua função é unicamente para passar pela gateway da API da Supabase e permitir a execução da Edge Function.

2.  **`X-Access-Token: <USER_JWT>`**: Quando um usuário está logado, seu JSON Web Token (obtido via `supabase.auth`) é enviado neste header. É este token que o backend Hono utiliza para identificar o usuário e aplicar as políticas de RLS (Row-Level Security) no banco de dados.

Este padrão garante que as chamadas à API sejam autenticadas tanto na camada de infraestrutura da Supabase quanto na camada de aplicação.

## 4. Análise de Schemas e Rotas

A seguir, o detalhamento das tabelas e rotas mais críticas analisadas.

### 4.1. Usuários e Permissões (`profiles` e `memberships`)

- **`profiles`**: Tabela central que armazena dados básicos do usuário (nome, email, avatar). O campo `platform_role` distingue `user` de `platform_admin`.
- **`memberships`**: Tabela de junção que define o papel de um usuário em uma instituição. É aqui que se define se um usuário é `owner`, `admin`, `professor` ou `student`.
- **`admin_scopes`**: Tabela que define escopos granulares para administradores e professores (ex: acesso a um curso específico).

### 4.2. Conteúdo e Instrumentos de Avaliação

| Tabela | Rota CRUD | `createFields` (Campos Aceitos no POST) | Gaps Notáveis |
| :--- | :--- | :--- | :--- |
| `flashcards` | ✅ `/flashcards` | `keyword_id`, `front`, `back`, `source` | **`subtopic_id` ausente** |
| `quiz_questions` | ✅ `/quiz-questions` | `keyword_id`, `question_type`, `question`, `options`, `correct_answer`, `explanation`, `difficulty`, `source` | **`subtopic_id` e `quiz_id` ausentes** |
| `quizzes` | ❌ **NÃO EXISTE** | N/A | Tabela existe no DB, mas sem rota CRUD. |

### 4.3. Fluxo de Estudo e Algoritmos

- **`study_plans` / `study_plan_tasks`**: Possuem rotas CRUD completas e estão **100% integrados** com a `ScheduleView` do frontend.
- **`reviews`**: Tabela de log central. **Não possui** a coluna `response_time_ms`. Schema real: `id`, `session_id`, `item_id`, `instrument_type`, `grade`, `created_at`.
- **`bkt_states`**: Tabela para o algoritmo Bayesian Knowledge Tracing. Possui rotas `GET` e `POST` manuais. Está corretamente vinculada a `student_id` e `subtopic_id`.
- **`fsrs_states`**: Tabela para o algoritmo de Spaced Repetition (FSRS). Possui rotas `GET` e `POST` manuais. Está corretamente vinculada a `student_id` e `flashcard_id`.

### 4.4. Rotas de Inteligência Artificial (IA)

Há uma divergência crítica entre o backend real e o de prototipagem:

- **Backend Real (`axon-backend`):** As rotas existentes (`/ai-generations`, `/summary-diagnostics`) são apenas para **auditoria e log**. Elas registram que uma geração de IA ocorreu, mas não realizam a geração em si.
- **Backend de Prototipagem (`sseki-frontend`):** O frontend contém seu próprio mini-backend (`/supabase/functions/server/gemini.tsx`) que implementa as rotas de geração (`/ai/chat`, `/ai/flashcards`, etc.), provavelmente chamando um serviço como o Gemini diretamente.

## 5. Gaps Críticos e Inconsistências (Resumo)

As investigações revelaram 3 gaps principais que impedem a implementação de certos EVs.

### 🔴 GAP 1: `subtopic_id` e `quiz_id` Ignorados pela API

- **Problema:** As colunas `subtopic_id` e `quiz_id` existem nas tabelas `flashcards` e `quiz_questions`, mas não estão incluídas nos `createFields` da fábrica de CRUD no arquivo `routes-student.tsx`.
- **Impacto:**
    - **EV-5 (BKT por Subtopic):** Impossível de implementar. O sistema BKT depende de saber qual `subtopic_id` uma `quiz_question` representa para atualizar o `bkt_state` correto. Sem isso, o algoritmo não funciona.
    - **Agrupamento de Quizzes:** Impossível vincular uma `quiz_question` a um `quiz` pai.
- **Correção:** Adicionar `"subtopic_id"` e `"quiz_id"` aos arrays `createFields` e `updateFields` correspondentes em `routes-student.tsx`.

### 🔴 GAP 2: Tabela `quizzes` Inacessível via API

- **Problema:** A tabela `quizzes` existe no banco de dados, mas não há nenhuma rota CRUD (`/quizzes`) exposta no backend.
- **Impacto:** O fluxo de "criar um quiz → adicionar perguntas a ele" (parte do EV-3) é impossível. As perguntas de quiz existem de forma isolada, sem um contêiner que as agrupe.
- **Correção:** Adicionar um novo `registerCrud` para a tabela `quizzes` em `routes-student.tsx` ou `routes-content.tsx`.

### 🔴 GAP 3: Rotas de Geração de IA Descentralizadas

- **Problema:** A lógica de geração de conteúdo por IA (chat, flashcards, etc.) não reside no backend principal, mas sim em um backend de prototipagem dentro do próprio repositório do frontend.
- **Impacto:** O EV-6 (IA) não pode ser implementado de forma escalável e segura. A arquitetura atual cria uma dependência indesejada e dificulta a gestão de chaves de API e o monitoramento.
- **Correção:** Migrar a lógica de `gemini.tsx` (do `sseki-frontend`) para um novo módulo de rotas (ex: `routes-ai.tsx`) dentro do backend principal (`axon-backend`).

## 6. Conclusão Geral

O backend do Axon é bem estruturado, maduro e consistente, com um uso inteligente da fábrica de CRUD para acelerar o desenvolvimento. A maioria das funcionalidades está implementada e alinhada com as necessidades do frontend.

Os gaps identificados, embora críticos para os EVs específicos, são cirúrgicos e relativamente simples de corrigir, exigindo apenas pequenas adições de configuração nos arquivos de rotas existentes. A correção desses pontos desbloqueará o progresso dos EVS e solidificará a arquitetura para futuras expansões.
