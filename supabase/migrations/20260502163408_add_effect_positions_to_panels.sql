-- Production's migration history holds this version, and until #472 no
-- file did. The statement below is the one the history row recorded.

ALTER TABLE panels ADD COLUMN IF NOT EXISTS effect_positions jsonb DEFAULT NULL;
