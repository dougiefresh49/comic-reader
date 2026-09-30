-- books.published (#131).
--
-- A book is a draft until the owner publishes it from /admin. Public routes
-- (the library, /book/<bookId>/...) show published books only; the admin
-- preview route opens drafts. New rows default to false, so smart add and
-- every script that upserts a book create drafts. The backfill publishes
-- tmnt-mmpr-iii, the one book kids read today. Every other existing row,
-- smoke-test included, keeps the default and goes dark.

alter table books
  add column if not exists published boolean not null default false;

update books
  set published = true
  where id = 'tmnt-mmpr-iii';
