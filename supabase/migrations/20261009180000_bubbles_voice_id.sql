-- bubbles.voice_id (#748): the voices row that rendered a bubble's audio.
-- A bubble row records its character, not the voice that spoke it, and a
-- voice change does not flag bubbles for re-render, so the Voice tab's
-- preview could play a line rendered in a character's previous voice. The
-- audio step and regenerate-audio now record the rendering voice next to
-- audio_storage_path. Null means unknown: audio rendered before this change,
-- or audio a script pointed the row at without knowing its voice. No
-- backfill.
--
-- Both audio-take switches gain a required p_voice_id, written wherever they
-- write audio_storage_path. Adding an argument changes each signature, so
-- the old signature is dropped first and no stale overload remains. The
-- bodies, security settings and grants are otherwise those of
-- 20260929024423_switch_bubble_audio_take.sql and
-- 20261008043819_bubbles_group_id.sql.

alter table bubbles
  add column voice_id uuid references voices(id) on delete set null;

comment on column bubbles.voice_id is
  'The voices row that rendered audio_storage_path (#748); null means unknown.';

-- The preview's lookup (bubbles of a book rendered in one voice), and the
-- foreign key's on-delete scan.
create index bubbles_voice_idx on bubbles (book_id, voice_id)
  where voice_id is not null;

DROP FUNCTION switch_bubble_audio_take(uuid, text, text, text, jsonb, jsonb);

-- Switch a bubble to a new audio take in one transaction: the word timings
-- row, bubbles.audio_storage_path and bubbles.voice_id change together or
-- not at all, so the reader never plays one take against another take's
-- timings (#191). Returns the audio_storage_path the switch replaced. The
-- regenerate action keeps that object, because pages rendered before the
-- switch still play it. Raises when no bubbles row matches all three ids.
CREATE OR REPLACE FUNCTION switch_bubble_audio_take(
  p_bubble_id uuid,
  p_book_id text,
  p_issue_id text,
  p_audio_storage_path text,
  p_voice_id uuid,
  p_alignment jsonb,
  p_normalized_alignment jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  previous_path text;
BEGIN
  SELECT b.audio_storage_path INTO previous_path
  FROM bubbles b
  WHERE b.id = p_bubble_id
    AND b.book_id = p_book_id
    AND b.issue_id = p_issue_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No bubble % in %/%', p_bubble_id, p_book_id, p_issue_id;
  END IF;

  INSERT INTO audio_timestamps (bubble_id, book_id, issue_id, alignment, normalized_alignment)
  VALUES (p_bubble_id, p_book_id, p_issue_id, p_alignment, p_normalized_alignment)
  ON CONFLICT (bubble_id) DO UPDATE SET
    book_id = EXCLUDED.book_id,
    issue_id = EXCLUDED.issue_id,
    alignment = EXCLUDED.alignment,
    normalized_alignment = EXCLUDED.normalized_alignment;

  UPDATE bubbles b SET
    audio_storage_path = p_audio_storage_path,
    voice_id = p_voice_id,
    needs_audio = false,
    updated_at = now()
  WHERE b.id = p_bubble_id
    AND b.book_id = p_book_id
    AND b.issue_id = p_issue_id;

  RETURN previous_path;
END;
$$;

REVOKE EXECUTE ON FUNCTION switch_bubble_audio_take(uuid, text, text, text, uuid, jsonb, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION switch_bubble_audio_take(uuid, text, text, text, uuid, jsonb, jsonb) TO service_role;

DROP FUNCTION switch_group_audio_take(text, text, uuid, uuid[], uuid, text, jsonb, jsonb);

-- Switch a group of joined balloons to a new group take in one transaction,
-- the group variant of switch_bubble_audio_take (#191, #451): the lead's word
-- timings row, the other members' old per-balloon timings and every member's
-- audio_storage_path and voice_id change together or not at all. The guards
-- and their exceptions are unchanged from 20261008043819_bubbles_group_id.sql.
-- Returns the lead's audio_storage_path before the switch.
CREATE OR REPLACE FUNCTION switch_group_audio_take(
  p_book_id text,
  p_issue_id text,
  p_group_id uuid,
  p_member_ids uuid[],
  p_lead_id uuid,
  p_audio_storage_path text,
  p_voice_id uuid,
  p_alignment jsonb,
  p_normalized_alignment jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  previous_path text;
  member_count integer;
  found_count integer;
  group_count integer;
  lowest_id uuid;
BEGIN
  IF p_group_id IS NULL
    OR p_lead_id IS NULL
    OR p_member_ids IS NULL
    OR array_position(p_member_ids, NULL) IS NOT NULL
    OR NOT (p_lead_id = ANY (p_member_ids)) THEN
    RAISE EXCEPTION 'Lead % is not one of the members % in %/%',
      p_lead_id, p_member_ids, p_book_id, p_issue_id;
  END IF;

  SELECT count(DISTINCT m) INTO member_count FROM unnest(p_member_ids) AS m;

  SELECT count(*) INTO found_count
  FROM (
    SELECT b.id
    FROM bubbles b
    WHERE b.id = ANY (p_member_ids)
      AND b.book_id = p_book_id
      AND b.issue_id = p_issue_id
    FOR UPDATE
  ) locked;
  IF found_count <> member_count THEN
    RAISE EXCEPTION 'Only % of % group members % found in %/%',
      found_count, member_count, p_member_ids, p_book_id, p_issue_id;
  END IF;

  -- The rows are locked; now check they still form exactly this group.
  SELECT count(*) INTO group_count
  FROM bubbles b
  WHERE b.book_id = p_book_id
    AND b.issue_id = p_issue_id
    AND b.group_id = p_group_id;
  IF group_count <> member_count
    OR EXISTS (
      SELECT 1 FROM bubbles b
      WHERE b.id = ANY (p_member_ids)
        AND b.group_id IS DISTINCT FROM p_group_id
    ) THEN
    RAISE EXCEPTION 'Group % in %/% no longer matches members % (stale render)',
      p_group_id, p_book_id, p_issue_id, p_member_ids;
  END IF;

  SELECT b.id INTO lowest_id
  FROM bubbles b
  WHERE b.book_id = p_book_id
    AND b.issue_id = p_issue_id
    AND b.group_id = p_group_id
  ORDER BY b.sort_order, b.id
  LIMIT 1;
  IF lowest_id <> p_lead_id THEN
    RAISE EXCEPTION 'Lead % is not the first member of group % (expected %)',
      p_lead_id, p_group_id, lowest_id;
  END IF;

  SELECT b.audio_storage_path INTO previous_path
  FROM bubbles b
  WHERE b.id = p_lead_id
    AND b.book_id = p_book_id
    AND b.issue_id = p_issue_id;

  INSERT INTO audio_timestamps (bubble_id, book_id, issue_id, alignment, normalized_alignment)
  VALUES (p_lead_id, p_book_id, p_issue_id, p_alignment, p_normalized_alignment)
  ON CONFLICT (bubble_id) DO UPDATE SET
    book_id = EXCLUDED.book_id,
    issue_id = EXCLUDED.issue_id,
    alignment = EXCLUDED.alignment,
    normalized_alignment = EXCLUDED.normalized_alignment;

  DELETE FROM audio_timestamps t
  WHERE t.bubble_id = ANY (p_member_ids)
    AND t.bubble_id <> p_lead_id;

  UPDATE bubbles b SET
    audio_storage_path = p_audio_storage_path,
    voice_id = p_voice_id,
    needs_audio = false,
    updated_at = now()
  WHERE b.id = ANY (p_member_ids)
    AND b.book_id = p_book_id
    AND b.issue_id = p_issue_id;

  RETURN previous_path;
END;
$$;

REVOKE EXECUTE ON FUNCTION switch_group_audio_take(text, text, uuid, uuid[], uuid, text, uuid, jsonb, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION switch_group_audio_take(text, text, uuid, uuid[], uuid, text, uuid, jsonb, jsonb) TO service_role;
