-- The narrator row gains the "Narration" alias from ROLES in
-- src/components/review-editor/lib.ts (#365, owner answer O1 = A). #346's
-- role insert used on conflict do nothing, so the existing narrator row kept
-- aliases {Narrator}. Appends only when missing; a no-op on an empty database.

update characters
set aliases = array_append(aliases, 'Narration')
where id = 'narrator'
  and not ('Narration' = any (aliases));
