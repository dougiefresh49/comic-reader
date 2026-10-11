export async function fetchWikiContextStep(bookId: string, issueId: string) {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();

  const { fetchAndStoreWikiContext } = await import("~/lib/wiki-fetch");
  const context = await fetchAndStoreWikiContext(supabase, bookId, issueId);

  // Comic Vine's cast (#851) is separate from the wiki's: it runs whether or
  // not the book has a wiki, and a failure leaves only its own column empty.
  const { fetchAndStoreComicVineCast } = await import("~/lib/comicvine");
  const comicvine = await fetchAndStoreComicVineCast(supabase, bookId, issueId);

  console.log(
    `[wiki-step] ${bookId}/${issueId}: summary=${context.summary ? "yes" : "no"}, appearances=${context.appearances?.length ?? 0}, comicvine=${comicvine?.length ?? "none"}`,
  );

  return context;
}
