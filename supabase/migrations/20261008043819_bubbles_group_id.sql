-- bubbles.group_id (#451): joined balloons. When one line is split across
-- touching balloons, the members share a group_id; the group gets one speaker,
-- one context and one clip. The lead is the member with the lowest
-- sort_order, computed and never stored. The lead's audio_timestamps row holds
-- the group alignment and every member's audio_storage_path holds the group
-- clip's path; the reader plays a group as one unit only when every member
-- shares the lead's non-null path and the lead has timestamps
-- (src/lib/balloon-groups.ts).
--
-- Additive only: one nullable column (every existing row reads as standing
-- alone), one partial index, one new function. The table's RLS and grants are
-- unchanged.

alter table bubbles
  add column group_id uuid;

comment on column bubbles.group_id is
  'Joined balloons (#451): balloons that carry one line share a group_id; null means the balloon stands alone. The lead is the member with the lowest sort_order.';

create index bubbles_group_idx on bubbles (book_id, issue_id, group_id)
  where group_id is not null;

-- Switch a group of joined balloons to a new group take in one transaction,
-- the group variant of switch_bubble_audio_take (#191): the lead's word
-- timings row, the other members' old per-balloon timings and every member's
-- audio_storage_path change together or not at all, so the reader never plays
-- the group clip against a per-balloon alignment. The other members' timings
-- rows are deleted because their alignments do not match the group clip.
-- Returns the lead's audio_storage_path before the switch.
-- Raises when p_lead_id is not one of p_member_ids, or when any member has no
-- bubbles row in p_book_id/p_issue_id.
CREATE FUNCTION switch_group_audio_take(
  p_book_id text,
  p_issue_id text,
  p_member_ids uuid[],
  p_lead_id uuid,
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
  member_count integer;
  found_count integer;
BEGIN
  IF p_lead_id IS NULL
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
    needs_audio = false,
    updated_at = now()
  WHERE b.id = ANY (p_member_ids)
    AND b.book_id = p_book_id
    AND b.issue_id = p_issue_id;

  RETURN previous_path;
END;
$$;

REVOKE EXECUTE ON FUNCTION switch_group_audio_take(text, text, uuid[], uuid, text, jsonb, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION switch_group_audio_take(text, text, uuid[], uuid, text, jsonb, jsonb) TO service_role;
