-- Scene save in one transaction (#522).
--
-- save_music_scenes: replaces an issue's music scenes in one transaction, so a
-- scene save lands whole or not at all. Before it writes, it checks every
-- panel id the save names; then it clears the issue's panels' scene_id,
-- deletes the issue's scenes, and inserts each scene and assigns its panels.
--
-- p_scenes is a JSON array of scenes in save order, each one
--   {"music_mood": "<text>", "label": "<text>" | null, "panel_ids": ["<uuid>", ...]}
-- A scene's start and end panel are the first and last id it lists. A scene
-- with no panel ids is skipped. The call raises, and writes nothing, when
-- p_scenes or a scene's panel_ids is not a JSON array, when a panel id is not
-- a panel of this call's book and issue, or when a panel id appears more than
-- once in the save. Returns the number of scenes inserted.

CREATE FUNCTION save_music_scenes(
  p_book_id text,
  p_issue_id text,
  p_scenes jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  scene jsonb;
  i integer := 0;
  n integer := 0;
  bad text;
  ids uuid[];
  new_scene uuid;
BEGIN
  IF jsonb_typeof(p_scenes) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'save_music_scenes: the scenes must be a JSON array';
  END IF;

  FOR scene IN SELECT value FROM jsonb_array_elements(p_scenes) LOOP
    i := i + 1;
    IF jsonb_typeof(scene->'panel_ids') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'save_music_scenes: scene % has panel_ids that is not a JSON array', i;
    END IF;
  END LOOP;

  SELECT pid INTO bad
    FROM jsonb_array_elements(p_scenes) AS s,
         jsonb_array_elements_text(s->'panel_ids') AS pid
    GROUP BY pid
    HAVING count(*) > 1
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'save_music_scenes: panel % is in the save more than once, so nothing was saved', bad;
  END IF;

  SELECT pid INTO bad
    FROM jsonb_array_elements(p_scenes) AS s,
         jsonb_array_elements_text(s->'panel_ids') AS pid
    WHERE NOT EXISTS (
      SELECT 1 FROM panels AS p
      WHERE p.id = pid::uuid AND p.book_id = p_book_id AND p.issue_id = p_issue_id
    )
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'save_music_scenes: no panel % in %/%, so nothing was saved', bad, p_book_id, p_issue_id;
  END IF;

  UPDATE panels SET scene_id = NULL
    WHERE book_id = p_book_id AND issue_id = p_issue_id AND scene_id IS NOT NULL;

  DELETE FROM music_scenes WHERE book_id = p_book_id AND issue_id = p_issue_id;

  FOR scene IN SELECT value FROM jsonb_array_elements(p_scenes) LOOP
    ids := ARRAY(
      SELECT e.pid::uuid
        FROM jsonb_array_elements_text(scene->'panel_ids') WITH ORDINALITY AS e(pid, ord)
        ORDER BY e.ord
    );
    IF cardinality(ids) = 0 THEN
      CONTINUE;
    END IF;

    INSERT INTO music_scenes (book_id, issue_id, music_mood, label, start_panel_id, end_panel_id)
      VALUES (p_book_id, p_issue_id, scene->>'music_mood', scene->>'label', ids[1], ids[cardinality(ids)])
      RETURNING id INTO new_scene;

    UPDATE panels SET scene_id = new_scene
      WHERE id = ANY(ids) AND book_id = p_book_id AND issue_id = p_issue_id;

    n := n + 1;
  END LOOP;

  RETURN n;
END;
$$;

REVOKE EXECUTE ON FUNCTION save_music_scenes(text, text, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION save_music_scenes(text, text, jsonb) TO service_role;
