/**
 * lib/fetch-with-retry.ts — HTTP fetch with timeout + exponential backoff retry
 *
 * Centraliza la lógica de retry que estaba duplicada en claude-ai.ts y gemini.ts.
 * Configurable por proveedor: códigos de estado a reintentar y etiqueta de log.
 */

/**
 * Ejecuta un fetch con timeout (AbortController) y reintentos exponenciales.
 *
 * @param url           URL a fetchear
 * @param init          RequestInit (method, headers, body, etc.)
 * @param timeoutMs     Tiempo máximo por intento en ms
 * @param retryStatuses Códigos HTTP que disparan un reintento (ej. [429, 503])
 * @param label         Etiqueta para los logs (ej. "Claude", "Gemini")
 * @param maxRetries    Número máximo de reintentos (default: 3)
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  retryStatuses: number[],
  label: string,
  maxRetries = 3,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      if (retryStatuses.includes(res.status) && attempt < maxRetries) {
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        console.warn(
          `[${label}] ${res.status}, retry ${attempt + 1}/${maxRetries} in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return res;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new Error(
          `${label} API timeout after ${timeoutMs}ms (attempt ${attempt + 1})`,
        );
      }
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        console.warn(
          `[${label}] Network error, retry ${attempt + 1}/${maxRetries} in ${delay}ms: ${(e as Error).message}`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`${label}: max retries exceeded`);
}
