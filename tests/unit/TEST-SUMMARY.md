# Unit Tests Summary — Backend Utilities

Created 2026-04-04. All 94 tests passing.

## Test Files Created

### 1. telegram-formatter.test.ts (25 tests, 13K)

Tests for `/supabase/functions/server/routes/telegram/formatter.ts`

**Exports Tested:**
- `formatFlashcardSummary()` — 6 tests
- `formatProgressSummary()` — 3 tests
- `formatScheduleSummary()` — 4 tests
- `formatBrowseContent()` — 4 tests
- `formatKeywordDetail()` — 2 tests
- `formatSummaryPreview()` — 2 tests
- `truncateForTelegram()` — 4 tests

**Coverage:**
- Empty/null inputs
- Card grouping by course
- Preview truncation (60-char limit)
- Mastery bars and icons
- Schedule period handling (day/week)
- Content browsing (courses/sections/keywords)
- 4096 char limit enforcement
- Newline-aware truncation

### 2. whatsapp-formatter.test.ts (20 tests, 7.8K)

Tests for `/supabase/functions/server/routes/whatsapp/formatter.ts`

**Exports Tested:**
- `formatFlashcardSummary()` — 5 tests (no bold formatting)
- `formatProgressSummary()` — 3 tests (no bold/italic)
- `formatScheduleSummary()` — 4 tests (no strikethrough)
- `formatBrowseContent()` — 4 tests (no bold markup)

**Key Differences from Telegram:**
- Verifies absence of Markdown bold (`*text*`)
- Verifies absence of italic markup (`_text_`)
- Verifies absence of strikethrough (`~text~`)
- Same functionality, stripped-down formatting

### 3. block-flatten.test.ts (24 tests, 12K)

Tests for `/supabase/functions/server/block-flatten.ts`

**Function Tested:**
- `flattenBlocksToMarkdown()`

**Block Types Covered (12 types):**
1. prose — heading + body with keyword stripping
2. key_point — CONCEPTO CLAVE + importance
3. stages — bullet-list from items array
4. comparison — markdown table generation
5. list_detail — term-detail pairs
6. grid — labeled items
7. two_column — left/right sections
8. callout — variant + title + body
9. image_reference — placeholder with alt text
10. section_divider — dashed separators
11. text (legacy) — HTML stripping
12. heading (legacy) — hash-prefixed titles

**Coverage:**
- Keyword marker stripping (`{{keyword}}` → `keyword`)
- HTML tag removal for legacy types
- Empty/null content handling
- Block sorting by order_index
- NaN/Infinity handling
- Unknown type JSON fallback
- Separator insertion (`\n\n---\n\n`)
- Mixed legacy + modern type documents

### 4. block-keywords.test.ts (25 tests, 12K)

Tests for `/supabase/functions/server/lib/block-keywords.ts`

**Functions Tested:**
- `extractKeywordsFromBlock()` — 15 tests
- `calculateBlockMastery()` — 10 tests

**Extract Coverage (all block types):**
- prose, text (legacy) — body field
- key_point — title + explanation
- callout — title + body
- two_column — left + right fields
- stages — items[].{title, description}
- list_detail — items[].{title, detail}
- comparison — items[].{title, description}
- grid — cells[].{title, body}
- heading — text field
- unknown types — fallback scanning

**Mastery Calculation Coverage:**
- Basic averaging (3 keywords → 3 subtopics → avg p_know)
- No keywords → -1 sentinel
- Missing keyword mappings → -1 sentinel
- Case-insensitive keyword matching (Dopamine ↔ dopamine)
- Multiple blocks in batch
- 4-decimal rounding
- Boundary values (0 and 1)
- Duplicate keyword handling
- Missing subtopic p_know values (filtered out)

## Test Execution

All tests use Deno `std@0.224.0/assert` with proper environment variables:
```bash
SUPABASE_URL=http://localhost:54321
SUPABASE_ANON_KEY=test-anon-key
SUPABASE_SERVICE_ROLE_KEY=test-service-role-key
```

Run individual tests:
```bash
deno test tests/unit/telegram-formatter.test.ts --allow-env --allow-read --allow-net --no-check
deno test tests/unit/whatsapp-formatter.test.ts --allow-env --allow-read --allow-net --no-check
deno test tests/unit/block-flatten.test.ts --allow-env --allow-read --allow-net --no-check
deno test tests/unit/block-keywords.test.ts --allow-env --allow-read --allow-net --no-check
```

Run all 4 together:
```bash
deno test tests/unit/{telegram,whatsapp,block-flatten,block-keywords}*.test.ts --allow-env --allow-read --allow-net --no-check
```

## Test Results

- **telegram-formatter.test.ts**: 25/25 passing
- **whatsapp-formatter.test.ts**: 20/20 passing
- **block-flatten.test.ts**: 24/24 passing
- **block-keywords.test.ts**: 25/25 passing

**Total: 94/94 tests passing** (284ms wall time)

## Notes

- No database dependencies (all pure logic/formatting utilities)
- Tests are framework-agnostic (pure Deno + std assertions)
- All edge cases covered: null/empty inputs, truncation limits, case sensitivity
- Existing `supabase/functions/server/tests/block-flatten.test.ts` has 29 tests (TDD phase); these 24 tests are in the proper unit test location
- No mocking required (all functions deterministic)
