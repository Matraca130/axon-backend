-- =============================================================================
-- Migration: topic_difficulty_metadata
-- Date: 2026-03-21
-- Description: Adds AI-computed difficulty metadata columns to the topics table,
--              plus two RPCs: compute_cohort_difficulty and find_similar_topics.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PART 1: ALTER topics table — add difficulty metadata columns
-- ---------------------------------------------------------------------------

-- AI-computed difficulty (0.0 = trivial, 1.0 = extremely hard)
ALTER TABLE topics ADD COLUMN IF NOT EXISTS difficulty_estimate NUMERIC(3,2) DEFAULT NULL;

-- Estimated study time in minutes (AI-estimated)
ALTER TABLE topics ADD COLUMN IF NOT EXISTS estimated_study_minutes INTEGER DEFAULT NULL;

-- Bloom's taxonomy level (1=Remember, 2=Understand, 3=Apply, 4=Analyze, 5=Evaluate, 6=Create)
ALTER TABLE topics ADD COLUMN IF NOT EXISTS bloom_level SMALLINT DEFAULT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'topics_bloom_level_check'
  ) THEN
    ALTER TABLE topics ADD CONSTRAINT topics_bloom_level_check
      CHECK (bloom_level IS NULL OR (bloom_level >= 1 AND bloom_level <= 6));
  END IF;
END $$;

-- Abstraction level (1=concrete/visual, 5=abstract/molecular)
ALTER TABLE topics ADD COLUMN IF NOT EXISTS abstraction_level SMALLINT DEFAULT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'topics_abstraction_level_check'
  ) THEN
    ALTER TABLE topics ADD CONSTRAINT topics_abstraction_level_check
      CHECK (abstraction_level IS NULL OR (abstraction_level >= 1 AND abstraction_level <= 5));
  END IF;
END $$;

-- Concept density (1=few, 5=many concepts per section)
ALTER TABLE topics ADD COLUMN IF NOT EXISTS concept_density SMALLINT DEFAULT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'topics_concept_density_check'
  ) THEN
    ALTER TABLE topics ADD CONSTRAINT topics_concept_density_check
      CHECK (concept_density IS NULL OR (concept_density >= 1 AND concept_density <= 5));
  END IF;
END $$;

-- Interrelation score (1=standalone, 5=heavily dependent on other topics)
ALTER TABLE topics ADD COLUMN IF NOT EXISTS interrelation_score SMALLINT DEFAULT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'topics_interrelation_score_check'
  ) THEN
    ALTER TABLE topics ADD CONSTRAINT topics_interrelation_score_check
      CHECK (interrelation_score IS NULL OR (interrelation_score >= 1 AND interrelation_score <= 5));
  END IF;
END $$;

-- Prerequisites: array of topic UUIDs that should be studied first
ALTER TABLE topics ADD COLUMN IF NOT EXISTS prerequisite_topic_ids UUID[] DEFAULT '{}';

-- Cohort-aggregated difficulty (updated from real student data)
ALTER TABLE topics ADD COLUMN IF NOT EXISTS cohort_difficulty NUMERIC(3,2) DEFAULT NULL;

-- When was this topic last analyzed by AI
ALTER TABLE topics ADD COLUMN IF NOT EXISTS last_analyzed_at TIMESTAMPTZ DEFAULT NULL;

-- Analysis version (allows re-analysis when prompt/model improves)
ALTER TABLE topics ADD COLUMN IF NOT EXISTS analysis_version SMALLINT DEFAULT NULL;


-- ---------------------------------------------------------------------------
-- PART 2: RPC compute_cohort_difficulty
-- Computes average difficulty from real student flashcard review data.
-- Uses the reviews table (grade 0-5, item_id -> flashcards.id) filtered
-- to instrument_type = 'flashcard' and last 90 days of data.
-- Grade mapping: 0->1.0, 1->1.0, 2->0.75, 3->0.50, 4->0.25, 5->0.0
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION compute_cohort_difficulty(p_topic_id UUID)
RETURNS NUMERIC(3,2)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_difficulty NUMERIC(3,2);
BEGIN
  -- Compute average error rate from flashcard reviews.
  -- reviews.grade uses 0-5 scale (0/1=Again/fail, 2=Hard, 3=Good, 4=Easy, 5=Perfect).
  -- We normalize to difficulty: low grade = high difficulty.
  SELECT AVG(
    CASE
      WHEN r.grade <= 1 THEN 1.0
      WHEN r.grade = 2  THEN 0.75
      WHEN r.grade = 3  THEN 0.50
      WHEN r.grade = 4  THEN 0.25
      WHEN r.grade >= 5 THEN 0.0
      ELSE 0.5
    END
  )::NUMERIC(3,2)
  INTO v_difficulty
  FROM reviews r
  JOIN flashcards f ON f.id = r.item_id
  JOIN summaries s ON s.id = f.summary_id
  WHERE s.topic_id = p_topic_id
    AND r.instrument_type = 'flashcard'
    AND r.created_at > NOW() - INTERVAL '90 days';

  RETURN v_difficulty;
END;
$$;

COMMENT ON FUNCTION compute_cohort_difficulty(UUID) IS
  'Computes average difficulty (0.0-1.0) for a topic from flashcard review grades in the last 90 days.';


-- ---------------------------------------------------------------------------
-- PART 3: RPC find_similar_topics
-- Uses existing summary embeddings (vector(1536)) to find semantically
-- similar topics within the same course. Helps identify prerequisites
-- and related topics without additional AI calls.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION find_similar_topics(
  p_topic_id UUID,
  p_limit INTEGER DEFAULT 5,
  p_min_similarity FLOAT DEFAULT 0.3
)
RETURNS TABLE(
  topic_id UUID,
  topic_name TEXT,
  similarity FLOAT,
  section_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_course_id UUID;
  v_avg_embedding vector(1536);
BEGIN
  -- Get the course_id for this topic (to scope similarity to same course)
  -- Hierarchy: topics -> sections -> semesters -> courses
  SELECT c.id INTO v_course_id
  FROM topics t
  JOIN sections sec ON sec.id = t.section_id
  JOIN semesters sem ON sem.id = sec.semester_id
  JOIN courses c ON c.id = sem.course_id
  WHERE t.id = p_topic_id;

  IF v_course_id IS NULL THEN
    RETURN;
  END IF;

  -- Get average embedding for this topic's summaries
  SELECT AVG(s.embedding)::vector(1536) INTO v_avg_embedding
  FROM summaries s
  WHERE s.topic_id = p_topic_id
    AND s.embedding IS NOT NULL;

  IF v_avg_embedding IS NULL THEN
    RETURN;
  END IF;

  -- Find similar topics in the same course by cosine similarity
  RETURN QUERY
  SELECT
    t2.id AS topic_id,
    t2.name AS topic_name,
    (1 - (AVG(s2.embedding) <=> v_avg_embedding))::FLOAT AS similarity,
    sec2.name AS section_name
  FROM topics t2
  JOIN summaries s2 ON s2.topic_id = t2.id AND s2.embedding IS NOT NULL
  JOIN sections sec2 ON sec2.id = t2.section_id
  JOIN semesters sem2 ON sem2.id = sec2.semester_id
  WHERE sem2.course_id = v_course_id
    AND t2.id != p_topic_id
    AND t2.deleted_at IS NULL
  GROUP BY t2.id, t2.name, sec2.name
  HAVING (1 - (AVG(s2.embedding) <=> v_avg_embedding))::FLOAT >= p_min_similarity
  ORDER BY similarity DESC
  LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION find_similar_topics(UUID, INTEGER, FLOAT) IS
  'Finds semantically similar topics within the same course using summary embeddings (cosine similarity).';


-- ---------------------------------------------------------------------------
-- PART 4: Indexes for performance
-- ---------------------------------------------------------------------------

-- Topics that have never been analyzed (for batch analysis jobs)
CREATE INDEX IF NOT EXISTS idx_topics_last_analyzed
  ON topics(last_analyzed_at)
  WHERE last_analyzed_at IS NULL AND deleted_at IS NULL;

-- GIN index for prerequisite array lookups (e.g., "which topics depend on X?")
CREATE INDEX IF NOT EXISTS idx_topics_prerequisite_ids
  ON topics USING GIN(prerequisite_topic_ids)
  WHERE prerequisite_topic_ids != '{}';
