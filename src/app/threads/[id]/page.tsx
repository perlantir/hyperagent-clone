import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getThread } from "@/lib/db";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";
import { ChatView } from "@/components/ChatView";

export default async function ThreadPage({ params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const thread = await getThread(params.id, user.id);
  if (!thread) redirect("/");
  return (
    <AppShell>
      <Topbar
        breadcrumb={
          <div style={{ fontSize: 13, color: "var(--text-muted)", display: "flex", gap: 8 }}>
            <a href="/">Threads</a>
            <span style={{ opacity: 0.4 }}>/</span>
            <span style={{ color: "var(--text)", fontWeight: 500 }}>{thread.title}</span>
          </div>
        }
      />
      <ChatView threadId={thread.id} agentId={thread.agentId} />
    </AppShell>
  );
}
