// P43 — Home page now lands on the threads dashboard, not into the most-
// recent thread. New users still get a thread created on signup-redirect
// (handled in /api/auth/signup → /), but we no longer auto-redirect into
// it from / — the dashboard is the right starting surface for returning
// users.
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listThreads, createThread } from "@/lib/db";
import ThreadsListPage from "./threads/list-page-client";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const threads = await listThreads(user.id);
  // Brand-new users with zero threads → seed an empty thread + jump in.
  // (Otherwise they'd land on the dashboard with nothing to do.)
  if (threads.length === 0) {
    const t = await createThread(user.id, "New thread", null);
    redirect(`/threads/${t.id}`);
  }
  return <ThreadsListPage />;
}
