-- Add foreground_polygons to panels for the layered renderer.
--
-- Populated by the extract-foreground-masks ingest step + the
-- backfill-foreground-polygons one-shot. Shape:
--   { characters: [[{x,y},...]], bubbles: [[{x,y},...]] }
-- with all coordinates in panel-local 0..1 (fraction of panels.bounding_box).
-- Null for panels that haven't been processed yet — runtime falls back to
-- the existing un-layered render.

alter table panels add column if not exists foreground_polygons jsonb;

comment on column panels.foreground_polygons is
  'SAM3 segmentation polygons normalized to panel-local 0..1. '
  'Shape: {characters: [[{x,y},...]], bubbles: [[{x,y},...]]}. '
  'Populated by extract-foreground-masks + backfill-foreground-polygons. '
  'Null when not yet processed.';
