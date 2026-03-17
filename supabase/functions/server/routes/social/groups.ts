/**
 * routes/social/groups.ts -- Study groups (Sprint 3)
 *
 * Endpoints:
 *   POST   /social/groups              -- Create study group
 *   GET    /social/groups              -- List my groups
 *   GET    /social/groups/:id          -- Group details + members
 *   POST   /social/groups/join         -- Join via invite code
 *   DELETE /social/groups/:id/leave    -- Leave group
 *   GET    /social/groups/:id/leaderboard -- Group XP ranking
 *   PUT    /social/groups/:id          -- Update group (owner only)
 *
 * Design decisions:
 *   - Groups are institution-scoped (no cross-institution)
 *   - Max 20 members per group (configurable)
 *   - 6-char invite code generated via RPC
 *   - Owner transfer on leave (to longest-standing member)
 *   - Group dissolves when last member leaves
 *   - Join uses atomic RPC to prevent race condition on max_members
 *   - Leave uses atomic RPC for safe ownership transfer
 *   - Institution membership is validated on create and join
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import { authenticate, ok, err, safeJson, PREFIX, getAdminClient } from "../../db.ts";
import { isUuid } from "../../validate.ts";
import { requireInstitutionRole, isDenied, ALL_ROLES } from "../../auth-helpers.ts";

export const groupRoutes = new Hono();

const MAX_GROUP_NAME_LENGTH = 50;
const MAX_DESCRIPTION_LENGTH = 200;

// --- POST /social/groups ---

groupRoutes.post(`${PREFIX}/social/groups`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const name = (body.name as string)?.trim();
  if (!name || name.length < 2 || name.length > MAX_GROUP_NAME_LENGTH) {
    return err(c, `Group name must be 2-${MAX_GROUP_NAME_LENGTH} characters`, 400);
  }

  const institutionId = body.institution_id as string;
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id must be a valid UUID", 400);
  }

  // Validate user belongs to this institution
  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
  if (isDenied(roleCheck)) {
    return err(c, roleCheck.message, roleCheck.status as 400 | 403 | 404);
  }

  const description = ((body.description as string) ?? "").trim().slice(0, MAX_DESCRIPTION_LENGTH);
  const adminDb = getAdminClient();

  // Generate invite code via RPC
  const { data: inviteCode, error: codeErr } = await adminDb.rpc("generate_invite_code");
  if (codeErr || !inviteCode) {
    return err(c, "Failed to generate invite code", 500);
  }

  // Create group
  const { data: group, error: groupErr } = await adminDb
    .from("study_groups")
    .insert({
      name,
      description: description || null,
      institution_id: institutionId,
      created_by: user.id,
      invite_code: inviteCode as string,
    })
    .select()
    .single();

  if (groupErr) {
    return err(c, `Group creation failed: ${groupErr.message}`, 500);
  }

  // Add creator as owner
  const { error: memberErr } = await adminDb
    .from("study_group_members")
    .insert({
      group_id: group.id,
      student_id: user.id,
      role: "owner",
    });

  if (memberErr) {
    // Rollback group creation
    await adminDb.from("study_groups").delete().eq("id", group.id);
    return err(c, `Member creation failed: ${memberErr.message}`, 500);
  }

  return ok(c, {
    group,
    invite_code: inviteCode,
    message: "Group created successfully",
  }, 201);
});

// --- GET /social/groups ---

groupRoutes.get(`${PREFIX}/social/groups`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const adminDb = getAdminClient();

  // Get all group IDs the user belongs to
  const { data: memberships } = await adminDb
    .from("study_group_members")
    .select("group_id, role")
    .eq("student_id", user.id);

  if (!memberships || memberships.length === 0) {
    return ok(c, { groups: [], total: 0 });
  }

  const groupIds = memberships.map((m) => m.group_id as string);
  const roleMap = new Map(memberships.map((m) => [m.group_id as string, m.role]));

  // Get group details with member count
  const { data: groups, error } = await adminDb
    .from("study_groups")
    .select("*, study_group_members(id)")
    .in("id", groupIds)
    .eq("is_active", true);

  if (error) {
    return err(c, `Groups fetch failed: ${error.message}`, 500);
  }

  const enriched = (groups ?? []).map((g: Record<string, unknown>) => ({
    ...g,
    my_role: roleMap.get(g.id as string) ?? "member",
    member_count: Array.isArray(g.study_group_members)
      ? (g.study_group_members as unknown[]).length
      : 0,
    study_group_members: undefined, // Remove raw join data
  }));

  return ok(c, { groups: enriched, total: enriched.length });
});

// --- GET /social/groups/:id ---

groupRoutes.get(`${PREFIX}/social/groups/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const groupId = c.req.param("id");
  if (!isUuid(groupId)) {
    return err(c, "Invalid group ID", 400);
  }

  const adminDb = getAdminClient();

  // Verify membership
  const { data: membership } = await adminDb
    .from("study_group_members")
    .select("role")
    .eq("group_id", groupId)
    .eq("student_id", user.id)
    .maybeSingle();

  if (!membership) {
    return err(c, "You are not a member of this group", 403);
  }

  // Get group + members with profile info
  const [groupResult, membersResult] = await Promise.all([
    adminDb
      .from("study_groups")
      .select("*")
      .eq("id", groupId)
      .single(),
    adminDb
      .from("study_group_members")
      .select("student_id, role, joined_at, profiles(full_name, avatar_url)")
      .eq("group_id", groupId)
      .order("joined_at", { ascending: true }),
  ]);

  if (groupResult.error) {
    return err(c, `Group fetch failed: ${groupResult.error.message}`, 500);
  }

  return ok(c, {
    group: groupResult.data,
    members: membersResult.data ?? [],
    my_role: membership.role,
    member_count: membersResult.data?.length ?? 0,
  });
});

// --- POST /social/groups/join ---

groupRoutes.post(`${PREFIX}/social/groups/join`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const inviteCode = (body.invite_code as string)?.trim()?.toUpperCase();
  if (!inviteCode || inviteCode.length !== 6) {
    return err(c, "invite_code must be exactly 6 characters", 400);
  }

  const adminDb = getAdminClient();

  // Find group by invite code
  const { data: group, error: findErr } = await adminDb
    .from("study_groups")
    .select("id, name, institution_id, max_members")
    .eq("invite_code", inviteCode)
    .eq("is_active", true)
    .maybeSingle();

  if (findErr || !group) {
    return err(c, "Invalid or expired invite code", 404);
  }

  // Validate user belongs to the group's institution
  const roleCheck = await requireInstitutionRole(
    db, user.id, group.institution_id as string, ALL_ROLES,
  );
  if (isDenied(roleCheck)) {
    return err(c, "You must be a member of this institution to join the group", 403);
  }

  // Check if already a member
  const { data: existing } = await adminDb
    .from("study_group_members")
    .select("id")
    .eq("group_id", group.id)
    .eq("student_id", user.id)
    .maybeSingle();

  if (existing) {
    return ok(c, { message: "Already a member of this group", already_member: true });
  }

  // Atomic join via RPC (prevents race condition on max_members)
  const { data: joined, error: joinErr } = await adminDb.rpc("join_study_group", {
    p_group_id: group.id,
    p_student_id: user.id,
  });

  if (joinErr) {
    return err(c, `Join failed: ${joinErr.message}`, 500);
  }

  if (!joined) {
    return err(c, `Group is full (${group.max_members} members max)`, 400);
  }

  return ok(c, {
    joined: true,
    group_name: group.name,
    group_id: group.id,
  }, 201);
});

// --- DELETE /social/groups/:id/leave ---

groupRoutes.delete(`${PREFIX}/social/groups/:id/leave`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const groupId = c.req.param("id");
  if (!isUuid(groupId)) {
    return err(c, "Invalid group ID", 400);
  }

  const adminDb = getAdminClient();

  // Atomic leave via RPC (handles ownership transfer safely)
  const { data: result, error: leaveErr } = await adminDb.rpc("leave_study_group", {
    p_group_id: groupId,
    p_student_id: user.id,
  });

  if (leaveErr) {
    return err(c, `Leave failed: ${leaveErr.message}`, 500);
  }

  // RPC returns jsonb — check for application-level errors
  if (result?.error === "not_a_member") {
    return err(c, "You are not a member of this group", 404);
  }

  return ok(c, { left: true, group_id: groupId });
});

// --- GET /social/groups/:id/leaderboard ---

groupRoutes.get(`${PREFIX}/social/groups/:id/leaderboard`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const groupId = c.req.param("id");
  if (!isUuid(groupId)) {
    return err(c, "Invalid group ID", 400);
  }

  const adminDb = getAdminClient();

  // Verify membership
  const { data: membership } = await adminDb
    .from("study_group_members")
    .select("role")
    .eq("group_id", groupId)
    .eq("student_id", user.id)
    .maybeSingle();

  if (!membership) {
    return err(c, "You are not a member of this group", 403);
  }

  // Get group institution_id
  const { data: group } = await adminDb
    .from("study_groups")
    .select("institution_id")
    .eq("id", groupId)
    .single();

  if (!group) {
    return err(c, "Group not found", 404);
  }

  // Get member IDs
  const { data: members } = await adminDb
    .from("study_group_members")
    .select("student_id")
    .eq("group_id", groupId);

  const memberIds = (members ?? []).map((m) => m.student_id as string);

  if (memberIds.length === 0) {
    return ok(c, { leaderboard: [], my_rank: null });
  }

  // Get XP data for members
  const { data: xpData } = await adminDb
    .from("student_xp")
    .select("student_id, xp_this_week, total_xp, current_level")
    .eq("institution_id", group.institution_id)
    .in("student_id", memberIds)
    .order("xp_this_week", { ascending: false });

  // Get profile info
  const { data: profiles } = await adminDb
    .from("profiles")
    .select("id, full_name, avatar_url")
    .in("id", memberIds);

  const profileMap = new Map(
    (profiles ?? []).map((p: Record<string, unknown>) => [
      p.id as string,
      { full_name: p.full_name, avatar_url: p.avatar_url },
    ]),
  );

  // Build leaderboard
  const leaderboard = (xpData ?? []).map((entry: Record<string, unknown>, idx: number) => ({
    rank: idx + 1,
    student_id: entry.student_id,
    full_name: profileMap.get(entry.student_id as string)?.full_name ?? "Unknown",
    avatar_url: profileMap.get(entry.student_id as string)?.avatar_url ?? null,
    xp_this_week: entry.xp_this_week,
    total_xp: entry.total_xp,
    level: entry.current_level,
  }));

  const myRank = leaderboard.findIndex(
    (e: Record<string, unknown>) => e.student_id === user.id,
  );

  return ok(c, {
    leaderboard,
    my_rank: myRank >= 0 ? myRank + 1 : null,
    member_count: memberIds.length,
  });
});

// --- PUT /social/groups/:id ---

groupRoutes.put(`${PREFIX}/social/groups/:id`, async (c: Context) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const groupId = c.req.param("id");
  if (!isUuid(groupId)) {
    return err(c, "Invalid group ID", 400);
  }

  const body = await safeJson(c);
  if (!body) return err(c, "Invalid or missing JSON body", 400);

  const adminDb = getAdminClient();

  // Verify ownership
  const { data: membership } = await adminDb
    .from("study_group_members")
    .select("role")
    .eq("group_id", groupId)
    .eq("student_id", user.id)
    .maybeSingle();

  if (!membership || membership.role !== "owner") {
    return err(c, "Only the group owner can update settings", 403);
  }

  const updates: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = (body.name as string)?.trim();
    if (!name || name.length < 2 || name.length > MAX_GROUP_NAME_LENGTH) {
      return err(c, `Group name must be 2-${MAX_GROUP_NAME_LENGTH} characters`, 400);
    }
    updates.name = name;
  }

  if (body.description !== undefined) {
    updates.description = ((body.description as string) ?? "").trim().slice(0, MAX_DESCRIPTION_LENGTH) || null;
  }

  const { data, error } = await adminDb
    .from("study_groups")
    .update(updates)
    .eq("id", groupId)
    .select()
    .single();

  if (error) {
    return err(c, `Update failed: ${error.message}`, 500);
  }

  return ok(c, data);
});
