-- Comic Vine cast (#851). Additive: two nullable columns, no data change.
-- books.comicvine_volume_id is the book's Comic Vine volume, set by hand once
-- per book; the fetch step never guesses it. issues.comicvine_characters holds
-- the issue's character credits as [{id, name, aliases, deck, image_url}]:
-- [] means fetched with no credits, null means not fetched yet or the fetch
-- failed, so a later run retries (src/lib/comicvine.ts).

alter table public.books add column comicvine_volume_id integer null;

alter table public.issues add column comicvine_characters jsonb null;
