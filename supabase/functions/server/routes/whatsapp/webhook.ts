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
 * Message routing (S09):
 *   - Linked users → handleMessage() from handler.ts
 *   - Unlinked users + 6-digit code → verifyLinkCode() from link.ts
 *   - Unlinked users + other → onboarding message
 *
 * AUDIT F12: Processing is inline (await handleMessage before return 200).
 * Meta allows up to 5s for response. Most ops complete in <3s.
 * Slow ops (generate_content, weekly_report) are handled by tools.ts
 * returning isAsync=true, which sends an immediate response to user.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
 */

import type { Context } from "npm:hono";
import { err, getAdminClient } from "../../db.ts";
import { timingSafeEqual } from "../../timing-safe.ts";
import { sendText, hashPhone } from "./wa-client.ts";
import { handleMessage } from "./handler.ts";
import { verifyLinkCode, isLinkingCode } from "./link.ts";

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

  const expectedHex = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice(7)
    : signatureHeader;

  if (!expectedHex || expectedHex.length !== 64) {
    console.warn("[WA-Webhook] Invalid signature format (expected 64-char hex)");
    return false;
  }

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
    const computedHex = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return timingSafeEqual(computedHex, expectedHex);
  } catch (e) {
    console.error(`[WA-Webhook] HMAC error: ${(e as Error).message}`);
    return false;
  }
}

// ─── Deduplication (AUDIT F7) ─────────────────────────────

async function isDuplicate(waMessageId: string): Promise<boolean> {
  const admin = getAdminClient();
  const { data } = await admin
    .from("whatsapp_message_log")
    .select("id")
    .eq("wa_message_id", waMessageId)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

// ─── Phone Lookup ───────────────────────────────────────

/**
 * Look up a linked user by phone number.
 * Must iterate through all links and re-hash because each link has its own salt.
 * This is O(n) on active links, but n is small (each user has max 1 link).
 */
async function lookupLinkedUser(
  phoneNumber: string,
): Promise<{ userId: string; phoneHash: string } | null> {
  const admin = getAdminClient();

  const { data: links } = await admin
    .from("whatsapp_links")
    .select("user_id, phone_hash, phone_salt")
    .eq("is_active", true);

  if (!links || links.length === 0) return null;

  // Try each salt until we find a matching hash
  for (const link of links) {
    const computedHash = await hashPhone(phoneNumber, link.phone_salt);
    if (computedHash === link.phone_hash) {
      return { userId: link.user_id, phoneHash: link.phone_hash };
    }
  }

  return null;
}

// ─── Handlers ────────────────────────────────────────────

/**
 * GET /webhooks/whatsapp — Meta verification challenge.
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

  console.warn(`[WA-Webhook] Verification failed: mode=${mode}`);
  return c.text("Forbidden", 403);
}

/**
 * POST /webhooks/whatsapp — Incoming messages from Meta.
 *
 * AUDIT F12: Processing is INLINE (await before return).
 * Meta allows 5s before retransmitting. Most ops complete in <3s.
 * Slow ops are handled at the tools layer (return isAsync=true + immediate user response).
 */
export async function handleIncoming(c: Context): Promise<Response> {
  const startMs = Date.now();

  // ── Step 1: HMAC validation ──
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
    return err(c, "Invalid JSON", 400);
  }

  if (body.object !== "whatsapp_business_account") {
    return c.text("Not a WhatsApp event", 200);
  }

  // ── Step 3: Extract messages ──
  const messages = body.entry?.[0]?.changes?.[0]?.value?.messages;
  const contacts = body.entry?.[0]?.changes?.[0]?.value?.contacts;

  if (!messages || messages.length === 0) {
    return c.text("OK", 200); // Status update, no message
  }

  const message = messages[0];
  const from = message.from;
  const waMessageId = message.id;
  const messageType = message.type;
  const contactName = contacts?.[0]?.profile?.name ?? "Unknown";

  // ── Step 4: Dedup ──
  try {
    if (await isDuplicate(waMessageId)) {
      console.log(`[WA-Webhook] Duplicate ${waMessageId}, ignoring`);
      return c.text("OK", 200);
    }
  } catch (e) {
    console.warn(`[WA-Webhook] Dedup check failed: ${(e as Error).message}`);
  }

  // ── Step 5: Extract content ──
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

  console.log(
    `[WA-Webhook] ${contactName} (${from}): type=${messageType}, ` +
    `text="${textContent.slice(0, 80)}"`,
  );

  // ── Step 6: Route message (S09) ──
  try {
    // Look up linked user
    const linked = await lookupLinkedUser(from);

    if (linked) {
      // ── LINKED USER: Call handler ──
      await handleMessage({
        phone: from,
        phoneHash: linked.phoneHash,
        userId: linked.userId,
        messageId: waMessageId,
        messageType: messageType as "text" | "audio" | "interactive",
        text: textContent || undefined,
        buttonPayload,
        audioMediaId,
      });
    } else {
      // ── UNLINKED USER ──
      if (textContent && isLinkingCode(textContent)) {
        // Attempt to verify linking code
        const result = await verifyLinkCode(from, textContent.trim());
        if (result.success) {
          await sendText(
            from,
            "¡Vinculado! Ya podés estudiar por WhatsApp \ud83c\udf89\n\n" +
            "Probá enviando:\n" +
            "• \"Qué debo estudiar?\"\n" +
            "• \"Cómo voy en mis cursos?\"\n" +
            "• O cualquier pregunta académica",
          );
        } else {
          await sendText(
            from,
            "Código inválido o expirado. \u274c\n\n" +
            "Generá uno nuevo desde la app en Configuración > WhatsApp.",
          );
        }
      } else {
        // Unknown user, send onboarding
        await sendText(
          from,
          "\u00a1Hola! Soy Axon, tu asistente de estudio. \ud83d\udcda\n\n" +
          "Para empezar, vinculá tu cuenta:\n" +
          "1\ufe0f\u20e3 Abrí axon.app/settings\n" +
          "2\ufe0f\u20e3 Tocá \"Vincular WhatsApp\"\n" +
          "3\ufe0f\u20e3 Enviáme el código de 6 dígitos acá\n\n" +
          "\u00a1Listo! Después podés preguntarme cualquier cosa.",
        );
      }
    }
  } catch (e) {
    // handleMessage or linking failed — log but don't propagate to Meta
    console.error(`[WA-Webhook] Processing error: ${(e as Error).message}`);
    // Best-effort error response
    try {
      await sendText(from, "Algo salió mal. Intentá de nuevo. \ud83d\ude14");
    } catch { /* can't send error message */ }
  }

  // ── Step 7: Return 200 ──
  const latencyMs = Date.now() - startMs;
  console.log(`[WA-Webhook] Completed in ${latencyMs}ms`);

  return c.text("OK", 200);
}
