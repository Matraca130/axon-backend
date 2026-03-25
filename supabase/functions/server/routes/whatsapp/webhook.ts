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
 *   P1: Raw phone masked in console logs
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

// ─── PII Helpers ─────────────────────────────────────────

/** P1 FIX: Mask phone for logging — show country code + first digits only */
function maskPhone(phone: string): string {
  if (phone.length <= 4) return "****";
  return phone.slice(0, 4) + "****";
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

// ─── Phone Lookup (O(1) via phone_lookup_hash index) ──

/**
 * Compute the global lookup hash for a phone number.
 * Uses WHATSAPP_APP_SECRET as global salt (not per-user).
 * This hash is stored in whatsapp_links.phone_lookup_hash
 * and indexed for O(1) lookups instead of scanning all rows.
 */
export async function computeLookupHash(phoneNumber: string): Promise<string> {
  const secret = Deno.env.get("WHATSAPP_APP_SECRET");
  if (!secret) throw new Error("[WA] WHATSAPP_APP_SECRET not configured — cannot hash phone numbers");
  return await hashPhone(phoneNumber, secret);
}

async function lookupLinkedUser(
  phoneNumber: string,
): Promise<{ userId: string; phoneHash: string } | null> {
  const admin = getAdminClient();

  // O(1) lookup via indexed phone_lookup_hash column
  const lookupHash = await computeLookupHash(phoneNumber);

  const { data } = await admin
    .from("whatsapp_links")
    .select("user_id, phone_hash, phone_salt")
    .eq("phone_lookup_hash", lookupHash)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (data) {
    // Verify against the per-user-salted hash for extra safety
    const verified = await hashPhone(phoneNumber, data.phone_salt);
    if (verified === data.phone_hash) {
      return { userId: data.user_id, phoneHash: data.phone_hash };
    }
    console.warn("[WA-Webhook] Lookup hash matched but per-user hash verification failed");
  }

  // Fallback: scan for rows without phone_lookup_hash (pre-migration links)
  const { data: legacyLinks } = await admin
    .from("whatsapp_links")
    .select("user_id, phone_hash, phone_salt")
    .is("phone_lookup_hash", null)
    .eq("is_active", true);

  if (!legacyLinks || legacyLinks.length === 0) return null;

  for (const link of legacyLinks) {
    const computedHash = await hashPhone(phoneNumber, link.phone_salt);
    if (computedHash === link.phone_hash) {
      // Backfill the lookup hash for this link
      admin
        .from("whatsapp_links")
        .update({ phone_lookup_hash: lookupHash })
        .eq("phone_hash", link.phone_hash)
        .then(({ error }) => {
          if (error) console.warn(`[WA-Webhook] Backfill lookup hash failed: ${error.message}`);
          else console.warn(`[WA-Webhook] Backfilled phone_lookup_hash for user ${link.user_id}`);
        });

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
    console.warn("[WA-Webhook] Verification challenge accepted");
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
      console.warn(`[WA-Webhook] Duplicate ${waMessageId}, ignoring`);
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

  // P1 FIX: Mask phone number in logs to prevent PII exposure
  console.warn(
    `[WA-Webhook] ${contactName} (${maskPhone(from)}): type=${messageType}, ` +
    `text="${textContent.slice(0, 80)}"`,
  );

  // ── Step 6: Route message ──
  try {
    const linked = await lookupLinkedUser(from);

    const globalSalt = Deno.env.get("WHATSAPP_APP_SECRET");
    if (!globalSalt) throw new Error("[WA] WHATSAPP_APP_SECRET not configured — cannot hash phone numbers");
    const rateLimitKey = linked
      ? linked.phoneHash
      : await hashPhone(from, globalSalt);

    const rateLimitResult = checkWhatsAppRateLimit(rateLimitKey, !!linked);

    if (rateLimitResult !== "allowed") {
      console.warn(`[WA-Webhook] Rate limited (${rateLimitResult}): ${rateLimitKey.slice(0, 12)}...`);

      const phoneHashForLog = linked ? linked.phoneHash : rateLimitKey;
      await insertDedupRecord(waMessageId, phoneHashForLog, linked?.userId ?? null, dbMessageType);

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
      const anonPhoneHash = rateLimitKey;

      await insertDedupRecord(waMessageId, anonPhoneHash, null, dbMessageType);

      if (textContent && isLinkingCode(textContent)) {
        const result = await verifyLinkCode(from, textContent.trim());
        if (result.success) {
          await sendText(
            from,
            "\u00a1Vinculado! Ya pod\u00e9s estudiar por WhatsApp \ud83c\udf89\n\n" +
            "Prob\u00e1 enviando:\n" +
            "\u2022 \"Qu\u00e9 debo estudiar?\"\n" +
            "\u2022 \"C\u00f3mo voy en mis cursos?\"\n" +
            "\u2022 O cualquier pregunta acad\u00e9mica",
          );
        } else {
          await sendText(
            from,
            "C\u00f3digo inv\u00e1lido o expirado. \u274c\n\n" +
            "Gener\u00e1 uno nuevo desde la app en Configuraci\u00f3n > WhatsApp.",
          );
        }
      } else {
        await sendText(
          from,
          "\u00a1Hola! Soy Axon, tu asistente de estudio. \ud83d\udcda\n\n" +
          "Para empezar, vincul\u00e1 tu cuenta:\n" +
          "1\ufe0f\u20e3 Abr\u00ed axon.app/settings\n" +
          "2\ufe0f\u20e3 Toc\u00e1 \"Vincular WhatsApp\"\n" +
          "3\ufe0f\u20e3 Envi\u00e1me el c\u00f3digo de 6 d\u00edgitos ac\u00e1\n\n" +
          "\u00a1Listo! Despu\u00e9s pod\u00e9s preguntarme cualquier cosa.",
        );
      }
    }
  } catch (e) {
    console.error(`[WA-Webhook] Processing error: ${(e as Error).message}`);
    try {
      await sendText(from, "Algo sali\u00f3 mal. Intent\u00e1 de nuevo. \ud83d\ude14");
    } catch { /* can't send error message */ }
  }

  const latencyMs = Date.now() - startMs;
  console.warn(`[WA-Webhook] Completed in ${latencyMs}ms`);

  return c.text("OK", 200);
}
