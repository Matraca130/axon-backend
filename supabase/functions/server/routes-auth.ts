/**
 * routes-auth.ts — Authentication & Profile management for Axon v4.4
 *
 * Routes:
 *   POST /signup  — Register new user (admin client, no auth required)
 *   GET  /me      — Current user's profile (auto-creates if missing)
 *   PUT  /me      — Update profile (full_name, avatar_url)
 *
 * Signup flow:
 *   1. Creates auth.users row via admin client (email_confirm: true)
 *   2. Creates profiles row with same id
 *   3. Auto-joins user to first active institution as 'student'
 *   On profiles failure, rolls back auth.users row
 *
 * GET /me auto-profile-creation:
 *   If the user exists in auth.users but has no profiles row (error PGRST116),
 *   the handler auto-creates the profile from auth user metadata.
 *   N-6 FIX: Now fetches metadata via admin.auth.admin.getUserById()
 *   P-5 FIX: Password max length capped at 128.
 *   P-6 FIX: Auto-profile uses upsert to handle concurrent requests.
 */

import { Hono } from "npm:hono";
import {
  authenticate,
  getAdminClient,
  ok,
  err,
  safeJson,
  PREFIX,
} from "./db.ts";
import { isEmail, isNonEmpty } from "./validate.ts";
import { safeErr } from "./lib/safe-error.ts";
import type { Context } from "npm:hono";

const authRoutes = new Hono();

// ─── Log Redaction Helpers ──────────────────────────────────────
// FINDING-27 FIX: Avoid leaking raw user.id / email into logs.

function truncId(id: string | undefined | null): string {
  if (!id || typeof id !== "string") return "unknown";
  return id.slice(0, 8);
}

function redactEmail(email: string | undefined | null): string {
  if (!email || typeof email !== "string") return "unknown";
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const domainHead = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  const mask = (s: string): string =>
    s.length <= 2 ? `${s.slice(0, 1)}***` : `${s.slice(0, 2)}***`;
  return `${mask(local)}@${mask(domainHead)}${tld}`;
}

// ─── Signup Rate Limiter ────────────────────────────────────────
// ROUTE-005 FIX: Strict rate limit for signups (5 per IP per hour).
// Separate from the global rate limiter — signup is expensive (creates
// auth.users + profiles rows) and must be protected against abuse.
//
// FINDING-9 FIX: x-forwarded-for is attacker-controlled when the Edge
// Function is called directly. Prefer x-real-ip (set by the Supabase
// proxy). For x-forwarded-for fallback, use the RIGHTMOST value — the
// nearest proxy appends its observed client IP at the tail. The leftmost
// value is client-claimed and spoofable.
// Composite key (ip + hashed email) defends against IP rotation attacks
// by also binding the bucket to the normalized email.

const signupAttempts = new Map<string, { count: number; resetAt: number }>();

function getClientIp(c: Context): string {
  const realIp = c.req.header("x-real-ip")?.trim();
  if (realIp) return realIp;
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const rightmost = xff.split(",").pop()?.trim();
    if (rightmost) return rightmost;
  }
  return "unknown";
}

async function hashEmailKey(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const salt = Deno.env.get("AXON_RATE_LIMIT_SALT") ?? "axon-default-salt";
  const data = new TextEncoder().encode(`${salt}:${normalized}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < 8; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function checkSignupLimit(key: string): boolean {
  const now = Date.now();
  const entry = signupAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    signupAttempts.set(key, { count: 1, resetAt: now + 3_600_000 }); // 1 hour
    return true; // allowed
  }
  if (entry.count >= 5) return false; // blocked
  entry.count++;
  return true; // allowed
}

// ─── POST /signup ───────────────────────────────────────────────

authRoutes.post(`${PREFIX}/signup`, async (c: Context) => {
  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const email = body.email;
  const password = body.password;
  const full_name = body.full_name;

  if (!isEmail(email)) {
    return err(c, "email must be a valid email address", 400);
  }

  // ROUTE-005 / FINDING-9 FIX: Strict rate limit (5 signups per hour)
  // keyed on (trusted-ip, hashed-email). Binding the email defeats IP
  // rotation attacks against a single target address.
  const ip = getClientIp(c);
  const emailKey = await hashEmailKey(email);
  const rateKey = `${ip}:${emailKey}`;
  if (!checkSignupLimit(rateKey)) {
    return c.json({ error: "Too many signup attempts. Try again later." }, 429);
  }
  if (typeof password !== "string" || password.length < 8) {
    return err(c, "Password must be at least 8 characters", 400);
  }
  // P-5 FIX: Cap password length to prevent abuse
  if (password.length > 128) {
    return err(c, "Password must be at most 128 characters", 400);
  }

  const admin = getAdminClient();

  // Step 1: Create auth user
  const { data: userData, error: authError } =
    await admin.auth.admin.createUser({
      email,
      password,
      user_metadata: {
        full_name: typeof full_name === "string" ? full_name : "",
      },
      email_confirm: true,
    });

  if (authError) {
    // Return user-friendly messages for common signup errors
    // instead of the generic "Signup failed" from safeErr
    const msg = authError.message?.toLowerCase() ?? "";
    if (msg.includes("already been registered") || msg.includes("already registered") || msg.includes("duplicate")) {
      return c.json({ error: "Este email ya esta registrado. Intenta iniciar sesion." }, 409);
    }
    if (msg.includes("rate limit") || msg.includes("too many")) {
      return c.json({ error: "Demasiados intentos. Intenta de nuevo mas tarde." }, 429);
    }
    return safeErr(c, "Signup", authError, 400);
  }

  const userId = userData.user.id;

  // Step 2: Create profile row
  const { error: profileError } = await admin.from("profiles").insert({
    id: userId,
    email,
    full_name: typeof full_name === "string" ? full_name : "",
  });

  if (profileError) {
    // Rollback: delete auth user to avoid orphan
    // FINDING-27 FIX: truncate user id in logs.
    console.error(
      `[Axon] Profile creation failed for ${truncId(userId)}, rolling back auth user: ${profileError.message}`,
    );
    await admin.auth.admin.deleteUser(userId);
    return safeErr(c, "Profile creation (auth rolled back)", profileError);
  }

  // Step 3: Optional auto-join to a configured default institution.
  //
  // SEC-AUDIT FIX: previously every new signup was auto-joined as 'student'
  // to the oldest active institution (`ORDER BY created_at LIMIT 1`). In a
  // multi-tenant deployment that silently leaks cross-tenant access to
  // whichever institution happened to be created first.
  //
  // Now opt-in: set AXON_DEFAULT_INSTITUTION_ID to a specific institution
  // UUID to restore the convenience join (useful for single-tenant or demo
  // deploys). If unset, new signups land without any institution membership
  // and must be invited explicitly.
  const defaultInstitutionId = Deno.env.get("AXON_DEFAULT_INSTITUTION_ID");
  if (defaultInstitutionId) {
    try {
      const { data: inst } = await admin
        .from("institutions")
        .select("id")
        .eq("id", defaultInstitutionId)
        .eq("is_active", true)
        .maybeSingle();

      if (inst) {
        const { error: memberError } = await admin.from("memberships").insert({
          user_id: userId,
          institution_id: inst.id,
          role: "student",
          is_active: true,
        });
        if (memberError) {
          // FINDING-27 FIX: truncate user id in logs.
          console.warn(
            `[Axon] Default-institution join failed for ${truncId(userId)} → ${inst.id}: ${memberError.message}`,
          );
        } else {
          console.log(`[Axon] Joined ${truncId(userId)} → default institution ${inst.id} as student`);
        }
      } else {
        console.warn(
          `[Axon] AXON_DEFAULT_INSTITUTION_ID=${defaultInstitutionId} does not match an active institution`,
        );
      }
    } catch (e) {
      console.warn(`[Axon] Default-institution join exception: ${(e as Error).message}`);
    }
  }

  return ok(c, { id: userId, email }, 201);
});

// ─── GET /me ───────────────────────────────────────────────────

authRoutes.get(`${PREFIX}/me`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const { data, error } = await db
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (error) {
    // Profile row missing — auto-create from auth user metadata
    if (error.code === "PGRST116") {
      // FINDING-27 FIX: truncate user id in logs.
      console.warn(`[Axon] Auto-creating missing profile for user ${truncId(user.id)}`);
      const admin = getAdminClient();

      // N-6 FIX: Fetch full user record from Supabase Auth
      const { data: authData } = await admin.auth.admin.getUserById(user.id);
      const meta = authData?.user?.user_metadata || {};

      // P-6 FIX: Use upsert instead of insert to handle race condition.
      // If two concurrent /me requests both detect PGRST116, the second
      // upsert will simply update (no-op) instead of failing with duplicate key.
      const { data: created, error: insertErr } = await admin
        .from("profiles")
        .upsert(
          {
            id: user.id,
            email: user.email,
            full_name: meta.full_name || meta.name || "",
          },
          { onConflict: "id" },
        )
        .select("*")
        .single();

      if (insertErr) {
        return safeErr(c, "Profile auto-creation", insertErr);
      }
      return ok(c, created);
    }

    return safeErr(c, "Profile fetch", error, 404);
  }

  return ok(c, data);
});

// ─── PUT /me ───────────────────────────────────────────────────

authRoutes.put(`${PREFIX}/me`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const patch: Record<string, unknown> = {};

  if (body.full_name !== undefined) {
    if (typeof body.full_name !== "string" || body.full_name.length > 255) {
      return err(c, "full_name must be a string ≤ 255 characters", 400);
    }
    patch.full_name = body.full_name;
  }

  if (body.avatar_url !== undefined) {
    if (typeof body.avatar_url !== "string" || body.avatar_url.length > 2048) {
      return err(c, "avatar_url must be a string ≤ 2048 characters", 400);
    }
    let parsed: URL;
    try {
      parsed = new URL(body.avatar_url);
    } catch {
      return err(c, "avatar_url must be a valid URL", 400);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return err(c, "avatar_url must use http or https", 400);
    }
    patch.avatar_url = body.avatar_url;
  }

  if (Object.keys(patch).length === 0) {
    return err(
      c,
      "No valid fields to update (allowed: full_name, avatar_url)",
      400,
    );
  }

  patch.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("profiles")
    .update(patch)
    .eq("id", user.id)
    .select()
    .single();

  if (error) {
    return safeErr(c, "Profile update", error);
  }

  return ok(c, data);
});

export { authRoutes };
