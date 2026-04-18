/**
 * fetch-retry.ts — Shared fetch with timeout + exponential backoff retry.
 *
 * Used by both Claude and Gemini API callers. Different providers need
 * different retryable status sets (e.g. Claude retries on 529, Gemini
 * does not), so callers pass their own list.
 */

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxRetries = 3,
  retryableStatuses = [429, 503],
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (retryableStatuses.includes(res.status) && attempt < maxRetries) {
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        console.warn(`[HTTP] ${res.status}, retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new Error(`API timeout after ${timeoutMs}ms (attempt ${attempt + 1})`);
      }
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        console.warn(`[HTTP] Network error, retry ${attempt + 1}/${maxRetries}: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw new Error("fetchWithRetry: max retries exceeded");
}
