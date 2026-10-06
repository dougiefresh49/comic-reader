CREATE TABLE character_face_exemplars (
  id            uuid primary key default gen_random_uuid(),
  character_id  text not null references characters(id),
  book_id       text not null,
  source_issue  text not null,
  page_number   int not null,
  crop_path     text not null,
  confidence    real not null default 0,
  is_confirmed  boolean default false,
  created_at    timestamptz default now()
);

CREATE INDEX face_exemplars_book ON character_face_exemplars(book_id, character_id)
  WHERE is_confirmed = true;

ALTER TABLE character_face_exemplars ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.character_face_exemplars TO service_role;
GRANT SELECT ON public.character_face_exemplars TO anon;
CREATE POLICY "public read" ON public.character_face_exemplars FOR SELECT TO public USING (true);
