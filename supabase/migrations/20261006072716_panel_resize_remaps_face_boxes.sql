-- A panel's stored face boxes follow it when its box changes (#454).
--
-- Rule: a face keeps its place on the page when its panel's box changes.
-- panel_character_detections.face_bbox is stored as fractions of its panel's
-- bounding_box, so a moved or resized panel left every face box describing a
-- different part of the page. A row trigger on panels holds the rule for
-- every writer (the review editor's Save, and the panels upserts in
-- scripts/generate-episode.ts), and save_review_edits stays the plain
-- executor its header says it is.
--
-- remap_panel_face_boxes: after a panel's bounding_box changes, each of that
-- panel's face boxes is turned into page coordinates with the old panel box
-- and back into fractions of the new one. With O the old panel box, N the new
-- one and f the stored face box, in float8 and with no rounding:
--   x' = (O.x + f.x * O.w - N.x) / N.w      w' = f.w * O.w / N.w
--   y' = (O.y + f.y * O.h - N.y) / N.h      h' = f.h * O.h / N.h
-- Any other key the face box holds is kept. The function pins
-- extra_float_digits, so the numbers are written back at full float8
-- precision whatever the caller's session has; at 0, which some sessions run
-- with, a float8 becomes a 15-digit JSON number.
--
-- No clamp. A face that ends up partly or wholly outside the new box keeps
-- fractions below 0 or above 1. That is what face extraction already stores
-- (src/lib/face-extraction.ts does not clamp either), and resizing the panel
-- back restores the face box.
--
-- A box is usable when x, y, w and h are all JSON numbers and w and h are
-- above 0. What happens when one is not:
--   - The new box is not usable and the panel has face rows: the write is
--     refused. Letting it through would leave the faces as fractions of a box
--     the panel no longer has, and the next change would re-map them from the
--     wrong one. A panel with no face rows takes any box, as before.
--   - The old box is not usable: it gave the faces no place on the page to
--     keep, so they stay as they were.
--   - A face box without all four numbers stays as it was.
-- A face box is never written with a null or a non-number in x, y, w, h.
-- Numbers that overflow float8 fail the write of a panel that has face rows.

CREATE FUNCTION remap_panel_face_boxes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
SET extra_float_digits = 1
AS $$
DECLARE
  o jsonb := OLD.bounding_box;
  nb jsonb := NEW.bounding_box;
  old_ok boolean;
  new_ok boolean;
BEGIN
  -- A panel with no face rows is not this trigger's business.
  IF NOT EXISTS (SELECT 1 FROM panel_character_detections WHERE panel_id = NEW.id) THEN
    RETURN NULL;
  END IF;

  SELECT count(*) FILTER (WHERE jsonb_typeof(o -> k) = 'number') = 4,
         count(*) FILTER (WHERE jsonb_typeof(nb -> k) = 'number') = 4
    INTO old_ok, new_ok
    FROM unnest(ARRAY['x', 'y', 'w', 'h']) AS k;
  -- The casts run only on values already known to be numbers.
  IF new_ok THEN
    new_ok := (nb ->> 'w')::numeric > 0 AND (nb ->> 'h')::numeric > 0;
  END IF;
  IF old_ok THEN
    old_ok := (o ->> 'w')::numeric > 0 AND (o ->> 'h')::numeric > 0;
  END IF;

  IF NOT new_ok THEN
    RAISE EXCEPTION 'panel % has stored face boxes, and they cannot be re-mapped into bounding_box %: x, y, w and h must be numbers, with w and h above 0', NEW.id, nb;
  END IF;
  IF NOT old_ok THEN
    RETURN NULL;
  END IF;

  UPDATE panel_character_detections AS d
     SET face_bbox = d.face_bbox || jsonb_build_object(
       'x', ((o ->> 'x')::float8 + (d.face_bbox ->> 'x')::float8 * (o ->> 'w')::float8 - (nb ->> 'x')::float8) / (nb ->> 'w')::float8,
       'y', ((o ->> 'y')::float8 + (d.face_bbox ->> 'y')::float8 * (o ->> 'h')::float8 - (nb ->> 'y')::float8) / (nb ->> 'h')::float8,
       'w', (d.face_bbox ->> 'w')::float8 * (o ->> 'w')::float8 / (nb ->> 'w')::float8,
       'h', (d.face_bbox ->> 'h')::float8 * (o ->> 'h')::float8 / (nb ->> 'h')::float8
     )
   WHERE d.panel_id = NEW.id
     AND jsonb_typeof(d.face_bbox -> 'x') = 'number'
     AND jsonb_typeof(d.face_bbox -> 'y') = 'number'
     AND jsonb_typeof(d.face_bbox -> 'w') = 'number'
     AND jsonb_typeof(d.face_bbox -> 'h') = 'number';

  RETURN NULL;
END;
$$;

CREATE TRIGGER panels_remap_face_boxes
  AFTER UPDATE OF bounding_box ON panels
  FOR EACH ROW
  WHEN (OLD.bounding_box IS DISTINCT FROM NEW.bounding_box)
  EXECUTE FUNCTION remap_panel_face_boxes();
