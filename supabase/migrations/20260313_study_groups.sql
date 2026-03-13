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
  role        TEXT NOT NULL DEFAULT 'member', -- 'owner' | 'member'
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_group_member UNIQUE (group_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_student
  ON study_group_members (student_id);

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

-- Only owner can update
CREATE POLICY study_groups_update ON study_groups
  FOR UPDATE USING (created_by = auth.uid());

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

-- RPC: Generate unique invite code (6 chars, alphanumeric uppercase)
CREATE OR REPLACE FUNCTION generate_invite_code()
RETURNS TEXT AS $$
DECLARE
  code TEXT;
  exists BOOLEAN;
BEGIN
  LOOP
    code := upper(substr(md5(random()::text), 1, 6));
    SELECT EXISTS(SELECT 1 FROM study_groups WHERE invite_code = code AND is_active = true) INTO exists;
    EXIT WHEN NOT exists;
  END LOOP;
  RETURN code;
END;
$$ LANGUAGE plpgsql VOLATILE;
