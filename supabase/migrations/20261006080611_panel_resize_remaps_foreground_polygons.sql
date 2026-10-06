-- A panel's foreground polygons follow it when its box changes (#511).
--
-- Rule: a foreground polygon keeps its place on the page when its panel's box
-- changes. panels.foreground_polygons holds
--   { characters: [[{x,y},...], ...], bubbles: [[{x,y},...], ...] }
-- with every point a fraction of the panel's own bounding_box, unclamped, so
-- a moved or resized panel left its polygons on a different part of the page,
-- and the reader's panel view drew them there. #454 fixed the same defect for
-- face boxes with an AFTER trigger on panels; the polygons live on the panels
-- row itself, so this one is a BEFORE trigger that rewrites
-- NEW.foreground_polygons.
--
-- remap_panel_foreground_polygons: when a panel's bounding_box changes, each
-- stored point is turned into page coordinates with the old panel box and
-- back into fractions of the new one. With O the old panel box, N the new one
-- and p the stored point, in float8 and with no rounding:
--   x' = (O.x + p.x * O.w - N.x) / N.w
--   y' = (O.y + p.y * O.h - N.y) / N.h
-- Like the face function it pins extra_float_digits, so the numbers are
-- written back at full float8 precision whatever the caller's session has.
-- No clamp: a point outside the new box keeps a fraction below 0 or above 1,
-- as the polygons are already stored, and resizing the panel back restores it.
--
-- The writer's own polygons win. When the statement also sets
-- foreground_polygons to something other than what is stored (new polygons,
-- or null), they are taken as already in the new box's frame and kept as
-- sent. Polygons that arrive equal to the stored ones are in the old frame
-- and are re-mapped. No writer today sends a new box and new polygons in one
-- statement: the masks step and scripts/backfill-foreground-polygons.ts write
-- polygons alone, and the review editor's Save never sends the column.
--
-- A point is re-mapped when it is a JSON object whose x and y are both JSON
-- numbers, inside an array, inside characters or bubbles when that key holds
-- an array. Polygon order and point order are kept, and any other key on a
-- point or at the top level is kept. What happens to everything else:
--   - The panel has no such point (null polygons, empty lists, or nothing of
--     that shape): this trigger leaves the write alone. Such a panel takes
--     any box, as before.
--   - The new box is not usable and the panel has such a point: the write is
--     refused. Letting it through would leave the polygons as fractions of a
--     box the panel no longer has.
--   - The old box is not usable: it gave the polygons no place on the page to
--     keep, so they stay as they were.
--   - A point without both numbers, a polygon that is not an array, and a
--     characters or bubbles value that is not an array stay as they were. An
--     empty list stays an empty list.
-- A point is never written with a null or a non-number in x or y. Numbers
-- that overflow float8 fail the write of a panel that has such a point.
--
-- panel_box_usable is the one home for "usable box", which both triggers
-- read: x, y, w and h are all JSON numbers and w and h are above 0. A null or
-- non-object box is not usable, and the check never raises.
-- remap_panel_face_boxes is replaced only to call it; it behaves as before.

CREATE FUNCTION panel_box_usable(box jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  -- The casts run only on values already known to be numbers.
  SELECT CASE
    WHEN jsonb_typeof(box -> 'x') = 'number'
     AND jsonb_typeof(box -> 'y') = 'number'
     AND jsonb_typeof(box -> 'w') = 'number'
     AND jsonb_typeof(box -> 'h') = 'number'
    THEN (box ->> 'w')::numeric > 0 AND (box ->> 'h')::numeric > 0
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION remap_panel_face_boxes()
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

  old_ok := panel_box_usable(o);
  new_ok := panel_box_usable(nb);

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

CREATE FUNCTION remap_panel_foreground_polygons()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
SET extra_float_digits = 1
AS $$
DECLARE
  o jsonb := OLD.bounding_box;
  nb jsonb := NEW.bounding_box;
  fp jsonb := OLD.foreground_polygons;
  k text;
BEGIN
  -- The statement sent polygons of its own: they are in the new box's frame.
  IF NEW.foreground_polygons IS DISTINCT FROM OLD.foreground_polygons THEN
    RETURN NEW;
  END IF;

  -- No point to re-map. jsonb_array_elements runs only on arrays.
  IF NOT EXISTS (
    SELECT 1
      FROM unnest(ARRAY['characters', 'bubbles']) AS l(key)
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(fp -> l.key) = 'array' THEN fp -> l.key ELSE '[]'::jsonb END
     ) AS p(poly)
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(p.poly) = 'array' THEN p.poly ELSE '[]'::jsonb END
     ) AS q(pt)
     WHERE jsonb_typeof(q.pt -> 'x') = 'number'
       AND jsonb_typeof(q.pt -> 'y') = 'number'
  ) THEN
    RETURN NEW;
  END IF;

  IF NOT panel_box_usable(nb) THEN
    RAISE EXCEPTION 'panel % has stored foreground polygons, and they cannot be re-mapped into bounding_box %: x, y, w and h must be numbers, with w and h above 0', NEW.id, nb;
  END IF;
  IF NOT panel_box_usable(o) THEN
    RETURN NEW;
  END IF;

  FOREACH k IN ARRAY ARRAY['characters', 'bubbles'] LOOP
    CONTINUE WHEN jsonb_typeof(fp -> k) IS DISTINCT FROM 'array';
    fp := jsonb_set(fp, ARRAY[k], (
      SELECT COALESCE(jsonb_agg(
        CASE WHEN jsonb_typeof(p.poly) = 'array' THEN (
          SELECT COALESCE(jsonb_agg(
            CASE WHEN jsonb_typeof(q.pt -> 'x') = 'number' AND jsonb_typeof(q.pt -> 'y') = 'number'
            THEN q.pt || jsonb_build_object(
              'x', ((o ->> 'x')::float8 + (q.pt ->> 'x')::float8 * (o ->> 'w')::float8 - (nb ->> 'x')::float8) / (nb ->> 'w')::float8,
              'y', ((o ->> 'y')::float8 + (q.pt ->> 'y')::float8 * (o ->> 'h')::float8 - (nb ->> 'y')::float8) / (nb ->> 'h')::float8
            )
            ELSE q.pt END
            ORDER BY q.j), '[]'::jsonb)
            FROM jsonb_array_elements(p.poly) WITH ORDINALITY AS q(pt, j)
        )
        ELSE p.poly END
        ORDER BY p.i), '[]'::jsonb)
        FROM jsonb_array_elements(fp -> k) WITH ORDINALITY AS p(poly, i)
    ));
  END LOOP;

  NEW.foreground_polygons := fp;
  RETURN NEW;
END;
$$;

CREATE TRIGGER panels_remap_foreground_polygons
  BEFORE UPDATE OF bounding_box ON panels
  FOR EACH ROW
  WHEN (OLD.bounding_box IS DISTINCT FROM NEW.bounding_box)
  EXECUTE FUNCTION remap_panel_foreground_polygons();
