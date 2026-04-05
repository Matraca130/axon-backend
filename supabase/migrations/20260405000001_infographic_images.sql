-- Infographic images: Instagram-style educational infographics for summaries
-- Storage bucket: infographic-images
-- Endpoint: POST /server/summaries/:id/generate-infographics

-- Add image_type column to distinguish infographic vs diagram vs flashcard
-- in the shared image_generation_log table.
-- Default 'diagram' preserves existing rows (summary-block-images).
ALTER TABLE image_generation_log
  ADD COLUMN IF NOT EXISTS image_type TEXT DEFAULT 'diagram';

-- Index for filtering infographics in analytics
CREATE INDEX IF NOT EXISTS idx_image_gen_log_type
  ON image_generation_log(image_type, created_at DESC);

COMMENT ON COLUMN image_generation_log.image_type IS
  'Type of generated image: diagram (summary block), flashcard, infographic';
