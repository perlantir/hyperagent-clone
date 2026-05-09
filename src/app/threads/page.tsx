// P62 — Dedicated /threads "Show all" route. The home page (/) is now
// the Hyperagent-style composer landing; this page hosts the full
// threads dashboard with search, filters, and the Show archived toggle.

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import ThreadsListPage from "./list-page-client";

export default async function ThreadsRouteIndex() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <ThreadsListPage />;
}
