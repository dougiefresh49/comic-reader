-- Review editor v2 approves pages (#331).
--
-- pages.reviewed_at: when the owner approved the page in the review editor,
-- or null while it is not approved. Taking an approval back sets it to null.
-- "Approve issue" at the pages gate needs every page of the issue set. Only
-- the review editor reads and writes it; the reader and the pipeline do not.

ALTER TABLE pages ADD COLUMN reviewed_at timestamptz;
