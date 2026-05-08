import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listThreads, createThread } from "@/lib/db";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const threads = listThreads(user.id);
  if (threads.length > 0) redirect(`/threads/${threads[0].id}`);
  const t = createThread(user.id, "New thread", null);
  redirect(`/threads/${t.id}`);
}
