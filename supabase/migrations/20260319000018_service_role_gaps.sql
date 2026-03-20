-- Add missing service_role_all policies to video_views and summary_blocks
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'video_views' AND policyname = 'video_views_service_role_all') THEN
    EXECUTE 'CREATE POLICY "video_views_service_role_all" ON video_views FOR ALL USING (auth.role() = ''service_role'')';
    RAISE NOTICE '[OK] video_views — service_role_all added';
  ELSE
    RAISE NOTICE '[SKIP] video_views — policy already exists';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'summary_blocks' AND policyname = 'summary_blocks_service_role_all') THEN
    EXECUTE 'CREATE POLICY "summary_blocks_service_role_all" ON summary_blocks FOR ALL USING (auth.role() = ''service_role'')';
    RAISE NOTICE '[OK] summary_blocks — service_role_all added';
  ELSE
    RAISE NOTICE '[SKIP] summary_blocks — policy already exists';
  END IF;
END; $$;
