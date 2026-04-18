/**
 * routes-auth.ts — Authentication & Profile management for Axon v4.4
 *
 * Routes:
 *   POST /signup  — Register new user (admin client, no auth required)
 *   GET  /me      — Current user's profile (auto-creates if missing)
 *   PUT  /me      — Update profile (full_name, avatar_url)
 *
 * Signup flow:
 *   1. Creates auth.users row via admin client (email_confirm: false — user
 *      must confirm email before they can log in or obtain a JWT)
 *   2. Creates profiles row with same id
 *   3. Auto-joins user to first active institution as 'student'
 *      (safe: membership is inert until email is confirmed)
 *   4. Returns generic message regardless of outcome (anti-enumeration)
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

// ─── Signup Rate Limiter ────────────────────────────────────────
// ROUTE-005 FIX: Strict rate limit for signups (5 per IP per hour).
// Separate from the global rate limiter — signup is expensive (creates
// auth.users + profiles rows) and must be protected against abuse.

const signupAttempts = new Map<string, { count: number; resetAt: number }>();

function checkSignupLimit(ip: string): boolean {
  const now = Date.now();
  // SEC: Periodic cleanup — remove expired entries to prevent unbounded Map growth
  if (signupAttempts.size > 100) {
    for (const [key, entry] of signupAttempts) {
      if (now > entry.resetAt) signupAttempts.delete(key);
    }
  }
  const entry = signupAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    signupAttempts.set(ip, { count: 1, resetAt: now + 3_600_000 }); // 1 hour
    return true; // allowed
  }
  if (entry.count >= 5) return false; // blocked
  entry.count++;
  return true; // allowed
}

// ─── POST /signup ───────────────────────────────────────────────

authRoutes.post(`${PREFIX}/signup`, async (c: Context) => {
  // ROUTE-005 FIX: Strict rate limit for signups (5 per IP per hour)
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    || c.req.header("x-real-ip")
    || "unknown";
  if (!checkSignupLimit(ip)) {
    return c.json({ error: "Too many signup attempts. Try again later." }, 429);
  }

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const email = body.email;
  const password = body.password;
  const full_name = body.full_name;

  if (!isEmail(email)) {
    return err(c, "email must be a valid email address", 400);
  }
  if (!isNonEmpty(password)) {
    return err(c, "password must be a non-empty string", 400);
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
      email_confirm: false,
    });

  if (authError) {
    // Return user-friendly messages for common signup errors
    // instead of the generic "Signup failed" from safeErr
    const msg = authError.message?.toLowerCase() ?? "";
    // SEC: Return generic message to prevent user enumeration (was 409)
    if (msg.includes("already been registered") || msg.includes("already registered") || msg.includes("duplicate")) {
      return c.json({ message: "Si este email no esta registrado, recibiras un enlace de confirmacion." }, 200);
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
    console.error(
      `[Axon] Profile creation failed for ${userId}, rolling back auth user: ${profileError.message}`,
    );
    await admin.auth.admin.deleteUser(userId);
    return safeErr(c, "Profile creation (auth rolled back)", profileError);
  }

  // Step 3: Auto-join first active institution as 'student'
  // This ensures new signups land directly in the platform.
  // Non-critical: if it fails, user is still created — admin can add them later.
  // SEC: Safe because email_confirm is false — the user cannot obtain a JWT
  // (and therefore cannot access any content behind RLS) until they confirm
  // their email address. The membership row exists but is inert until then.
  try {
    const { data: firstInst } = await admin
      .from("institutions")
      .select("id")
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    if (firstInst) {
      const { error: memberError } = await admin.from("memberships").insert({
        user_id: userId,
        institution_id: firstInst.id,
        role: "student",
        is_active: true,
      });
      if (memberError) {
        // Log but don't fail signup — membership can be added manually
        console.warn(
          `[Axon] Auto-join failed for ${userId} → institution ${firstInst.id}: ${memberError.message}`,
        );
      } else {
        console.log(`[Axon] Auto-joined ${userId} → institution ${firstInst.id} as student`);
      }
    } else {
      console.warn("[Axon] No active institution found for auto-join");
    }
  } catch (e) {
    console.warn(`[Axon] Auto-join exception: ${(e as Error).message}`);
  }

  // SEC: Same generic message as the "already registered" path to prevent enumeration.
  // User must confirm email before they can obtain a JWT and access content.
  return c.json({ message: "Si este email no esta registrado, recibiras un enlace de confirmacion." }, 200);
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
      console.warn(`[Axon] Auto-creating missing profile for user ${user.id}`);
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

  const allowedFields = ["full_name", "avatar_url"];
  const patch: Record<string, unknown> = {};

  for (const f of allowedFields) {
    if (body[f] !== undefined) patch[f] = body[f];
  }

  if (Object.keys(patch).length === 0) {
    return err(
      c,
      "No valid fields to update (allowed: full_name, avatar_url)",
      400,
    );
  }

  // SEC: Reject non-HTTPS avatar URLs (prevents javascript: and other schemes)
  if (patch.avatar_url !== undefined) {
    const url = String(patch.avatar_url);
    if (url && !url.startsWith("https://")) {
      return err(c, "avatar_url must be a valid HTTPS URL", 400);
    }
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
