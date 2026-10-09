-- Voice Design takes (#788): the design sheet stores each take's audio here
-- until Confirm saves one as a voice. Private, with no RLS policies: only the
-- service role reads and writes it, and the sheet plays a take by signed URL.
insert into storage.buckets (id, name, public)
values ('comic-voice-previews', 'comic-voice-previews', false)
on conflict (id) do nothing;
