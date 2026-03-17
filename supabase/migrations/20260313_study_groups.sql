-- Study groups for social features (Sprint 3)
-- Institution-scoped study groups with invite code system.

CREATE TABLE IF NOT EXISTS study_groups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  description     TEXT,
  institution_id  UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  created_by      UUID NOT NULL REFERENCES auth.users(id),
  invite_code     TEXT NOT NULL,
  max_members     INTEGER NOT NULL DEFAULT 20,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_study_groups_invite_code
  ON study_groups (invite_code) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_study_groups_institution
  ON study_groups (institution_id) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS study_group_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  student_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_group_member UNIQUE (group_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_student
  ON study_group_members (student_id);

-- updated_at trigger on study_groups
CREATE OR REPLACE FUNCTION update_study_groups_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_study_groups_updated_at ON study_groups;
CREATE TRIGGER trg_study_groups_updated_at
  BEFORE UPDATE ON study_groups
  FOR EACH ROW EXECUTE FUNCTION update_study_groups_updated_at();

-- RLS
ALTER TABLE study_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_group_members ENABLE ROW LEVEL SECURITY;

-- Students can see groups they belong to
CREATE POLICY study_groups_select ON study_groups
  FOR SELECT USING (
    id IN (
      SELECT group_id FROM study_group_members WHERE student_id = auth.uid()
    )
  );

-- Any authenticated user can insert (create) groups
CREATE POLICY study_groups_insert ON study_groups
  FOR INSERT WITH CHECK (created_by = auth.uid());

-- Only owner can update (check membership with owner role, not created_by)
CREATE POLICY study_groups_update ON study_groups
  FOR UPDATE USING (
    id IN (
      SELECT group_id FROM study_group_members
      WHERE student_id = auth.uid() AND role = 'owner'
    )
  );

-- Members can see group membership
CREATE POLICY group_members_select ON study_group_members
  FOR SELECT USING (
    group_id IN (
      SELECT group_id FROM study_group_members WHERE student_id = auth.uid()
    )
  );

CREATE POLICY group_members_insert ON study_group_members
  FOR INSERT WITH CHECK (student_id = auth.uid());

CREATE POLICY group_members_delete ON study_group_members
  FOR DELETE USING (student_id = auth.uid());

-- RPC: Generate unique invite code (6 chars, unambiguous alphanumeric uppercase)
-- Excludes O/0/I/1 to avoid confusion
CREATE OR REPLACE FUNCTION generate_invite_code()
RETURNS TEXT AS $$
DECLARE
  v_code TEXT;
  v_exists BOOLEAN;
BEGIN
  LOOP
    v_code := '';
    FOR i IN 1..6 LOOP
      v_code := v_code || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', floor(random() * 30 + 1)::int, 1);
    END LOOP;
    SELECT EXISTS(SELECT 1 FROM study_groups WHERE invite_code = v_code AND is_active = true) INTO v_exists;
    EXIT WHEN NOT v_exists;
  END LOOP;
  RETURN v_code;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public;

-- RPC: Atomic join with max_members check (prevents race condition)
CREATE OR REPLACE FUNCTION join_study_group(p_group_id UUID, p_student_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_count INT;
  v_max INT;
BEGIN
  SELECT max_members INTO v_max FROM study_groups WHERE id = p_group_id FOR UPDATE;
  SELECT COUNT(*) INTO v_count FROM study_group_members WHERE group_id = p_group_id;
  IF v_count >= v_max THEN RETURN FALSE; END IF;
  INSERT INTO study_group_members (group_id, student_id, role) VALUES (p_group_id, p_student_id, 'member');
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- RPC: Atomic leave with ownership transfer
CREATE OR REPLACE FUNCTION leave_study_group(p_group_id UUID, p_student_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_role TEXT;
  v_member_id UUID;
  v_next_member RECORD;
BEGIN
  -- Get and verify membership
  SELECT id, role INTO v_member_id, v_role
    FROM study_group_members
    WHERE group_id = p_group_id AND student_id = p_student_id;

  IF v_member_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_a_member');
  END IF;

  -- Remove member
  DELETE FROM study_group_members WHERE id = v_member_id;

  -- If owner is leaving, transfer ownership
  IF v_role = 'owner' THEN
    SELECT id, student_id INTO v_next_member
      FROM study_group_members
      WHERE group_id = p_group_id
      ORDER BY joined_at ASC
      LIMIT 1;

    IF v_next_member.id IS NOT NULL THEN
      -- Transfer ownership to longest-standing member
      UPDATE study_group_members SET role = 'owner' WHERE id = v_next_member.id;
      UPDATE study_groups SET created_by = v_next_member.student_id WHERE id = p_group_id;
      RETURN jsonb_build_object('left', true, 'new_owner', v_next_member.student_id);
    ELSE
      -- No members left — dissolve group
      UPDATE study_groups SET is_active = false WHERE id = p_group_id;
      RETURN jsonb_build_object('left', true, 'dissolved', true);
    END IF;
  END IF;

  RETURN jsonb_build_object('left', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Permissions: revoke public access, grant only to authenticated users
REVOKE ALL ON FUNCTION generate_invite_code() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION generate_invite_code() TO authenticated;

REVOKE ALL ON FUNCTION join_study_group(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION join_study_group(UUID, UUID) TO authenticated;

REVOKE ALL ON FUNCTION leave_study_group(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION leave_study_group(UUID, UUID) TO authenticated;
