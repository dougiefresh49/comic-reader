-- Download pages (#817): src/app/api/admin/download-pages/route.ts uploads
-- each fetched page to comic-pages-raw with the response's content-type, and
-- extFromUrl already names .gif pages, so a source serving GIF pages would
-- fail every page with Storage 400 (InvalidMimeType), the failure #815 fixed
-- for WebP. Finalize decodes through sharp, which reads the first frame of a
-- GIF, so the stored WebP page is the first frame. Adds one MIME type; jpeg,
-- png, webp and the 20 MB size limit are unchanged.

update storage.buckets
set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
where id = 'comic-pages-raw';
