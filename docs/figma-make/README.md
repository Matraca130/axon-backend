# Figma Make API Reference Blocks

This directory contains **copy-paste blocks** for Figma Make sessions. Each file is a self-contained prompt that tells Figma Make how to connect to the Axon backend and which routes are available for that area.

## How to use

1. Open a new Figma Make session
2. **Always paste `00-contexto-base.md` first** (or use a block that already includes it)
3. Then paste the specific area block you need
4. Tell Figma Make what to build

## Blocks

| File | Area | Routes | Use for |
|---|---|---|---|
| `00-contexto-base.md` | Context | - | Always paste first. Connection, auth, patterns |
| `01-area-profesor.md` | Professor | 82 | Content creation: summaries, flashcards, quizzes, 3D models |
| `02-area-alumno.md` | Student | 56 | Study: notes, quizzes, spaced repetition, statistics |
| `03-area-admin.md` | Admin/Owner | 41 | Institutions, memberships, plans, subscriptions, AI logs |
| `04-foco-resumenes.md` | Focus: Summaries | 38 | Summary viewer/editor with chunks, keywords, flashcards |
| `05-foco-estudio.md` | Focus: Study | 30 | Study sessions, FSRS, BKT, daily activities, stats |

> **Note:** Blocks 01-05 already include the context from block 00, so you don't need to paste both. Just paste the one you need.

## Response format distinction

- **Factory CRUD routes** return paginated: `{ "data": { "items": [...], "total": N, "limit": N, "offset": N } }`
- **Custom routes** return flat arrays: `{ "data": [...] }`
- **Single-object routes** return: `{ "data": { ... } }` or `{ "data": null }`

See each block file for the complete list of which routes use which format.
