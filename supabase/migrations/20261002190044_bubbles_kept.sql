-- Review editor v2 keeps "Keep both" (#345).
--
-- bubbles.kept: the owner said this bubble's overlap with another is not a
-- duplicate detection, so the editor's duplicate check skips it. Only the
-- review editor reads it; the reader, the pipeline and the audio step do not.

ALTER TABLE bubbles ADD COLUMN kept boolean NOT NULL DEFAULT false;
