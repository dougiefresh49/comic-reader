-- A panel's stored face boxes follow it when its box changes (#454).
--
-- Rule: a face keeps its place on the page when its panel's box changes.
-- panel_character_detections.face_bbox is stored as fractions of its panel's
-- bounding_box, so a moved or resized panel (the review editor's Save is the
-- writer today) left every face box describing a different part of the page.
-- A row trigger on panels holds the rule for every writer, and
-- save_review_edits stays the plain executor its header says it is.
--
-- remap_panel_face_boxes: after a panel's bounding_box changes, each of that
-- panel's face boxes is turned into page coordinates with the old panel box
-- and back into fractions of the new one. With O the old panel box, N the new
-- one and f the stored face box, in float8 and with no rounding:
--   x' = (O.x + f.x * O.w - N.x) / N.w      w' = f.w * O.w / N.w
--   y' = (O.y + f.y * O.h - N.y) / N.h      h' = f.h * O.h / N.h
-- Any other key the face box holds is kept.
--
-- No clamp. A face that ends up partly or wholly outside the new box keeps
-- fractions below 0 or above 1. That is what face extraction already stores
-- (src/lib/face-extraction.ts does not clamp either), and resizing the panel
-- back restores the face box.
--
-- Left alone: when the remap cannot be computed, the face row stays as it was
-- and the panel update still succeeds. That is when any of x, y, w, h is
-- missing or not a JSON number in the old box, the new box or the face box,
-- or when the new box's w or h is not above 0. A face box is never written
-- with a null or a non-number in x, y, w, h.

CREATE FUNCTION remap_panel_face_boxes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  o jsonb := OLD.bounding_box;
  nb jsonb := NEW.bounding_box;
BEGIN
  IF NOT COALESCE(
    (SELECT bool_and(jsonb_typeof(o -> k) = 'number' AND jsonb_typeof(nb -> k) = 'number')
       FROM unnest(ARRAY['x', 'y', 'w', 'h']) AS k),
    false
  ) THEN
    RETURN NULL;
  END IF;
  IF (nb ->> 'w')::float8 <= 0 OR (nb ->> 'h')::float8 <= 0 THEN
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
