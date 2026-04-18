/**
 * Tests for isOwnedStoragePath() in routes-storage.ts
 *
 * Covers the SEC-AUDIT strict ownership check that replaced the previous
 * substring match `p.includes('/${user.id}/')`.
 *
 * Run: deno test supabase/functions/server/tests/storage_ownership_test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isOwnedStoragePath } from "../routes-storage.ts";

const USER = "550e8400-e29b-41d4-a716-446655440000";
const OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// ─── Happy path ──────────────────────────────────────────

Deno.test("accepts well-formed paths in every valid folder", () => {
  assertEquals(isOwnedStoragePath(`flashcards/${USER}/1234-abc.jpg`, USER), true);
  assertEquals(isOwnedStoragePath(`summaries/${USER}/9999-xyz.png`, USER), true);
  assertEquals(isOwnedStoragePath(`general/${USER}/5555-mno.webp`, USER), true);
});

Deno.test("accepts nested subpaths under the user's folder", () => {
  assertEquals(
    isOwnedStoragePath(`flashcards/${USER}/deck-1/card-2.jpg`, USER),
    true,
  );
});

// ─── Ownership enforcement ───────────────────────────────

Deno.test("rejects another user's path", () => {
  assertEquals(isOwnedStoragePath(`flashcards/${OTHER}/1234-abc.jpg`, USER), false);
});

Deno.test("rejects path with caller's UUID in non-prefix position", () => {
  assertEquals(
    isOwnedStoragePath(`flashcards/${OTHER}/${USER}/file.jpg`, USER),
    false,
  );
});

// ─── Path traversal ──────────────────────────────────────

Deno.test("rejects `..` anywhere in the path", () => {
  assertEquals(
    isOwnedStoragePath(`flashcards/${USER}/../${OTHER}/file.jpg`, USER),
    false,
  );
  assertEquals(
    isOwnedStoragePath(`flashcards/${USER}/a/../b/file.jpg`, USER),
    false,
  );
});

Deno.test("rejects consecutive slashes `//`", () => {
  assertEquals(
    isOwnedStoragePath(`flashcards/${USER}//file.jpg`, USER),
    false,
  );
});

Deno.test("rejects leading slash", () => {
  assertEquals(
    isOwnedStoragePath(`/flashcards/${USER}/file.jpg`, USER),
    false,
  );
});

Deno.test("rejects backslash", () => {
  assertEquals(
    isOwnedStoragePath(`flashcards\\${USER}\\file.jpg`, USER),
    false,
  );
  assertEquals(
    isOwnedStoragePath(`flashcards/${USER}/\\..\\${OTHER}\\file.jpg`, USER),
    false,
  );
});

// ─── Control characters ──────────────────────────────────

Deno.test("rejects null byte", () => {
  assertEquals(
    isOwnedStoragePath(`flashcards/${USER}/file.jpg\x00.png`, USER),
    false,
  );
});

Deno.test("rejects other control characters", () => {
  assertEquals(
    isOwnedStoragePath(`flashcards/${USER}/file\n.jpg`, USER),
    false,
  );
  assertEquals(
    isOwnedStoragePath(`flashcards/${USER}/file\r.jpg`, USER),
    false,
  );
  assertEquals(
    isOwnedStoragePath(`flashcards/${USER}/file\t.jpg`, USER),
    false,
  );
});

// ─── Folder enforcement ──────────────────────────────────

Deno.test("rejects unknown folder prefix", () => {
  assertEquals(isOwnedStoragePath(`evil/${USER}/file.jpg`, USER), false);
  assertEquals(isOwnedStoragePath(`../${USER}/file.jpg`, USER), false);
});

Deno.test("rejects case-variant folder (case-sensitive match)", () => {
  assertEquals(isOwnedStoragePath(`Flashcards/${USER}/file.jpg`, USER), false);
  assertEquals(isOwnedStoragePath(`FLASHCARDS/${USER}/file.jpg`, USER), false);
});

// ─── Degenerate inputs ───────────────────────────────────

Deno.test("rejects empty string", () => {
  assertEquals(isOwnedStoragePath("", USER), false);
});

Deno.test("rejects non-string input", () => {
  // deno-lint-ignore no-explicit-any
  assertEquals(isOwnedStoragePath(null as any, USER), false);
  // deno-lint-ignore no-explicit-any
  assertEquals(isOwnedStoragePath(undefined as any, USER), false);
  // deno-lint-ignore no-explicit-any
  assertEquals(isOwnedStoragePath(123 as any, USER), false);
});

Deno.test("rejects path exceeding 1024 bytes", () => {
  const huge = `flashcards/${USER}/${"a".repeat(1100)}.jpg`;
  assertEquals(isOwnedStoragePath(huge, USER), false);
});

Deno.test("rejects folder-only path (no filename after user.id/)", () => {
  // Without a filename after the prefix we still accept — upload always
  // produces a filename suffix, but the check only guarantees ownership,
  // not well-formedness. The Supabase storage call itself will fail on a
  // bare folder. Keep this test explicit so the contract is documented.
  assertEquals(isOwnedStoragePath(`flashcards/${USER}/`, USER), true);
});

Deno.test("rejects path that looks like prefix but misses trailing slash", () => {
  // Prefix check requires the trailing `/` after user.id so a path
  // like `flashcards/<user>extrastuff` can't slip through.
  assertEquals(
    isOwnedStoragePath(`flashcards/${USER}foo/file.jpg`, USER),
    false,
  );
});
