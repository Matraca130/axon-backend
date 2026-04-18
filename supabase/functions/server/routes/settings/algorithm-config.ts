/**
 * routes/settings/algorithm-config.ts — Algorithm Config CRUD
 *
 * GET  /algorithm-config?institution_id=xxx  → read config (or global default)
 * PUT  /algorithm-config?institution_id=xxx  → upsert config (admin/owner only)
 *
 * The study-queue reads these weights at runtime instead of using hardcoded values.
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, PREFIX } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { isUuid } from "../../validate.ts";
import { requireInstitutionRole, isDenied, ALL_ROLES } from "../../auth-helpers.ts";

export const algorithmConfigRoutes = new Hono();

// ─── GET /algorithm-config ────────────────────────────────────────

algorithmConfigRoutes.get(
  `${PREFIX}/algorithm-config`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const institutionId = c.req.query("institution_id") ?? null;

    if (institutionId && !isUuid(institutionId)) {
      return err(c, "institution_id must be a valid UUID", 400);
    }

    // SEC-PHASE-2.4 (audit 2026-04-17 iter 19 #1): require membership.
    // Without this check, the GET trusted RLS alone; if RLS ever flexed,
    // any authenticated user could read any institution's BKT priors and
    // NeedScore weights by passing a UUID.
    if (institutionId) {
      const check = await requireInstitutionRole(
        db, user.id, institutionId, ALL_ROLES,
      );
      if (isDenied(check)) return err(c, check.message, check.status);
    }

    try {
      // Try institution-specific config first
      if (institutionId) {
        const { data, error } = await db
          .from("algorithm_config")
          .select("*")
          .eq("institution_id", institutionId)
          .maybeSingle();

        if (error) {
          return safeErr(c, "Fetch algorithm config", error);
        }

        if (data) {
          return ok(c, { config: data, source: "institution" });
        }
      }

      // Fallback to global default (institution_id IS NULL)
      const { data: globalData, error: globalError } = await db
        .from("algorithm_config")
        .select("*")
        .is("institution_id", null)
        .maybeSingle();

      if (globalError) {
        return safeErr(c, "Fetch global algorithm config", globalError);
      }

      if (globalData) {
        return ok(c, { config: globalData, source: "global" });
      }

      // No config at all — return hardcoded defaults
      return ok(c, {
        config: {
          overdue_weight: 0.40,
          mastery_weight: 0.30,
          fragility_weight: 0.20,
          novelty_weight: 0.10,
          grace_days: 1.0,
          bkt_p_know: 0.10,
          bkt_p_transit: 0.30,
          bkt_p_slip: 0.10,
          bkt_p_guess: 0.25,
          version: "v4.2",
        },
        source: "hardcoded",
      });
    } catch (e) {
      return safeErr(c, "Algorithm config", e instanceof Error ? e : null);
    }
  },
);

// ─── PUT /algorithm-config ────────────────────────────────────────

algorithmConfigRoutes.put(
  `${PREFIX}/algorithm-config`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const institutionId = c.req.query("institution_id") ?? null;

    if (!institutionId || !isUuid(institutionId)) {
      return err(c, "institution_id query param is required and must be a valid UUID", 400);
    }

    // Verify admin/owner role
    const { data: membership } = await db
      .from("memberships")
      .select("role")
      .eq("user_id", user.id)
      .eq("institution_id", institutionId)
      .eq("is_active", true)
      .maybeSingle();

    if (!membership || !['admin', 'owner'].includes(membership.role)) {
      return err(c, "Only admin or owner can update algorithm config", 403);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return err(c, "Invalid JSON body", 400);
    }

    // Whitelist allowed fields
    const allowedFields = [
      'overdue_weight', 'mastery_weight', 'fragility_weight', 'novelty_weight',
      'grace_days', 'bkt_p_know', 'bkt_p_transit', 'bkt_p_slip', 'bkt_p_guess',
      'version',
    ];

    const updates: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (field in body) {
        updates[field] = body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return err(c, "No valid fields to update", 400);
    }

    // Validate weight sum if any weight is being updated
    const weightFields = ['overdue_weight', 'mastery_weight', 'fragility_weight', 'novelty_weight'];
    const hasWeightUpdate = weightFields.some(f => f in updates);

    if (hasWeightUpdate) {
      const existing = await db
        .from("algorithm_config")
        .select("overdue_weight, mastery_weight, fragility_weight, novelty_weight")
        .eq("institution_id", institutionId)
        .maybeSingle();

      const merged = {
        overdue_weight: Number(updates.overdue_weight ?? existing?.data?.overdue_weight ?? 0.40),
        mastery_weight: Number(updates.mastery_weight ?? existing?.data?.mastery_weight ?? 0.30),
        fragility_weight: Number(updates.fragility_weight ?? existing?.data?.fragility_weight ?? 0.20),
        novelty_weight: Number(updates.novelty_weight ?? existing?.data?.novelty_weight ?? 0.10),
      };

      const sum = merged.overdue_weight + merged.mastery_weight + merged.fragility_weight + merged.novelty_weight;
      if (Math.abs(sum - 1.0) >= 0.02) {
        return err(c, `NeedScore weights must sum to 1.0 (got ${sum.toFixed(4)})`, 400);
      }
    }

    // Validate BKT constraint
    if ('bkt_p_slip' in updates || 'bkt_p_guess' in updates) {
      const existing = await db
        .from("algorithm_config")
        .select("bkt_p_slip, bkt_p_guess")
        .eq("institution_id", institutionId)
        .maybeSingle();

      const pSlip = Number(updates.bkt_p_slip ?? existing?.data?.bkt_p_slip ?? 0.10);
      const pGuess = Number(updates.bkt_p_guess ?? existing?.data?.bkt_p_guess ?? 0.25);

      if (pSlip + pGuess >= 1.0) {
        return err(c, `BKT constraint violated: p_slip (${pSlip}) + p_guess (${pGuess}) must be < 1.0`, 400);
      }
    }

    // Add audit fields
    updates.updated_by = user.id;
    updates.updated_at = new Date().toISOString();

    try {
      const { data, error } = await db
        .from("algorithm_config")
        .upsert(
          {
            institution_id: institutionId,
            ...updates,
          },
          { onConflict: "institution_id" },
        )
        .select()
        .single();

      if (error) {
        return safeErr(c, "Update algorithm config", error);
      }

      return ok(c, { config: data });
    } catch (e) {
      return safeErr(c, "Algorithm config", e instanceof Error ? e : null);
    }
  },
);
