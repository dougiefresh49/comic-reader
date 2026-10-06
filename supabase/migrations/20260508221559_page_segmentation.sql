CREATE TABLE IF NOT EXISTS page_segmentation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id       text NOT NULL,
  issue_id      text NOT NULL,
  page_number   int NOT NULL,
  image_width   int NOT NULL,
  image_height  int NOT NULL,
  predictions   jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz DEFAULT now(),
  UNIQUE (book_id, issue_id, page_number)
);

CREATE INDEX page_seg_lookup ON page_segmentation(book_id, issue_id, page_number);

ALTER TABLE page_segmentation ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.page_segmentation TO service_role;
GRANT SELECT ON public.page_segmentation TO anon;
CREATE POLICY "public read" ON public.page_segmentation FOR SELECT TO public USING (true);
