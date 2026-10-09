-- The review editor adds a character to the cast on Save (#416).
--
-- save_review_edits (from 20261002003000_review_editor_save.sql) gains two
-- writes, so a Save that adds a character lands whole or not at all: the
-- character, its castlist row and the bubbles that name it in one
-- transaction. Same signature, return type, security and grants; every
-- existing write behaves as before. It stays a plain executor: which name is
-- new, its id, its franchise and its starting voice are decided by
-- src/app/api/apply-fixes/write-rules.ts (planCastAdds), and this function
-- only runs the list it is given, in order.
--
--    p_ops is a JSON array of writes, each one of
--      {"op": "insert", "table": "bubbles" | "panels", "row": {...}}
--      {"op": "update", "table": ..., "id": "<uuid>", "row": {...}}
--      {"op": "delete", "table": ..., "id": "<uuid>"}
--      {"op": "add_character", "id": "<slug>", "display_name": "...",
--       "franchise_id": "<franchises.id>" | null}
--      {"op": "add_to_cast", "character_id": "<characters.id>",
--       "voice_uuid": "<voices.id>" | null}
--    The first three are unchanged: "row" holds column names and values. An
--    insert gets this call's book and issue whatever its row says. An update
--    or delete matches the row by id, book and issue, and raises unless
--    exactly one row matched, so a Save that names a bubble or panel that no
--    longer exists changes nothing.
--    add_character inserts one characters row (id, display_name,
--    franchise_id; it has no book or issue). It raises when a character with
--    that id already exists, so a name is never merged into another
--    character's row behind the owner's back.
--    add_to_cast puts a character in this call's book and issue's cast: it
--    inserts the castlist row (in_issue true, no_audio false, voice_uuid as
--    given) when there is none, and otherwise sets in_issue true and leaves
--    voice_uuid and no_audio as they are.
--    bubbles.character_id and castlist.character_id reference characters(id),
--    so the caller puts add_character before the writes that name it.
--    Returns the number of writes applied.

CREATE OR REPLACE FUNCTION save_review_edits(
  p_book_id text,
  p_issue_id text,
  p_ops jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  op jsonb;
  n integer := 0;
  tbl text;
  kind text;
  fields jsonb;
  target uuid;
  cols text;
  vals text;
  touched integer;
  cid text;
BEGIN
  IF jsonb_typeof(p_ops) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'save_review_edits: the writes must be a JSON array';
  END IF;

  FOR op IN SELECT value FROM jsonb_array_elements(p_ops) LOOP
    n := n + 1;
    tbl := op->>'table';
    kind := op->>'op';
    fields := COALESCE(op->'row', '{}'::jsonb);

    IF kind = 'add_character' THEN
      cid := op->>'id';
      IF cid IS NULL OR btrim(cid) = '' THEN
        RAISE EXCEPTION 'save_review_edits: write % adds a character with no id', n;
      END IF;
      IF btrim(COALESCE(op->>'display_name', '')) = '' THEN
        RAISE EXCEPTION 'save_review_edits: write % adds character % with no name', n, cid;
      END IF;
      IF EXISTS (SELECT 1 FROM characters WHERE id = cid) THEN
        RAISE EXCEPTION 'save_review_edits: a character with id % already exists, so nothing was saved', cid;
      END IF;
      INSERT INTO characters (id, display_name, franchise_id)
        VALUES (cid, op->>'display_name', op->>'franchise_id');
      CONTINUE;
    END IF;

    IF kind = 'add_to_cast' THEN
      cid := op->>'character_id';
      IF cid IS NULL OR btrim(cid) = '' THEN
        RAISE EXCEPTION 'save_review_edits: write % adds no character to the cast', n;
      END IF;
      INSERT INTO castlist (book_id, issue_id, character_id, in_issue, no_audio, voice_uuid)
        VALUES (p_book_id, p_issue_id, cid, true, false, (op->>'voice_uuid')::uuid)
        ON CONFLICT (book_id, issue_id, character_id) DO UPDATE SET in_issue = true;
      CONTINUE;
    END IF;

    IF tbl IS NULL OR tbl NOT IN ('bubbles', 'panels') THEN
      RAISE EXCEPTION 'save_review_edits: write % names table %, not bubbles or panels', n, tbl;
    END IF;
    IF jsonb_typeof(fields) <> 'object' THEN
      RAISE EXCEPTION 'save_review_edits: write % has a row that is not an object', n;
    END IF;

    IF kind = 'insert' THEN
      IF NOT fields ? 'id' THEN
        RAISE EXCEPTION 'save_review_edits: insert % into % has no id', n, tbl;
      END IF;
      fields := fields || jsonb_build_object('book_id', p_book_id, 'issue_id', p_issue_id);
      SELECT string_agg(format('%I', k), ', '), string_agg(format('r.%I', k), ', ')
        INTO cols, vals
        FROM jsonb_object_keys(fields) AS k;
      EXECUTE format(
        'INSERT INTO %I (%s) SELECT %s FROM jsonb_populate_record(NULL::%I, $1) AS r',
        tbl, cols, vals, tbl
      ) USING fields;

    ELSIF kind = 'update' THEN
      target := (op->>'id')::uuid;
      IF fields = '{}'::jsonb THEN
        RAISE EXCEPTION 'save_review_edits: update % of % % sets no column', n, tbl, target;
      END IF;
      IF fields ?| ARRAY['id', 'book_id', 'issue_id'] THEN
        RAISE EXCEPTION 'save_review_edits: update % of % % tries to change its id, book or issue', n, tbl, target;
      END IF;
      SELECT string_agg(format('%I = r.%I', k, k), ', ')
        INTO cols
        FROM jsonb_object_keys(fields) AS k;
      EXECUTE format(
        'UPDATE %I AS t SET %s, updated_at = now() FROM jsonb_populate_record(NULL::%I, $1) AS r WHERE t.id = $2 AND t.book_id = $3 AND t.issue_id = $4',
        tbl, cols, tbl
      ) USING fields, target, p_book_id, p_issue_id;
      GET DIAGNOSTICS touched = ROW_COUNT;
      IF touched <> 1 THEN
        RAISE EXCEPTION 'save_review_edits: no % row % in %/% to update, so nothing was saved', tbl, target, p_book_id, p_issue_id;
      END IF;

    ELSIF kind = 'delete' THEN
      target := (op->>'id')::uuid;
      EXECUTE format(
        'DELETE FROM %I WHERE id = $1 AND book_id = $2 AND issue_id = $3',
        tbl
      ) USING target, p_book_id, p_issue_id;
      GET DIAGNOSTICS touched = ROW_COUNT;
      IF touched <> 1 THEN
        RAISE EXCEPTION 'save_review_edits: no % row % in %/% to delete, so nothing was saved', tbl, target, p_book_id, p_issue_id;
      END IF;

    ELSE
      RAISE EXCEPTION 'save_review_edits: write % has op %, not insert, update, delete, add_character or add_to_cast', n, kind;
    END IF;
  END LOOP;

  RETURN n;
END;
$$;

REVOKE EXECUTE ON FUNCTION save_review_edits(text, text, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION save_review_edits(text, text, jsonb) TO service_role;
