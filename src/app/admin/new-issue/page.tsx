import { redirect } from "next/navigation";

/** Pages from disk are a choice on the Add content flow's Pages step (#793). */
export default function NewIssuePage() {
  redirect("/admin/add");
}
