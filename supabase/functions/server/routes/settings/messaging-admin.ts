/**
 * routes/settings/messaging-admin.ts — Admin settings for messaging integrations
 *
 * Provides CRUD endpoints for managing WhatsApp and Telegram integration settings.
 * Tokens/secrets are stored encrypted in the messaging_admin_settings table.
 *
 * Admin-only: requires institution owner/admin role.
 *
 * Endpoints:
 *   GET  /settings/messaging/:channel        — Get settings for a channel
 *   PUT  /settings/messaging/:channel        — Update settings for a channel
 *   POST /settings/messaging/:channel/test   — Test connection to channel API
 */

import type { Context } from "npm:hono";
import { authenticate, ok, err, getAdminClient } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";

// ─── Types ───────────────────────────────────────────────

interface WhatsAppSettings {
  phone_number_id?: string;
  access_token?: string;
  app_secret?: string;
  verify_token?: string;
  business_account_id?: string;
}

interface TelegramSettings {
  bot_token?: string;
  bot_username?: string;
  webhook_secret?: string;
}

type ChannelSettings = WhatsAppSettings | TelegramSettings;

// ─── Helpers ─────────────────────────────────────────────

async function getUserInstitution(userId: string): Promise<string | null> {
  const db = getAdminClient();
  const { data } = await db
    .from("memberships")
    .select("institution_id, role")
    .eq("user_id", userId)
    .eq("is_active", true)
    .in("role", ["owner", "admin"])
    .limit(1)
    .single();
  return data?.institution_id ?? null;
}

function maskToken(token: string | undefined): string {
  if (!token || token.length < 8) return "****";
  return token.slice(0, 4) + "****" + token.slice(-4);
}

function maskSettings(settings: ChannelSettings, channel: string): Record<string, unknown> {
  if (channel === "whatsapp") {
    const s = settings as WhatsAppSettings;
    return {
      phone_number_id: s.phone_number_id || null,
      access_token: s.access_token ? maskToken(s.access_token) : null,
      app_secret: s.app_secret ? maskToken(s.app_secret) : null,
      verify_token: s.verify_token ? maskToken(s.verify_token) : null,
      business_account_id: s.business_account_id || null,
      has_access_token: !!s.access_token,
      has_app_secret: !!s.app_secret,
      has_verify_token: !!s.verify_token,
    };
  }

  if (channel === "telegram") {
    const s = settings as TelegramSettings;
    return {
      bot_token: s.bot_token ? maskToken(s.bot_token) : null,
      bot_username: s.bot_username || null,
      webhook_secret: s.webhook_secret ? maskToken(s.webhook_secret) : null,
      has_bot_token: !!s.bot_token,
      has_webhook_secret: !!s.webhook_secret,
    };
  }

  return {};
}

// ─── GET /settings/messaging/:channel ────────────────────

export async function getMessagingSettings(c: Context): Promise<Response> {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const channel = c.req.param("channel");
  if (!["whatsapp", "telegram"].includes(channel)) {
    return err(c, "Canal inválido. Usa 'whatsapp' o 'telegram'.", 400);
  }

  const institutionId = await getUserInstitution(user.id);
  if (!institutionId) {
    return err(c, "No tienes permisos de administrador.", 403);
  }

  const db = getAdminClient();
  const { data, error } = await db
    .from("messaging_admin_settings")
    .select("*")
    .eq("institution_id", institutionId)
    .eq("channel", channel)
    .single();

  if (error && error.code !== "PGRST116") {
    return safeErr(c, "Fetch messaging settings", error);
  }

  if (!data) {
    return ok(c, {
      channel,
      is_enabled: false,
      settings: {},
      message: `${channel} no está configurado todavía.`,
    });
  }

  return ok(c, {
    channel,
    is_enabled: data.is_enabled,
    settings: maskSettings(data.settings as ChannelSettings, channel),
    updated_at: data.updated_at,
  });
}

// ─── PUT /settings/messaging/:channel ────────────────────

export async function updateMessagingSettings(c: Context): Promise<Response> {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const channel = c.req.param("channel");
  if (!["whatsapp", "telegram"].includes(channel)) {
    return err(c, "Canal inválido. Usa 'whatsapp' o 'telegram'.", 400);
  }

  const institutionId = await getUserInstitution(user.id);
  if (!institutionId) {
    return err(c, "No tienes permisos de administrador.", 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return err(c, "JSON inválido.", 400);
  }

  const settings = body.settings as ChannelSettings;
  const isEnabled = body.is_enabled as boolean | undefined;

  // Validate settings structure
  if (channel === "whatsapp" && settings) {
    const s = settings as WhatsAppSettings;
    if (s.access_token && typeof s.access_token !== "string") {
      return err(c, "access_token debe ser un string.", 400);
    }
  }

  if (channel === "telegram" && settings) {
    const s = settings as TelegramSettings;
    if (s.bot_token && typeof s.bot_token !== "string") {
      return err(c, "bot_token debe ser un string.", 400);
    }
  }

  const db = getAdminClient();

  // Merge with existing settings (don't overwrite unset fields)
  const { data: existing } = await db
    .from("messaging_admin_settings")
    .select("settings")
    .eq("institution_id", institutionId)
    .eq("channel", channel)
    .single();

  const mergedSettings = {
    ...(existing?.settings as Record<string, unknown> ?? {}),
    ...(settings ?? {}),
  };

  // Remove null/empty values
  for (const key of Object.keys(mergedSettings)) {
    if (mergedSettings[key] === null || mergedSettings[key] === "") {
      delete mergedSettings[key];
    }
  }

  const { error } = await db
    .from("messaging_admin_settings")
    .upsert(
      {
        institution_id: institutionId,
        channel,
        settings: mergedSettings,
        is_enabled: isEnabled ?? existing !== null,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "institution_id,channel" },
    );

  if (error) {
    return safeErr(c, "Update messaging settings", error);
  }

  console.warn(`[Messaging-Admin] ${channel} settings updated by ${user.id} for institution ${institutionId}`);

  return ok(c, {
    channel,
    message: `Configuración de ${channel} actualizada.`,
    settings: maskSettings(mergedSettings as ChannelSettings, channel),
  });
}

// ─── POST /settings/messaging/:channel/test ──────────────

export async function testMessagingConnection(c: Context): Promise<Response> {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const channel = c.req.param("channel");
  if (!["whatsapp", "telegram"].includes(channel)) {
    return err(c, "Canal inválido.", 400);
  }

  const institutionId = await getUserInstitution(user.id);
  if (!institutionId) {
    return err(c, "No tienes permisos de administrador.", 403);
  }

  const db = getAdminClient();
  const { data } = await db
    .from("messaging_admin_settings")
    .select("settings")
    .eq("institution_id", institutionId)
    .eq("channel", channel)
    .single();

  if (!data?.settings) {
    return err(c, `${channel} no está configurado.`, 400);
  }

  const settings = data.settings as ChannelSettings;

  if (channel === "telegram") {
    const tgSettings = settings as TelegramSettings;
    if (!tgSettings.bot_token) {
      return err(c, "bot_token no configurado.", 400);
    }

    try {
      const res = await fetch(
        `https://api.telegram.org/bot${tgSettings.bot_token}/getMe`,
      );
      const result = await res.json();
      if (result.ok) {
        return ok(c, {
          success: true,
          bot: result.result,
          message: `Bot @${result.result.username} conectado correctamente.`,
        });
      }
      return ok(c, { success: false, error: result.description });
    } catch (e) {
      return ok(c, { success: false, error: (e as Error).message });
    }
  }

  if (channel === "whatsapp") {
    const waSettings = settings as WhatsAppSettings;
    if (!waSettings.access_token || !waSettings.phone_number_id) {
      return err(c, "access_token y phone_number_id requeridos.", 400);
    }

    try {
      const res = await fetch(
        `https://graph.facebook.com/v21.0/${waSettings.phone_number_id}`,
        { headers: { Authorization: `Bearer ${waSettings.access_token}` } },
      );
      const result = await res.json();
      if (!result.error) {
        return ok(c, {
          success: true,
          phone: result,
          message: "WhatsApp Business API conectada correctamente.",
        });
      }
      return ok(c, { success: false, error: result.error?.message });
    } catch (e) {
      return ok(c, { success: false, error: (e as Error).message });
    }
  }

  return err(c, "Canal no soportado.", 400);
}
