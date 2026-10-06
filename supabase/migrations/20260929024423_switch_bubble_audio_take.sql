-- Switch a bubble to a new audio take in one transaction: the word timings
-- row and bubbles.audio_storage_path change together or not at all, so the
-- reader never plays one take against another take's timings (#191).
-- Returns the audio_storage_path the switch replaced. The regenerate action
-- keeps that object, because pages rendered before the switch still play it.
-- Raises when no bubbles row matches all three ids.
CREATE FUNCTION switch_bubble_audio_take(
  p_bubble_id uuid,
  p_book_id text,
  p_issue_id text,
  p_audio_storage_path text,
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
    needs_audio = false,
    updated_at = now()
  WHERE b.id = p_bubble_id
    AND b.book_id = p_book_id
    AND b.issue_id = p_issue_id;

  RETURN previous_path;
END;
$$;

REVOKE EXECUTE ON FUNCTION switch_bubble_audio_take(uuid, text, text, text, jsonb, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION switch_bubble_audio_take(uuid, text, text, text, jsonb, jsonb) TO service_role;
