/**
 * routes/whatsapp/webhook.ts — Meta WhatsApp Cloud API webhook handler
 *
 * GET  /webhooks/whatsapp — Verification challenge (one-time Meta setup)
 * POST /webhooks/whatsapp — Incoming messages (HMAC-SHA256 verified)
 *
 * Security:
 *   - HMAC-SHA256 signature verification using WHATSAPP_APP_SECRET
 *   - timing-safe comparison to prevent timing attacks (AUDIT F3)
 *   - Deduplication by Meta message ID (AUDIT F7)
 *   - Per-phone rate limiting via wa-rate-limit.ts (S12)
 *
 * Audit fixes applied:
 *   B4: Unlinked users' phones hashed before storing
 *   B5: Meta message types normalized before INSERT
 *   C4: Rate limit message sent only on first_block
 *   C5: Dedup record inserted for rate-limited messages
 *   C6: Raw phone hashed before rate limit Map key
 */

import type { Context } from "npm:hono";
import { err, getAdminClient } from "../../db.ts";
import { timingSafeEqual } from "../../timing-safe.ts";
import { sendText, hashPhone } from "./wa-client.ts";
import { handleMessage } from "./handler.ts";
import { verifyLinkCode, isLinkingCode } from "./link.ts";
import { checkWhatsAppRateLimit, sendRateLimitMessage } from "./wa-rate-limit.ts";

// ─── Types ───────────────────────────────────────────────

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

// ─── HMAC Verification (AUDIT F3) ─────────────────────

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

// ─── Message Type Normalization (B5 FIX) ──────────────

function normalizeMessageType(metaType: string): string {
  switch (metaType) {
    case "interactive": return "button";
    case "audio": return "voice";
    case "text": return "text";
    case "image": return "image";
    default: return "text";
  }
}

// ─── Deduplication (AUDIT F7 + A9 FIX) ────────────────

async function isDuplicate(waMessageId: string): Promise<boolean> {
  const admin = getAdminClient();
  const { data } = await admin
    .from("whatsapp_message_log")
    .select("id")
    .eq("wa_message_id", waMessageId)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

async function insertDedupRecord(
  waMessageId: string,
  phoneHash: string,
  userId: string | null,
  messageType: string,
): Promise<void> {
  const admin = getAdminClient();
  try {
    await admin.from("whatsapp_message_log").insert({
      wa_message_id: waMessageId,
      phone_hash: phoneHash,
      user_id: userId,
      direction: "in",
      message_type: messageType,
      success: true,
    });
  } catch (e) {
    console.warn(`[WA-Webhook] Dedup record insert failed: ${(e as Error).message}`);
  }
}

// ─── Phone Lookup ─────────────────────────────────────

async function lookupLinkedUser(
  phoneNumber: string,
): Promise<{ userId: string; phoneHash: string } | null> {
  const admin = getAdminClient();

  const { data: links } = await admin
    .from("whatsapp_links")
    .select("user_id, phone_hash, phone_salt")
    .eq("is_active", true);

  if (!links || links.length === 0) return null;

  for (const link of links) {
    const computedHash = await hashPhone(phoneNumber, link.phone_salt);
    if (computedHash === link.phone_hash) {
      return { userId: link.user_id, phoneHash: link.phone_hash };
    }
  }

  return null;
}

// ─── Handlers ────────────────────────────────────────

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
    return c.text("OK", 200);
  }

  const message = messages[0];
  const from = message.from;
  const waMessageId = message.id;
  const messageType = message.type;
  const contactName = contacts?.[0]?.profile?.name ?? "Unknown";

  const dbMessageType = normalizeMessageType(messageType);

  // ── Step 4: Dedup check ──
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

  // ── Step 6: Route message ──
  try {
    const linked = await lookupLinkedUser(from);

    // C6 FIX: Always use hashed phone as rate limit key (never raw phone)
    const globalSalt = Deno.env.get("WHATSAPP_APP_SECRET") ?? "axon-global-salt";
    const rateLimitKey = linked
      ? linked.phoneHash
      : await hashPhone(from, globalSalt);

    // C4 FIX: Rate limit returns block type
    const rateLimitResult = checkWhatsAppRateLimit(rateLimitKey, !!linked);

    if (rateLimitResult !== "allowed") {
      console.warn(`[WA-Webhook] Rate limited (${rateLimitResult}): ${rateLimitKey.slice(0, 12)}...`);

      // C5 FIX: Insert dedup record even for rate-limited messages
      const phoneHashForLog = linked ? linked.phoneHash : rateLimitKey;
      await insertDedupRecord(waMessageId, phoneHashForLog, linked?.userId ?? null, dbMessageType);

      // C4 FIX: Only send rate-limit message on first block
      if (rateLimitResult === "first_block") {
        await sendRateLimitMessage(from);
      }

      return c.text("OK", 200);
    }

    if (linked) {
      await insertDedupRecord(waMessageId, linked.phoneHash, linked.userId, dbMessageType);

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
      // B4 FIX: Hash raw phone with global salt
      const anonPhoneHash = rateLimitKey; // Already hashed above for C6

      await insertDedupRecord(waMessageId, anonPhoneHash, null, dbMessageType);

      if (textContent && isLinkingCode(textContent)) {
        const result = await verifyLinkCode(from, textContent.trim());
        if (result.success) {
          await sendText(
            from,
            "¡Vinculado! Ya podés estudiar por WhatsApp \ud83c\udf89\n\n" +
            "Probá enviando:\n" +
            "\u2022 \"Qué debo estudiar?\"\n" +
            "\u2022 \"Cómo voy en mis cursos?\"\n" +
            "\u2022 O cualquier pregunta académica",
          );
        } else {
          await sendText(
            from,
            "Código inválido o expirado. \u274c\n\n" +
            "Generá uno nuevo desde la app en Configuración > WhatsApp.",
          );
        }
      } else {
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
    console.error(`[WA-Webhook] Processing error: ${(e as Error).message}`);
    try {
      await sendText(from, "Algo salió mal. Intentá de nuevo. \ud83d\ude14");
    } catch { /* can't send error message */ }
  }

  const latencyMs = Date.now() - startMs;
  console.log(`[WA-Webhook] Completed in ${latencyMs}ms`);

  return c.text("OK", 200);
}
