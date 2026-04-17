/**
 * routes/whatsapp/link.ts — Phone linking flow
 *
 * N4 FIX: Linking code masked in logs (****XX instead of full 6 digits).
 * N7 FIX: Removed unused CODE_LENGTH constant.
 */

import type { Context } from "npm:hono";
import { authenticate, ok, err, getAdminClient } from "../../db.ts";
import { hashPhone, generateSalt, sendText } from "./wa-client.ts";
import { computeLookupHash } from "./webhook.ts";

// ─── Constants ───────────────────────────────────────────

const CODE_EXPIRY_SECONDS = 300; // 5 minutes
const CODE_LENGTH = 10;          // SEC-AUDIT FIX: aligned with Telegram linking.
                                 // Although WhatsApp ingress is gated by Meta HMAC,
                                 // bumping entropy removes brute-force risk as
                                 // defense-in-depth.

// ─── Code Generation ─────────────────────────────────────

function generateCode(): string {
  const max = 10_000_000_000n; // 10^10
  const limit = (1n << 64n) - ((1n << 64n) % max);
  while (true) {
    const buf = new Uint32Array(2);
    crypto.getRandomValues(buf);
    const value = (BigInt(buf[0]) << 32n) | BigInt(buf[1]);
    if (value < limit) {
      return (value % max).toString().padStart(CODE_LENGTH, "0");
    }
  }
}

// ─── Web Endpoint: Generate Link Code ─────────────────────

export async function generateLinkCode(c: Context): Promise<Response> {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;
  const db = getAdminClient();

  const { data: existingLink } = await db
    .from("whatsapp_links")
    .select("id, is_active")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .single();

  if (existingLink) {
    return err(c, "Ya ten\u00e9s un tel\u00e9fono vinculado. Desvincul\u00e1 primero para vincular otro.", 409);
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_SECONDS * 1000).toISOString();

  const linkingPhoneHash = `linking:${user.id}`;

  const { error } = await db
    .from("whatsapp_sessions")
    .upsert(
      {
        phone_hash: linkingPhoneHash,
        user_id: user.id,
        mode: "linking",
        current_context: {
          linking_code: code,
          linking_user_id: user.id,
          linking_expires_at: expiresAt,
        },
        expires_at: expiresAt,
        version: 0,
        history: [],
      },
      { onConflict: "phone_hash" },
    );

  if (error) {
    console.error(`[WA-Link] Code generation failed: ${error.message}`);
    return err(c, "Error al generar c\u00f3digo. Intent\u00e1 de nuevo.", 500);
  }

  // N4 FIX: Mask code in logs to prevent PII exposure via dashboard
  console.warn(`[WA-Link] Code ****${code.slice(-2)} generated for user ${user.id} (expires ${expiresAt})`);

  return ok(c, {
    code,
    expiresIn: CODE_EXPIRY_SECONDS,
    instructions: "Envi\u00e1 este c\u00f3digo al bot de Axon en WhatsApp para vincular tu cuenta.",
  });
}

// ─── Bot-side: Verify Link Code ──────────────────────────

export async function verifyLinkCode(
  phoneNumber: string,
  code: string,
): Promise<{ success: boolean; userId?: string; phoneHash?: string }> {
  const db = getAdminClient();

  const { data: sessions, error: searchError } = await db
    .from("whatsapp_sessions")
    .select("phone_hash, current_context, expires_at")
    .eq("mode", "linking")
    .limit(200);

  if (searchError || !sessions) {
    console.error(`[WA-Link] Code search failed: ${searchError?.message}`);
    return { success: false };
  }

  const now = new Date();
  const matchingSession = sessions.find((s) => {
    const ctx = s.current_context as Record<string, unknown>;
    return (
      ctx.linking_code === code &&
      new Date(ctx.linking_expires_at as string) > now
    );
  });

  if (!matchingSession) {
    return { success: false };
  }

  const ctx = matchingSession.current_context as Record<string, unknown>;
  const userId = ctx.linking_user_id as string;

  const salt = generateSalt();
  const phoneHash = await hashPhone(phoneNumber, salt);
  const phoneLookupHash = await computeLookupHash(phoneNumber);

  const { error: linkError } = await db
    .from("whatsapp_links")
    .insert({
      user_id: userId,
      phone_hash: phoneHash,
      phone_salt: salt,
      phone_lookup_hash: phoneLookupHash,
      is_active: true,
    });

  if (linkError) {
    console.error(`[WA-Link] Link creation failed: ${linkError.message}`);
    return { success: false };
  }

  await db
    .from("whatsapp_sessions")
    .upsert(
      {
        phone_hash: phoneHash,
        user_id: userId,
        mode: "conversation",
        current_context: {},
        version: 0,
        history: [],
      },
      { onConflict: "phone_hash" },
    );

  await db
    .from("whatsapp_sessions")
    .delete()
    .eq("phone_hash", matchingSession.phone_hash);

  console.warn(`[WA-Link] Phone linked for user ${userId}. Hash: ${phoneHash.slice(0, 8)}...`);

  return { success: true, userId, phoneHash };
}

export function isLinkingCode(text: string): boolean {
  return new RegExp(`^\\d{${CODE_LENGTH}}$`).test(text.trim());
}

// ─── Unlink Phone ───────────────────────────────────────

export async function unlinkPhone(c: Context): Promise<Response> {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;
  const db = getAdminClient();

  const { error } = await db
    .from("whatsapp_links")
    .update({ is_active: false })
    .eq("user_id", user.id);

  if (error) {
    return err(c, "Error al desvincular. Intent\u00e1 de nuevo.", 500);
  }

  return ok(c, { message: "Tel\u00e9fono desvinculado exitosamente." });
}
