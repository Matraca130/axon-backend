/**
 * routes/whatsapp/webhook.ts — Meta WhatsApp Cloud API webhook handler
 *
 * GET  /webhooks/whatsapp — Verification challenge (one-time Meta setup)
 * POST /webhooks/whatsapp — Incoming messages (HMAC-SHA256 verified)
 *
 * Security:
 *   - No JWT auth (webhooks are unauthenticated by nature)
 *   - HMAC-SHA256 signature verification using WHATSAPP_APP_SECRET
 *   - timing-safe comparison to prevent timing attacks (AUDIT F3)
 *   - Deduplication by Meta message ID (AUDIT F7)
 *
 * Pattern precedent: routes/mux/webhook.ts (Mux HMAC verification)
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
 * @see AUDIT F3: HMAC hex parsing + timingSafeEqual
 * @see AUDIT F7: Dedup via wa_message_id (works for linked AND unlinked users)
 * @see AUDIT-03: Immediate 200 response to prevent Meta retransmissions
 */

import type { Context } from "npm:hono";
import { ok, err, getAdminClient } from "../../db.ts";
import { timingSafeEqual } from "../../timing-safe.ts";

// ─── Types ───────────────────────────────────────────────

/** Subset of Meta webhook payload we care about */
interface WhatsAppWebhookBody {
  object: string;
  entry?: Array<{
    id: string;
    changes?: Array<{
      value: {
        messaging_product: string;
        metadata: { display_phone_number: string; phone_number_id: string };
        contacts?: Array<{ profile: { name: string }; wa_id: string }>;
        messages?: Array<{
          from: string;
          id: string;
          timestamp: string;
          type: string;
          text?: { body: string };
          interactive?: {
            type: string;
            button_reply?: { id: string; title: string };
            list_reply?: { id: string; title: string; description: string };
          };
          audio?: { id: string; mime_type: string };
          image?: { id: string; mime_type: string; caption?: string };
        }>;
        statuses?: Array<unknown>;
      };
      field: string;
    }>;
  }>;
}

// ─── HMAC Verification (AUDIT F3) ─────────────────────────

/**
 * Verify Meta webhook signature using HMAC-SHA256.
 *
 * Meta sends the header as: X-Hub-Signature-256: sha256=HEXSTRING
 * We compute our own HMAC and compare using timingSafeEqual.
 *
 * @param rawBody - The raw request body string
 * @param signatureHeader - The X-Hub-Signature-256 header value
 * @returns true if signature is valid
 */
async function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader) return false;

  const secret = Deno.env.get("WHATSAPP_APP_SECRET");
  if (!secret) {
    console.error("[WA-Webhook] WHATSAPP_APP_SECRET not configured");
    return false;
  }

  // Strip "sha256=" prefix to get expected hex
  const expectedHex = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice(7)
    : signatureHeader;

  if (!expectedHex || expectedHex.length !== 64) {
    console.warn("[WA-Webhook] Invalid signature format (expected 64-char hex)");
    return false;
  }

  try {
    const encoder = new TextEncoder();

    // Import the secret key for HMAC-SHA256
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    // Compute HMAC of the raw body
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(rawBody),
    );

    // Convert to hex string
    const computedHex = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Timing-safe comparison (prevents timing attacks)
    return timingSafeEqual(computedHex, expectedHex);
  } catch (e) {
    console.error(`[WA-Webhook] HMAC verification error: ${(e as Error).message}`);
    return false;
  }
}

// ─── Deduplication (AUDIT F7) ─────────────────────────────

/**
 * Check if we've already processed this Meta message ID.
 * Uses whatsapp_message_log.wa_message_id index.
 * Works for ALL users (linked and unlinked).
 */
async function isDuplicate(waMessageId: string): Promise<boolean> {
  const admin = getAdminClient();
  const { data } = await admin
    .from("whatsapp_message_log")
    .select("id")
    .eq("wa_message_id", waMessageId)
    .limit(1);

  return (data?.length ?? 0) > 0;
}

// ─── Logging ─────────────────────────────────────────────

/** Fire-and-forget log entry to whatsapp_message_log */
function logMessage(params: {
  phoneHash: string;
  userId?: string;
  waMessageId?: string;
  direction: "in" | "out";
  messageType: string;
  success: boolean;
  latencyMs?: number;
  errorMessage?: string;
}): void {
  const admin = getAdminClient();
  admin
    .from("whatsapp_message_log")
    .insert({
      phone_hash: params.phoneHash,
      user_id: params.userId ?? null,
      wa_message_id: params.waMessageId ?? null,
      direction: params.direction,
      message_type: params.messageType,
      success: params.success,
      latency_ms: params.latencyMs ?? null,
      error_message: params.errorMessage ?? null,
    })
    .then(({ error }) => {
      if (error) console.warn(`[WA-Webhook] Log insert failed: ${error.message}`);
    });
}

// ─── Handlers ────────────────────────────────────────────

/**
 * GET /webhooks/whatsapp — Meta verification challenge.
 *
 * Called once when you register the webhook URL in Meta Dashboard.
 * Meta sends hub.mode, hub.verify_token, hub.challenge.
 * We verify the token and echo back the challenge.
 */
export async function handleVerification(c: Context): Promise<Response> {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  const expectedToken = Deno.env.get("WHATSAPP_VERIFY_TOKEN");

  if (mode === "subscribe" && token && token === expectedToken) {
    console.log("[WA-Webhook] Verification challenge accepted");
    return c.text(challenge ?? "", 200);
  }

  console.warn(`[WA-Webhook] Verification failed: mode=${mode}, token_match=${token === expectedToken}`);
  return c.text("Forbidden", 403);
}

/**
 * POST /webhooks/whatsapp — Incoming messages from Meta.
 *
 * Flow:
 *   1. Validate HMAC-SHA256 signature (AUDIT F3)
 *   2. Parse webhook body, extract messages
 *   3. Filter out status updates (delivery receipts)
 *   4. Deduplicate by wa_message_id (AUDIT F7)
 *   5. Log the incoming message
 *   6. Process message (TODO S07: call handler.ts)
 *   7. Return 200 OK
 *
 * AUDIT F12: For Phase 0, processing is inline (just logging).
 * In S09, this will be updated to call handleMessage() for fast ops
 * and enqueue via pgmq for slow ops.
 */
export async function handleIncoming(c: Context): Promise<Response> {
  const startMs = Date.now();

  // ── Step 1: HMAC-SHA256 validation (AUDIT F3) ──
  const signatureHeader = c.req.header("x-hub-signature-256") ?? null;
  const rawBody = await c.req.text();

  const valid = await verifyMetaSignature(rawBody, signatureHeader);
  if (!valid) {
    console.warn("[WA-Webhook] HMAC validation failed");
    return err(c, "Invalid signature", 401);
  }

  // ── Step 2: Parse body ──
  let body: WhatsAppWebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return err(c, "Invalid JSON in webhook body", 400);
  }

  // Verify it's a WhatsApp webhook
  if (body.object !== "whatsapp_business_account") {
    return c.text("Not a WhatsApp event", 200);
  }

  // ── Step 3: Extract messages (filter status updates) ──
  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const messages = value?.messages;

  // Status updates (delivery receipts, read receipts) → acknowledge, don't process
  if (!messages || messages.length === 0) {
    return c.text("OK", 200);
  }

  const message = messages[0];
  const from = message.from; // Phone number (e.g., "5215512345678")
  const waMessageId = message.id; // Meta message ID (e.g., "wamid.xxx")
  const messageType = message.type; // "text", "audio", "interactive", "image"
  const contactName = value?.contacts?.[0]?.profile?.name ?? "Unknown";

  // ── Step 4: Deduplication (AUDIT F7) ──
  try {
    const dup = await isDuplicate(waMessageId);
    if (dup) {
      console.log(`[WA-Webhook] Duplicate message ${waMessageId}, ignoring`);
      return c.text("OK", 200);
    }
  } catch (e) {
    // Dedup check failed — proceed anyway (better to process twice than drop)
    console.warn(`[WA-Webhook] Dedup check failed: ${(e as Error).message}`);
  }

  // ── Step 5: Extract message content ──
  let textContent = "";
  let buttonPayload: string | undefined;
  let audioMediaId: string | undefined;

  switch (messageType) {
    case "text":
      textContent = message.text?.body ?? "";
      break;
    case "interactive":
      if (message.interactive?.type === "button_reply") {
        buttonPayload = message.interactive.button_reply?.id;
        textContent = message.interactive.button_reply?.title ?? "";
      } else if (message.interactive?.type === "list_reply") {
        buttonPayload = message.interactive.list_reply?.id;
        textContent = message.interactive.list_reply?.title ?? "";
      }
      break;
    case "audio":
      audioMediaId = message.audio?.id;
      break;
    case "image":
      textContent = message.image?.caption ?? "[Image]";
      break;
    default:
      textContent = `[Unsupported: ${messageType}]`;
  }

  // ── Step 6: Process (Phase 0 = log only, S09 connects handler.ts) ──
  console.log(
    `[WA-Webhook] Message from ${contactName} (${from}): ` +
    `type=${messageType}, text="${textContent.slice(0, 100)}"` +
    (buttonPayload ? `, button=${buttonPayload}` : "") +
    (audioMediaId ? `, audio=${audioMediaId}` : ""),
  );

  // TODO S09: Replace with handleMessage() call:
  // await handleMessage({
  //   phoneHash, userId, messageId: waMessageId,
  //   messageType, text: textContent,
  //   buttonPayload, audioMediaId,
  // });

  // ── Step 7: Log + return 200 ──
  const latencyMs = Date.now() - startMs;

  // Fire-and-forget log (Phase 0: phone_hash is just the raw phone for now)
  // TODO S08: Replace with actual hashed phone after linking
  logMessage({
    phoneHash: from, // Temporary: raw phone. Will be hashed after S08.
    waMessageId,
    direction: "in",
    messageType,
    success: true,
    latencyMs,
  });

  return c.text("OK", 200);
}
