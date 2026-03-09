/**
 * routes/whatsapp/wa-client.ts — Meta WhatsApp Cloud API client
 *
 * Typed wrapper around Meta Graph API v21.0 for sending WhatsApp messages.
 * All send* functions are fire-and-forget safe (log errors, never throw).
 *
 * AUDIT F8: Uses own fetchWithTimeout because gemini.ts fetchWithRetry
 * is module-private. Meta API has 99.95% SLA, simple timeout is sufficient.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 */

// ─── Config ──────────────────────────────────────────────

const META_API_VERSION = "v21.0";
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;
const DEFAULT_TIMEOUT_MS = 10_000;

function getPhoneNumberId(): string {
  const id = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  if (!id) throw new Error("[WA-Client] WHATSAPP_PHONE_NUMBER_ID not configured");
  return id;
}

function getAccessToken(): string {
  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  if (!token) throw new Error("[WA-Client] WHATSAPP_ACCESS_TOKEN not configured");
  return token;
}

// ─── Fetch with Timeout (AUDIT F8) ────────────────────────

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ─── Types ──────────────────────────────────────────────

export interface ButtonDef {
  id: string;
  title: string; // max 20 chars (WhatsApp limit)
}

export interface ListRowDef {
  id: string;
  title: string;       // max 24 chars
  description?: string; // max 72 chars
}

export interface ListSectionDef {
  title: string;
  rows: ListRowDef[];
}

export interface MediaDownloadResult {
  buffer: ArrayBuffer;
  mimeType: string;
}

// ─── Internal Send Helper ─────────────────────────────────

async function sendMessage(body: Record<string, unknown>): Promise<void> {
  const phoneId = getPhoneNumberId();
  const token = getAccessToken();
  const url = `${META_BASE_URL}/${phoneId}/messages`;

  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        ...body,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[WA-Client] Send failed (${res.status}): ${errBody}`);
    }
  } catch (e) {
    console.error(`[WA-Client] Send error: ${(e as Error).message}`);
  }
}

// ─── Public API ──────────────────────────────────────────

/**
 * Send a plain text message.
 * Max body length: 4096 chars (WhatsApp limit).
 */
export async function sendText(phone: string, text: string): Promise<void> {
  await sendMessage({
    to: phone,
    type: "text",
    text: { body: text.slice(0, 4096) },
  });
}

/**
 * Send an interactive message with up to 3 reply buttons.
 * WhatsApp enforces max 3 buttons; this function validates.
 *
 * FC-04: Flashcard ratings use exactly 3 buttons [Fail / Good / Easy].
 */
export async function sendInteractiveButtons(
  phone: string,
  body: string,
  buttons: ButtonDef[],
): Promise<void> {
  if (buttons.length === 0 || buttons.length > 3) {
    console.error(`[WA-Client] Interactive buttons must be 1-3, got ${buttons.length}`);
    return;
  }

  await sendMessage({
    to: phone,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body.slice(0, 1024) },
      action: {
        buttons: buttons.map((btn) => ({
          type: "reply",
          reply: {
            id: btn.id.slice(0, 256),
            title: btn.title.slice(0, 20),
          },
        })),
      },
    },
  });
}

/**
 * Send an interactive list message.
 * Good for browse_content, get_schedule, etc.
 */
export async function sendInteractiveList(
  phone: string,
  body: string,
  buttonText: string,
  sections: ListSectionDef[],
): Promise<void> {
  await sendMessage({
    to: phone,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: body.slice(0, 1024) },
      action: {
        button: buttonText.slice(0, 20),
        sections: sections.map((section) => ({
          title: section.title.slice(0, 24),
          rows: section.rows.map((row) => ({
            id: row.id.slice(0, 200),
            title: row.title.slice(0, 24),
            ...(row.description && { description: row.description.slice(0, 72) }),
          })),
        })),
      },
    },
  });
}

/**
 * Send an image message with optional caption.
 * FC-06: Used for flashcards with images.
 */
export async function sendImage(
  phone: string,
  imageUrl: string,
  caption?: string,
): Promise<void> {
  await sendMessage({
    to: phone,
    type: "image",
    image: {
      link: imageUrl,
      ...(caption && { caption: caption.slice(0, 1024) }),
    },
  });
}

/**
 * Send a pre-approved template message.
 * WA-15: Used for proactive notifications (study reminders, etc.).
 * Template must be approved in Meta Business Manager first.
 */
export async function sendTemplate(
  phone: string,
  templateName: string,
  languageCode: string,
  parameters?: string[],
): Promise<void> {
  const components = parameters && parameters.length > 0
    ? [{
        type: "body",
        parameters: parameters.map((p) => ({ type: "text", text: p })),
      }]
    : undefined;

  await sendMessage({
    to: phone,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components && { components }),
    },
  });
}

/**
 * Download media from WhatsApp (voice messages, images, etc.).
 * Two-step process: get download URL, then fetch the actual bytes.
 *
 * AUDIT-12: Used by handle_voice_message tool for STT.
 */
export async function downloadMedia(mediaId: string): Promise<MediaDownloadResult> {
  const token = getAccessToken();

  // Step 1: Get the download URL
  const metaRes = await fetchWithTimeout(
    `${META_BASE_URL}/${mediaId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!metaRes.ok) {
    throw new Error(`[WA-Client] Media metadata failed (${metaRes.status})`);
  }

  const meta = await metaRes.json() as { url: string; mime_type: string };

  // Step 2: Download the actual media bytes
  const dataRes = await fetchWithTimeout(
    meta.url,
    { headers: { Authorization: `Bearer ${token}` } },
    30_000, // Voice/image can be large, allow 30s
  );

  if (!dataRes.ok) {
    throw new Error(`[WA-Client] Media download failed (${dataRes.status})`);
  }

  return {
    buffer: await dataRes.arrayBuffer(),
    mimeType: meta.mime_type,
  };
}

/**
 * Hash a phone number with a salt using SHA-256.
 * Returns hex string. Used for PII protection (AUDIT-05).
 *
 * The raw phone number is NEVER stored in the database.
 * Only hash + salt are persisted in whatsapp_links.
 */
export async function hashPhone(phone: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(phone + salt);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a cryptographically random salt for phone hashing.
 * 32 bytes (256 bits) of randomness, hex-encoded.
 */
export function generateSalt(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
