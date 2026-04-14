-- Add block_id to text_annotations so highlights can be scoped per block.
-- This enables the book-style footnote indicators in ViewerBlock.
ALTER TABLE text_annotations
  ADD COLUMN IF NOT EXISTS block_id UUID REFERENCES summary_blocks(id) ON DELETE CASCADE;

-- Index for fast per-block annotation lookups
CREATE INDEX IF NOT EXISTS idx_text_annotations_block
  ON text_annotations (block_id)
  WHERE block_id IS NOT NULL AND deleted_at IS NULL;
