/**
 * tests/unit/search-helpers.test.ts — Unit tests for search utility functions
 *
 * 18 tests covering:
 * - escapeLike: SQL wildcard escaping for LIKE queries
 * - escapeOrQuote: Double-quote escaping for PostgREST or()
 * - batchResolvePaths: Async batch resolution of hierarchy paths (mocked)
 * - Edge cases: empty strings, special characters, unicode
 *
 * Run:
 *   cd /sessions/great-bold-mccarthy/mnt/petri/AXON\ PROJECTO/backend
 *   deno test tests/unit/search-helpers.test.ts --allow-env --no-check
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  escapeLike,
  escapeOrQuote,
  batchResolvePaths,
} from "../../supabase/functions/server/routes/search/helpers.ts";

// ─── Test Suite: escapeLike ─────────────────────────────────────

Deno.test("escapeLike: empty string returns empty string", () => {
  assertEquals(escapeLike(""), "");
});

Deno.test("escapeLike: normal text without wildcards", () => {
  const input = "hello world";
  assertEquals(escapeLike(input), input);
});

Deno.test("escapeLike: escapes % wildcard", () => {
  assertEquals(escapeLike("%"), "\\%");
});

Deno.test("escapeLike: escapes _ wildcard", () => {
  assertEquals(escapeLike("_"), "\\_");
});

Deno.test("escapeLike: escapes backslash", () => {
  assertEquals(escapeLike("\\"), "\\\\");
});

Deno.test("escapeLike: multiple wildcards in string", () => {
  const input = "test%query_with\\backslash";
  const expected = "test\\%query\\_with\\\\backslash";
  assertEquals(escapeLike(input), expected);
});

Deno.test("escapeLike: user input with SQL injection attempt", () => {
  const input = "test%' OR '1'='1";
  const expected = "test\\%' OR '1'='1"; // only % is escaped
  assertEquals(escapeLike(input), expected);
});

Deno.test("escapeLike: consecutive wildcards", () => {
  assertEquals(escapeLike("%%__\\"), "\\%\\%\\_\\_\\\\");
});

Deno.test("escapeLike: unicode characters are preserved", () => {
  const input = "café_%테스트";
  const expected = "café\\_\\%테스트";
  assertEquals(escapeLike(input), expected);
});

Deno.test("escapeLike: no escaping when no special chars", () => {
  const input = "simple search query";
  assertEquals(escapeLike(input), input);
});

// ─── Test Suite: escapeOrQuote ──────────────────────────────────

Deno.test("escapeOrQuote: empty string returns empty string", () => {
  assertEquals(escapeOrQuote(""), "");
});

Deno.test("escapeOrQuote: normal text without quotes", () => {
  const input = "simple string";
  assertEquals(escapeOrQuote(input), input);
});

Deno.test("escapeOrQuote: single double-quote", () => {
  assertEquals(escapeOrQuote('"'), '""');
});

Deno.test("escapeOrQuote: multiple double-quotes", () => {
  assertEquals(escapeOrQuote('say "hello" to "world"'), 'say ""hello"" to ""world""');
});

Deno.test("escapeOrQuote: quote at start", () => {
  assertEquals(escapeOrQuote('"test'), '""test');
});

Deno.test("escapeOrQuote: quote at end", () => {
  assertEquals(escapeOrQuote('test"'), 'test""');
});

Deno.test("escapeOrQuote: PostgREST or() filter string", () => {
  // Example: searching with filter value 'test"value'
  const input = 'name.eq.test"value';
  const expected = 'name.eq.test""value';
  assertEquals(escapeOrQuote(input), expected);
});

Deno.test("escapeOrQuote: unicode with quotes", () => {
  const input = 'título "especial" en español';
  const expected = 'título ""especial"" en español';
  assertEquals(escapeOrQuote(input), expected);
});

// ─── Test Suite: batchResolvePaths ──────────────────────────────

Deno.test("batchResolvePaths: empty arrays returns empty maps", async () => {
  const mockDb = {
    from: () => ({
      select: () => ({
        in: async () => ({ data: null }),
      }),
    }),
  };

  const result = await batchResolvePaths(mockDb, [], []);
  assertEquals(result.topicPathMap.size, 0);
  assertEquals(result.summaryPathMap.size, 0);
});

Deno.test("batchResolvePaths: deduplicates topic IDs", async () => {
  let queriedIds: string[] = [];
  const mockDb = {
    from: (table: string) => ({
      select: () => ({
        in: async (field: string, ids: string[]) => {
          if (table === "topics") {
            queriedIds = ids;
          }
          return { data: null };
        },
      }),
    }),
  };

  await batchResolvePaths(mockDb, ["id1", "id2", "id1", "id2"], []);
  // Should query with unique IDs only
  assertEquals(queriedIds.length, 2);
});

Deno.test("batchResolvePaths: resolves topic with full hierarchy", async () => {
  const mockDb = {
    from: (table: string) => ({
      select: () => ({
        in: async () => {
          if (table === "topics") {
            return {
              data: [
                {
                  id: "topic-1",
                  name: "Anatomy",
                  sections: {
                    name: "Section A",
                    semesters: {
                      name: "Sem 1",
                      courses: { name: "Course X" },
                    },
                  },
                },
              ],
            };
          }
          return { data: null };
        },
      }),
    }),
  };

  const result = await batchResolvePaths(mockDb, ["topic-1"], []);
  const path = result.topicPathMap.get("topic-1");
  // Code skips section, goes: course > semester > name
  assertEquals(path, "Course X > Sem 1 > Anatomy");
});

Deno.test("batchResolvePaths: resolves topic with partial hierarchy", async () => {
  const mockDb = {
    from: (table: string) => ({
      select: () => ({
        in: async () => {
          if (table === "topics") {
            return {
              data: [
                {
                  id: "topic-2",
                  name: "Biology",
                  sections: null, // no sections
                },
              ],
            };
          }
          return { data: null };
        },
      }),
    }),
  };

  const result = await batchResolvePaths(mockDb, ["topic-2"], []);
  const path = result.topicPathMap.get("topic-2");
  assertEquals(path, "Biology");
});

Deno.test("batchResolvePaths: resolves summary with full hierarchy", async () => {
  const mockDb = {
    from: (table: string) => ({
      select: () => ({
        in: async () => {
          if (table === "summaries") {
            return {
              data: [
                {
                  id: "summary-1",
                  title: "Immunology Guide",
                  topics: {
                    name: "Immunology",
                    sections: {
                      name: "Section B",
                      semesters: {
                        name: "Sem 2",
                        courses: { name: "Course Y" },
                      },
                    },
                  },
                },
              ],
            };
          }
          return { data: null };
        },
      }),
    }),
  };

  const result = await batchResolvePaths(mockDb, [], ["summary-1"]);
  const path = result.summaryPathMap.get("summary-1");
  // Code skips section, goes: course > semester > topic > title
  assertEquals(path, "Course Y > Sem 2 > Immunology > Immunology Guide");
});

Deno.test("batchResolvePaths: handles null data gracefully", async () => {
  const mockDb = {
    from: () => ({
      select: () => ({
        in: async () => ({ data: null }),
      }),
    }),
  };

  const result = await batchResolvePaths(mockDb, ["id1"], ["id2"]);
  assertEquals(result.topicPathMap.size, 0);
  assertEquals(result.summaryPathMap.size, 0);
});

Deno.test("batchResolvePaths: processes both topics and summaries in parallel", async () => {
  let topicCalled = false;
  let summaryCalled = false;

  const mockDb = {
    from: (table: string) => ({
      select: () => ({
        in: async () => {
          if (table === "topics") {
            topicCalled = true;
            return { data: [{ id: "t1", name: "Topic", sections: null }] };
          }
          if (table === "summaries") {
            summaryCalled = true;
            return { data: [{ id: "s1", title: "Summary", topics: null }] };
          }
          return { data: null };
        },
      }),
    }),
  };

  await batchResolvePaths(mockDb, ["t1"], ["s1"]);
  assertEquals(topicCalled, true);
  assertEquals(summaryCalled, true);
});

Deno.test("batchResolvePaths: resolves summary with no topics", async () => {
  const mockDb = {
    from: (table: string) => ({
      select: () => ({
        in: async () => {
          if (table === "summaries") {
            return {
              data: [
                {
                  id: "summary-3",
                  title: "Standalone Summary",
                  topics: null,
                },
              ],
            };
          }
          return { data: null };
        },
      }),
    }),
  };

  const result = await batchResolvePaths(mockDb, [], ["summary-3"]);
  const path = result.summaryPathMap.get("summary-3");
  assertEquals(path, "Standalone Summary");
});

Deno.test("batchResolvePaths: resolves topic with section but no semester", async () => {
  const mockDb = {
    from: (table: string) => ({
      select: () => ({
        in: async () => {
          if (table === "topics") {
            return {
              data: [
                {
                  id: "topic-partial",
                  name: "Partial Topic",
                  sections: {
                    name: "Section C",
                    semesters: null,
                  },
                },
              ],
            };
          }
          return { data: null };
        },
      }),
    }),
  };

  const result = await batchResolvePaths(mockDb, ["topic-partial"], []);
  const path = result.topicPathMap.get("topic-partial");
  assertEquals(path, "Partial Topic");
});

Deno.test("batchResolvePaths: resolves topic with section and semester but no course", async () => {
  const mockDb = {
    from: (table: string) => ({
      select: () => ({
        in: async () => {
          if (table === "topics") {
            return {
              data: [
                {
                  id: "topic-three-level",
                  name: "Three-Level Topic",
                  sections: {
                    name: "Section D",
                    semesters: {
                      name: "Sem 3",
                      courses: null,
                    },
                  },
                },
              ],
            };
          }
          return { data: null };
        },
      }),
    }),
  };

  const result = await batchResolvePaths(mockDb, ["topic-three-level"], []);
  const path = result.topicPathMap.get("topic-three-level");
  // No course, so just sem > name (section is skipped)
  assertEquals(path, "Sem 3 > Three-Level Topic");
});
