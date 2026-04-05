-- ============================================================
-- Fix: Grant EXECUTE on resolve_parent_institution to authenticated/anon
--
-- The crud-factory.ts checkContentScope() calls this RPC via the
-- user-scoped Supabase client (authenticated role). Without EXECUTE
-- permission, PostgREST denies the call, causing all content CRUD
-- endpoints (summary-blocks, chunks, keywords, videos, summaries)
-- to return 404 "Cannot resolve institution for this resource".
--
-- The function is SECURITY DEFINER so its internal queries already
-- bypass RLS — only the EXECUTE permission was missing.
-- ============================================================

GRANT EXECUTE ON FUNCTION public.resolve_parent_institution(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_parent_institution(text, uuid) TO anon;
