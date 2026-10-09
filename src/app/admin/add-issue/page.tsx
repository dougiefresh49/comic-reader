import { redirect } from "next/navigation";

/** Add Issue opens the Add content flow at its Issue step (#793). */
export default async function AddIssuePage({
  searchParams,
}: {
  searchParams: Promise<{ book?: string }>;
}) {
  const { book } = await searchParams;
  redirect(book ? `/admin/add?book=${encodeURIComponent(book)}` : "/admin/add");
}
