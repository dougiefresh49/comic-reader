import { redirect } from "next/navigation";

/** Add Book is the first step of the Add content flow now (#793). */
export default function AddBookPage() {
  redirect("/admin/add");
}
