-- bubbles.audio_hash (#106): the content hash of the TTS request that
-- rendered audio_storage_path (`audioHash` in src/lib/tts-hash.ts: voice,
-- model, settings, text, and the context texts when sent). Review regenerate
-- compares it with the hash of the request it would send and skips the paid
-- call when they match. Null means unknown: audio rendered before this
-- change, or a path some other writer set. No backfill, so issues 1 and 2
-- keep a null hash; the audio step only selects rows with no path, so it
-- never re-renders them.
--
-- Both audio-take switches gain p_audio_hash, written wherever they write
-- audio_storage_path. It comes last and defaults to null, for the reason
-- 20261009180000_bubbles_voice_id.sql gives for p_voice_id: a caller on the
-- old signature resolves to the new function and clears the hash rather
-- than failing after its ElevenLabs call. The old signatures are dropped
-- first so no stale overload remains. The bodies, security settings and
-- grants are otherwise those of 20261009180000_bubbles_voice_id.sql.

alter table bubbles
  add column audio_hash text;

comment on column bubbles.audio_hash is
  'sha256 of the TTS request that rendered audio_storage_path (#106); null means unknown.';

-- A writer that changes audio_storage_path without setting audio_hash (the
-- review Save in write-rules.ts copies paths between rows, scripts point rows
-- at clips) must not leave the old take's hash on the new path, or a later
-- regenerate would skip a bubble whose audio no longer matches.
CREATE OR REPLACE FUNCTION bubbles_clear_stale_audio_hash()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.audio_hash := NULL;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bubbles_clear_stale_audio_hash
  BEFORE UPDATE ON bubbles
  FOR EACH ROW
  WHEN (
    NEW.audio_storage_path IS DISTINCT FROM OLD.audio_storage_path
    AND NEW.audio_hash IS NOT DISTINCT FROM OLD.audio_hash
  )
  EXECUTE FUNCTION bubbles_clear_stale_audio_hash();

DROP FUNCTION switch_bubble_audio_take(uuid, text, text, text, jsonb, jsonb, uuid);

-- Switch a bubble to a new audio take in one transaction: the word timings
-- row, bubbles.audio_storage_path, voice_id and audio_hash change together
-- or not at all (#191, #748, #106). Returns the audio_storage_path the
-- switch replaced. Raises when no bubbles row matches all three ids.
CREATE OR REPLACE FUNCTION switch_bubble_audio_take(
  p_bubble_id uuid,
  p_book_id text,
  p_issue_id text,
  p_audio_storage_path text,
  p_alignment jsonb,
  p_normalized_alignment jsonb,
  p_voice_id uuid DEFAULT NULL,
  p_audio_hash text DEFAULT NULL
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

  -- The hash goes in its own UPDATE, after the path. The first one changes
  -- the path, so bubbles_clear_stale_audio_hash nulls the hash; this one
  -- leaves the path alone, so the trigger lets it through. Setting both in
  -- one UPDATE would lose the hash of a forced re-render whose hash did not
  -- change.
  UPDATE bubbles b SET audio_hash = p_audio_hash
  WHERE b.id = p_bubble_id
    AND b.book_id = p_book_id
    AND b.issue_id = p_issue_id;

  RETURN previous_path;
END;
$$;

REVOKE EXECUTE ON FUNCTION switch_bubble_audio_take(uuid, text, text, text, jsonb, jsonb, uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION switch_bubble_audio_take(uuid, text, text, text, jsonb, jsonb, uuid, text) TO service_role;

DROP FUNCTION switch_group_audio_take(text, text, uuid, uuid[], uuid, text, jsonb, jsonb, uuid);

-- Switch a group of joined balloons to a new group take in one transaction,
-- the group variant of switch_bubble_audio_take (#191, #451): the lead's word
-- timings row, the other members' old per-balloon timings and every member's
-- audio_storage_path, voice_id and audio_hash change together or not at all.
-- The guards and their exceptions are unchanged from
-- 20261009180000_bubbles_voice_id.sql. Returns the lead's audio_storage_path
-- before the switch.
CREATE OR REPLACE FUNCTION switch_group_audio_take(
  p_book_id text,
  p_issue_id text,
  p_group_id uuid,
  p_member_ids uuid[],
  p_lead_id uuid,
  p_audio_storage_path text,
  p_alignment jsonb,
  p_normalized_alignment jsonb,
  p_voice_id uuid DEFAULT NULL,
  p_audio_hash text DEFAULT NULL
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

  -- The hash goes in its own UPDATE, after the path. The first one changes
  -- the path, so bubbles_clear_stale_audio_hash nulls the hash; this one
  -- leaves the path alone, so the trigger lets it through. Setting both in
  -- one UPDATE would lose the hash of a forced re-render whose hash did not
  -- change.
  UPDATE bubbles b SET audio_hash = p_audio_hash
  WHERE b.id = ANY (p_member_ids)
    AND b.book_id = p_book_id
    AND b.issue_id = p_issue_id;

  RETURN previous_path;
END;
$$;

REVOKE EXECUTE ON FUNCTION switch_group_audio_take(text, text, uuid, uuid[], uuid, text, jsonb, jsonb, uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION switch_group_audio_take(text, text, uuid, uuid[], uuid, text, jsonb, jsonb, uuid, text) TO service_role;
