# Auditoria Completa do Backend Axon v4.5

**Data da Auditoria:** 23 de Fevereiro de 2026
**Ultima atualizacao:** 14 de Marco de 2026 (audit pass 6)

## 1. Introducao

Este documento consolida todas as descobertas da auditoria realizada no backend do projeto Axon.

## 2. Arquitetura e Padroes

- **Ponto de Entrada:** `index.ts` monta 16 modulos de rotas.
- **Fabrica de CRUD:** `crud-factory.ts` gera LIST/GET/POST/PUT/DELETE/RESTORE.
- **Modulos:** 10 split (`routes/`) + 6 flat (`routes-*.ts`). ~200+ endpoints.
- **Autenticacao:** Centralizada em `db.ts` (doble token).

## 3. Autenticacao: Mecanismo de "Duplo Token"

1. `Authorization: Bearer <ANON_KEY>` — Gateway Supabase
2. `X-Access-Token: <USER_JWT>` — Identifica o usuario

## 4. Modelos de IA

> **ATUALIZADO 2026-03-14:** Embeddings migrados de Gemini para OpenAI.

| Funcao | Modelo | Arquivo |
|---|---|---|
| Geracao de texto | Gemini 2.5 Flash | `gemini.ts` |
| Extracao de PDF | Gemini 2.5 Flash | `gemini.ts` |
| **Embeddings** | **OpenAI text-embedding-3-large (1536d)** | **`openai-embeddings.ts`** |

> `gemini.ts` `generateEmbedding()` lanca erro fatal (W7-RAG01).
> Impede insercao de vetores 768d em colunas pgvector 1536d.

## 5. Gaps Resolvidos

1. OK `subtopic_id` e `quiz_id` disponiveis na API
2. OK Tabela `quizzes` acessivel via CRUD
3. OK Rotas de geracao de IA migradas para o backend com pipeline RAG completo
4. OK Embeddings migrados para OpenAI 1536d (D57)

## 6. Divida Tecnica

- **RLS:** Desabilitado em flashcards, quiz_questions, quizzes. Backend enforce via `checkContentScope()`.
- **CORS:** Revertido a wildcard `"*"` para MVP (BUG-004).
- **JWT:** Decodificacao local sem verificacao criptografica. PostgREST mitiga.
