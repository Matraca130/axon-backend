/**
 * safe-error.ts — Sanitize error messages before sending to client.
 * Logs full error server-side, returns generic message to client.
 * Prevents leaking table names, constraint details, and DB schema.
 *
 * S-13 FIX: Error message sanitization.
 */
import type { Context } from "npm:hono";
import type { StatusCode } from "npm:hono/utils/http-status";

export function safeErr(
  c: Context,
  operation: string,
  error: { message?: string; code?: string } | null | undefined,
  status: StatusCode = 500,
): Response {
  // Log full error server-side for debugging
  const detail = error?.message ?? "unknown error";
  console.error(`[Axon] ${operation}: ${detail}`);

  // Return generic message to client — no internal details
  return c.json({ error: `${operation} failed` }, status);
}
