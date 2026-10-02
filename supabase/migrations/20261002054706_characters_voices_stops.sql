-- Schema for the characters and voices stops (#346, item 0 of the plan on
-- #335). Additive only: every new column is nullable or has a default, so
-- today's writers keep working.
--
-- 1. casting_tasks.action and target_voice_uuid: a voice request recorded at
--    the characters stop and carried out at the voices stop. action is the
--    kind of voice asked for, a voice-lab clone or a new designed voice;
--    target_voice_uuid is the voices row the request names (the clone to
--    bring in), null for a design. Both stay null on the rows today's casting
--    gate writes until #353 converts that writer.
--
-- 2. castlist.in_issue: false when the owner removed the character from this
--    issue's cast. Removal never deletes the row, so its voice is kept.
--
-- 3. characters rows for the three roles, with the display names and aliases
--    of ROLES in src/components/review-editor/lib.ts. A row that already
--    exists is left as it is: narrator is already in prod with aliases
--    {Narrator}, so it does not gain "Narration" here.
--
-- 4. character_face_exemplars.detection_id: the detection a face crop was
--    cut from. Backfilled only where the exemplar's page has exactly one
--    detection of that character, since otherwise the crop's face is unknown.

-- 1. casting_tasks

alter table casting_tasks
  add column action text check (action in ('clone', 'design')),
  add column target_voice_uuid uuid references voices (id) on delete set null;

-- 2. castlist

alter table castlist
  add column in_issue boolean not null default true;

-- 3. role rows

insert into characters (id, display_name, aliases)
values
  ('narrator', 'Narrator', array['Narration']),
  ('off-panel', 'Off-panel', array['Off panel', 'Offscreen', 'Off-screen']),
  ('crowd', 'Crowd', array[]::text[])
on conflict (id) do nothing;

-- 4. character_face_exemplars.detection_id

alter table character_face_exemplars
  add column detection_id uuid
    references panel_character_detections (id) on delete set null;

create index character_face_exemplars_detection_id_idx
  on character_face_exemplars (detection_id);

update character_face_exemplars e
set detection_id = m.detection_id
from (
  select e2.id as exemplar_id, min(d.id::text)::uuid as detection_id
  from character_face_exemplars e2
  join panels p
    on p.book_id = e2.book_id
   and p.issue_id = e2.source_issue
   and p.page_number = e2.page_number
  join panel_character_detections d
    on d.panel_id = p.id
   and d.character_id = e2.character_id
  group by e2.id
  having count(d.id) = 1
) m
where e.id = m.exemplar_id;
