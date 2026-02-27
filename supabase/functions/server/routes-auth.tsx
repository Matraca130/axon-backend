/**
 * routes-auth.tsx — Authentication & Profile management for Axon v4.4
 *
 * Routes:
 *   POST /signup  — Register new user (admin client, no auth required)
 *   GET  /me      — Current user's profile (auto-creates if missing)
 *   PUT  /me      — Update profile (full_name, avatar_url)
 *
 * Signup flow:
 *   1. Creates auth.users row via admin client (email_confirm: true)
 *   2. Creates profiles row with same id
 *   3. On profiles failure, rolls back auth.users row
 *
 * GET /me auto-profile-creation:
 *   If the user exists in auth.users but has no profiles row (error PGRST116),
 *   the handler auto-creates the profile from auth user metadata.
 *   This prevents a sign-in loop for users created outside the /signup flow.
 *   N-6 FIX: Now fetches metadata via admin.auth.admin.getUserById()
 *   instead of the (always-undefined) user.user_metadata.
 *
 * Login/logout are handled client-side by supabase-js (not proxied through server).
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
import type { Context } from "npm:hono";

const authRoutes = new Hono();

// ─── POST /signup ───────────────────────────────────────────────────
// Public route — no auth required. Uses admin client to create user.

authRoutes.post(`${PREFIX}/signup`, async (c: Context) => {
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
  if (password.length < 8) {
    return err(c, "Password must be at least 8 characters", 400);
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
      // Automatically confirm the user's email since an email server hasn't been configured.
      email_confirm: true,
    });

  if (authError) {
    return err(c, `Signup auth failed: ${authError.message}`, 400);
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
    return err(
      c,
      `Profile creation failed (auth rolled back): ${profileError.message}`,
      500,
    );
  }

  return ok(c, { id: userId, email }, 201);
});

// ─── GET /me ────────────────────────────────────────────────────────
// Returns the authenticated user's profile from the `profiles` table.
// If the profile row is missing (PGRST116), auto-creates it from
// auth user metadata to prevent sign-in loops.

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
      console.log(`[Axon] Auto-creating missing profile for user ${user.id}`);
      const admin = getAdminClient();

      // N-6 FIX: authenticate() only returns {id, email} — it does NOT
      // include user_metadata. Fetch the full user record from Supabase Auth
      // to get the actual metadata (full_name, etc.).
      const { data: authData } = await admin.auth.admin.getUserById(user.id);
      const meta = authData?.user?.user_metadata || {};

      const { data: created, error: insertErr } = await admin
        .from("profiles")
        .insert({
          id: user.id,
          email: user.email,
          full_name: meta.full_name || meta.name || "",
        })
        .select("*")
        .single();

      if (insertErr) {
        return err(
          c,
          `Profile auto-creation failed for user ${user.id}: ${insertErr.message}`,
          500,
        );
      }
      return ok(c, created);
    }

    return err(
      c,
      `Profile fetch failed for user ${user.id}: ${error.message}`,
      404,
    );
  }

  return ok(c, data);
});

// ─── PUT /me ────────────────────────────────────────────────────────
// Update the authenticated user's profile. Only whitelisted fields allowed.

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

  patch.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("profiles")
    .update(patch)
    .eq("id", user.id)
    .select()
    .single();

  if (error) {
    return err(
      c,
      `Profile update failed for user ${user.id}: ${error.message}`,
      500,
    );
  }

  return ok(c, data);
});

export { authRoutes };
