-- Voices registry columns (#91).
--
-- `pnpm voice-lab-import` fills these from voice-lab handoffs. Purely
-- additive: new nullable or defaulted columns, nothing dropped, renamed
-- or backfilled here.
--
-- consumers:       which apps use the voice. #96's archive refuses any
--                  row whose consumers include 'room' (decisions row 23).
-- description:     the ElevenLabs description, which a recreated voice
--                  must carry.
-- labels:          the ElevenLabs labels object (accent, age, gender...).
-- source_clip_md5: md5 of the clip at source_clip_path, checked on upload.
--
-- voices.character_id is not added here; #95 owns that column.

alter table voices
  add column if not exists consumers text[] not null default '{comic}';

alter table voices
  add column if not exists description text;

alter table voices
  add column if not exists labels jsonb;

alter table voices
  add column if not exists source_clip_md5 text;
