-- Allow unresolved face detections and exemplars to be stored without a
-- confirmed character_id. The suggested_name column holds Gemini's best guess
-- so a human can label the character later and backfill the FK.

-- panel_character_detections: make character_id nullable, add suggested_name
ALTER TABLE panel_character_detections
  ALTER COLUMN character_id DROP NOT NULL;

ALTER TABLE panel_character_detections
  ADD COLUMN IF NOT EXISTS suggested_name text;

CREATE INDEX IF NOT EXISTS idx_panel_char_det_unresolved
  ON panel_character_detections (suggested_name)
  WHERE character_id IS NULL;

-- character_face_exemplars: make character_id nullable, add suggested_name
ALTER TABLE character_face_exemplars
  ALTER COLUMN character_id DROP NOT NULL;

ALTER TABLE character_face_exemplars
  ADD COLUMN IF NOT EXISTS suggested_name text;

CREATE INDEX IF NOT EXISTS idx_face_exemplars_unresolved
  ON character_face_exemplars (suggested_name)
  WHERE character_id IS NULL;
