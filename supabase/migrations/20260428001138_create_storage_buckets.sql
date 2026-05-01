insert into storage.buckets (id, name, public)
values
  ('comic-pages', 'comic-pages', true),
  ('comic-audio', 'comic-audio', true),
  ('comic-pages-raw', 'comic-pages-raw', false),
  ('comic-ocr-crops', 'comic-ocr-crops', false),
  ('comic-voice-clips', 'comic-voice-clips', false)
on conflict (id) do nothing;
