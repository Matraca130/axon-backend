-- Migration: Add ai_model setting to institutions table
-- Allows institution owners to choose between 'sonnet' and 'opus' AI models.
-- Default is 'sonnet' (cost-effective). 'opus' is premium.

ALTER TABLE institutions ADD COLUMN IF NOT EXISTS ai_model VARCHAR(10) DEFAULT 'sonnet';

-- CHECK constraint ensures only valid model values
ALTER TABLE institutions ADD CONSTRAINT chk_ai_model CHECK (ai_model IN ('sonnet', 'opus'));
