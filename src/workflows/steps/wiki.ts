export async function fetchWikiContextStep(bookId: string, issueId: string) {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();

  const { fetchAndStoreWikiContext } = await import("~/lib/wiki-fetch");
  const context = await fetchAndStoreWikiContext(supabase, bookId, issueId);

  console.log(
    `[wiki-step] ${bookId}/${issueId}: summary=${context.summary ? "yes" : "no"}, appearances=${context.appearances?.length ?? 0}`,
  );

  return context;
}
