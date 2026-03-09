/**
 * routes/whatsapp/wa-client.ts — Meta WhatsApp Cloud API client
 *
 * Typed wrapper around Meta Graph API v21.0 for sending WhatsApp messages.
 * All send* functions are fire-and-forget safe (log errors, never throw).
 *
 * P2 FIX: Uses own fetchWithTimeout (simpler, no retry) rather than
 * gemini.ts fetchWithRetry (exported since N3, but includes retry logic
 * inappropriate for Meta API — retrying sends could cause duplicate
 * WhatsApp messages). Meta has 99.95% SLA, simple timeout is sufficient.
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

// ─── Fetch with Timeout ──────────────────────────────────

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
  title: string;
}

export interface ListRowDef {
  id: string;
  title: string;
  description?: string;
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

export async function sendText(phone: string, text: string): Promise<void> {
  await sendMessage({
    to: phone,
    type: "text",
    text: { body: text.slice(0, 4096) },
  });
}

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

export async function downloadMedia(mediaId: string): Promise<MediaDownloadResult> {
  const token = getAccessToken();

  const metaRes = await fetchWithTimeout(
    `${META_BASE_URL}/${mediaId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!metaRes.ok) {
    throw new Error(`[WA-Client] Media metadata failed (${metaRes.status})`);
  }

  const meta = await metaRes.json() as { url: string; mime_type: string };

  const dataRes = await fetchWithTimeout(
    meta.url,
    { headers: { Authorization: `Bearer ${token}` } },
    30_000,
  );

  if (!dataRes.ok) {
    throw new Error(`[WA-Client] Media download failed (${dataRes.status})`);
  }

  return {
    buffer: await dataRes.arrayBuffer(),
    mimeType: meta.mime_type,
  };
}

export async function hashPhone(phone: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(phone + salt);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateSalt(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
