-- From my computer (#815): let comic-pages-raw hold WebP sources.
--
-- The add flow's disk picker accepts image/webp (DISK_TYPES), and uploadPages
-- PUTs each file with content-type: file.type. The bucket allowed jpeg and
-- png only, so every WebP page failed with upload HTTP 400 and finalize never
-- ran. Found when adding Turtles of Grayskull issue 1 (27 .webp files).
-- Adds one MIME type; jpeg, png and the 20 MB size limit are unchanged.

update storage.buckets
set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'comic-pages-raw';
