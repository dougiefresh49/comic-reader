-- Review editor v2 Save (#328).
--
-- 1. bubbles.silent: a spoken bubble the owner chose to leave without audio.
--    The reader still shows it; the audio step skips it the way it skips an
--    ignored one (decisions row 228).
--
-- 2. save_review_edits: applies one Save's row writes in one transaction, so
--    a Save lands whole or not at all. It is a plain executor: the rules for
--    what an edit writes live in src/app/api/apply-fixes/write-rules.ts, and
--    this function only runs the list it is given, in order.
--
--    p_ops is a JSON array of writes, each one of
--      {"op": "insert", "table": "bubbles" | "panels", "row": {...}}
--      {"op": "update", "table": ..., "id": "<uuid>", "row": {...}}
--      {"op": "delete", "table": ..., "id": "<uuid>"}
--    "row" holds column names and values. An insert gets this call's book and
--    issue whatever its row says. An update or delete matches the row by id,
--    book and issue, and raises unless exactly one row matched, so a Save that
--    names a bubble or panel that no longer exists changes nothing.
--    Returns the number of writes applied.

ALTER TABLE bubbles ADD COLUMN silent boolean NOT NULL DEFAULT false;

CREATE FUNCTION save_review_edits(
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
BEGIN
  IF jsonb_typeof(p_ops) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'save_review_edits: the writes must be a JSON array';
  END IF;

  FOR op IN SELECT value FROM jsonb_array_elements(p_ops) LOOP
    n := n + 1;
    tbl := op->>'table';
    kind := op->>'op';
    fields := COALESCE(op->'row', '{}'::jsonb);

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
      RAISE EXCEPTION 'save_review_edits: write % has op %, not insert, update or delete', n, kind;
    END IF;
  END LOOP;

  RETURN n;
END;
$$;

REVOKE EXECUTE ON FUNCTION save_review_edits(text, text, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION save_review_edits(text, text, jsonb) TO service_role;
