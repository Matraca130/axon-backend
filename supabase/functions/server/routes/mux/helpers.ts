/**
 * routes/mux/helpers.ts — Mux shared utilities
 *
 * Exports:
 *   MUX_BASE, muxAuth         — API config
 *   muxFetch(path, opts)       — Call Mux REST API
 *   verifyMuxWebhook(body,sig) — HMAC-SHA256 signature verification
 *   buildPlaybackJwt(id, aud)  — RS256 signed playback token
 *   fireFirstCompletionSignal  — BKT/FSRS signal on first video completion
 */

const MUX_TOKEN_ID          = Deno.env.get("MUX_TOKEN_ID") ?? "";
const MUX_TOKEN_SECRET      = Deno.env.get("MUX_TOKEN_SECRET") ?? "";
const MUX_WEBHOOK_SECRET    = Deno.env.get("MUX_WEBHOOK_SECRET") ?? "";
const MUX_SIGNING_KEY_ID    = Deno.env.get("MUX_SIGNING_KEY_ID") ?? "";
const MUX_SIGNING_KEY_SECRET = Deno.env.get("MUX_SIGNING_KEY_SECRET") ?? "";

export const MUX_BASE = "https://api.mux.com";
export const muxAuth  = `Basic ${btoa(`${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}`)}`;

export async function muxFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(`${MUX_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: muxAuth,
        ...(options.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyMuxWebhook(
  body: string,
  signature: string | null,
): Promise<boolean> {
  if (!signature || !MUX_WEBHOOK_SECRET) return false;
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(MUX_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
    );
    const parts = Object.fromEntries(
      signature.split(",").map((p) => p.split("=")),
    );
    const timestamp = parts["t"];
    const v1 = parts["v1"];
    if (!timestamp || !v1) return false;

    // SEC: Reject stale webhooks (>5 min) to prevent replay attacks
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - parseInt(timestamp, 10)) > 300) return false;

    const signedPayload = `${timestamp}.${body}`;
    const sigBytes = new Uint8Array(
      v1.match(/.{2}/g)!.map((b) => parseInt(b, 16)),
    );
    return await crypto.subtle.verify(
      "HMAC", key, sigBytes, encoder.encode(signedPayload),
    );
  } catch {
    return false;
  }
}

export async function buildPlaybackJwt(
  playbackId: string,
  aud: "v" | "t" | "s" = "v",
): Promise<string> {
  const binaryDer = Uint8Array.from(atob(MUX_SIGNING_KEY_SECRET), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );

  const header = { alg: "RS256", typ: "JWT", kid: MUX_SIGNING_KEY_ID };
  const payload = {
    sub: playbackId, aud,
    exp: Math.floor(Date.now() / 1000) + 3600,
    kid: MUX_SIGNING_KEY_ID,
  };

  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const headerB64  = encode(header);
  const payloadB64 = encode(payload);
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput),
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  return `${signingInput}.${sigB64}`;
}

export async function fireFirstCompletionSignal(
  db: any, userId: string, videoId: string,
): Promise<void> {
  try {
    const { data: videoRow } = await db
      .from("videos").select("summary_id").eq("id", videoId).single();

    if (videoRow?.summary_id) {
      await db.from("reading_states").upsert(
        { student_id: userId, summary_id: videoRow.summary_id, completed: true, updated_at: new Date().toISOString() },
        { onConflict: "student_id,summary_id" },
      ).maybeSingle();
    }
  } catch (e) {
    console.warn(`[mux/track-view] First completion signal failed: ${(e as Error).message}`);
  }
}
