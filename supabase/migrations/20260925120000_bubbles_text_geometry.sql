alter table public.bubbles add column text_geometry jsonb;

comment on column public.bubbles.text_geometry is 'Word boxes for the lettered text, page-normalized (#61): {engine, image {w, h, sha}, lines [{box, words [{t, box, conf}]}]}. Null until scripts/ocr-word-geometry.ts --write runs.';
