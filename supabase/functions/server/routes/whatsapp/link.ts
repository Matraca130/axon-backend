/**
 * routes/whatsapp/link.ts — Phone linking flow
 *
 * Connects an Axon web account to a WhatsApp phone number.
 *
 * Flow:
 *   1. Student in web app → POST /whatsapp/link-code (with JWT)
 *      Returns { code: "123456", expiresIn: 300 }
 *   2. Student sends code to WhatsApp bot
 *      webhook.ts detects 6-digit code from unlinked user
 *      Calls verifyLinkCode(phone, code)
 *   3. If valid: hash phone, create whatsapp_links entry, respond success
 *   4. If invalid/expired: respond with error message
 *
 * Security:
 *   - AUDIT-05: Raw phone NEVER stored. Only SHA-256(phone+salt) persisted.
 *   - Code is crypto-random (not Math.random)
 *   - Code expires in 5 minutes
 *   - One pending code per user (overwrites previous)
 *
 * AUDIT F2: whatsapp_sessions has no FK to whatsapp_links, so we can
 * create temporary sessions for unlinked users during this flow.
 */

import type { Context } from "npm:hono";
import { authenticate, ok, err, getAdminClient } from "../../db.ts";
import { hashPhone, generateSalt, sendText } from "./wa-client.ts";

// ─── Constants ───────────────────────────────────────────

const CODE_LENGTH = 6;
const CODE_EXPIRY_SECONDS = 300; // 5 minutes

// ─── Code Generation ─────────────────────────────────────

/**
 * Generate a cryptographically random 6-digit code.
 * Uses crypto.getRandomValues (not Math.random).
 */
function generateCode(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  // Ensure exactly 6 digits (100000-999999)
  const code = 100_000 + (array[0] % 900_000);
  return code.toString();
}

// ─── Web Endpoint: Generate Link Code ─────────────────────

/**
 * POST /whatsapp/link-code
 *
 * Requires JWT. Generates a 6-digit code and stores it in
 * a temporary whatsapp_sessions entry with mode='linking'.
 *
 * Returns: { code: "123456", expiresIn: 300 }
 */
export async function generateLinkCode(c: Context): Promise<Response> {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;
  const db = getAdminClient();

  // Check if user already has an active link
  const { data: existingLink } = await db
    .from("whatsapp_links")
    .select("id, is_active")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .single();

  if (existingLink) {
    return err(c, "Ya tenés un teléfono vinculado. Desvinculá primero para vincular otro.", 409);
  }

  // Generate code
  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_SECONDS * 1000).toISOString();

  // Store code in a temporary linking session
  // We use a synthetic phone_hash (user_id-based) since we don't know the phone yet
  const linkingPhoneHash = `linking:${user.id}`;

  // Upsert: overwrite any existing pending code for this user
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
    return err(c, "Error al generar código. Intentá de nuevo.", 500);
  }

  console.log(`[WA-Link] Code generated for user ${user.id}: ${code} (expires ${expiresAt})`);

  return ok(c, {
    code,
    expiresIn: CODE_EXPIRY_SECONDS,
    instructions: "Enviá este código al bot de Axon en WhatsApp para vincular tu cuenta.",
  });
}

// ─── Bot-side: Verify Link Code ──────────────────────────

/**
 * Called from webhook.ts when an unlinked user sends a 6-digit code.
 * Verifies the code, hashes the phone, creates whatsapp_links entry.
 *
 * @returns true if linking succeeded, false otherwise
 */
export async function verifyLinkCode(
  phoneNumber: string,
  code: string,
): Promise<{ success: boolean; userId?: string; phoneHash?: string }> {
  const db = getAdminClient();

  // Search for a linking session with this code
  const { data: sessions, error: searchError } = await db
    .from("whatsapp_sessions")
    .select("phone_hash, current_context, expires_at")
    .eq("mode", "linking")
    .limit(50); // Small table, linking sessions are rare

  if (searchError || !sessions) {
    console.error(`[WA-Link] Code search failed: ${searchError?.message}`);
    return { success: false };
  }

  // Find the session with matching code that hasn't expired
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

  // Hash the phone number (AUDIT-05: PII protection)
  const salt = generateSalt();
  const phoneHash = await hashPhone(phoneNumber, salt);

  // Create the whatsapp_links entry
  const { error: linkError } = await db
    .from("whatsapp_links")
    .insert({
      user_id: userId,
      phone_hash: phoneHash,
      phone_salt: salt,
      is_active: true,
    });

  if (linkError) {
    // Might fail if user already has a link (UNIQUE constraint)
    console.error(`[WA-Link] Link creation failed: ${linkError.message}`);
    return { success: false };
  }

  // Create the real session for this phone hash
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

  // Clean up the temporary linking session
  await db
    .from("whatsapp_sessions")
    .delete()
    .eq("phone_hash", matchingSession.phone_hash);

  console.log(`[WA-Link] Phone linked for user ${userId}. Hash: ${phoneHash.slice(0, 8)}...`);

  return { success: true, userId, phoneHash };
}

/**
 * Check if a string looks like a 6-digit linking code.
 */
export function isLinkingCode(text: string): boolean {
  return /^\d{6}$/.test(text.trim());
}

// ─── Unlink Phone ───────────────────────────────────────

/**
 * POST /whatsapp/unlink (future)
 * Deactivates the link. Session and logs are retained for analytics.
 */
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
    return err(c, "Error al desvincular. Intentá de nuevo.", 500);
  }

  return ok(c, { message: "Teléfono desvinculado exitosamente." });
}
