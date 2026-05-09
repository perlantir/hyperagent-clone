import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getThread } from "@/lib/db";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";
import { ChatView } from "@/components/ChatView";
import { LiveblocksRoom } from "@/components/LiveblocksRoom";
import { PresenceAvatars } from "@/components/PresenceAvatars";
import { PlanTasks } from "@/components/PlanTasks";
import { SaveAsAgentButton } from "@/components/SaveAsAgentButton";

export default async function ThreadPage({ params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const thread = await getThread(params.id, user.id);
  if (!thread) redirect("/");
  return (
    <AppShell>
      <LiveblocksRoom threadId={thread.id}>
        <Topbar
          breadcrumb={
            <div style={{ fontSize: 13, color: "var(--text-muted)", display: "flex", gap: 8 }}>
              <a href="/">Threads</a>
              <span style={{ opacity: 0.4 }}>/</span>
              <span style={{ color: "var(--text)", fontWeight: 500 }}>{thread.title}</span>
            </div>
          }
          actions={
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <SaveAsAgentButton threadId={thread.id} />
              <PresenceAvatars />
            </div>
          }
        />
        <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
          {/* P24 — live Plan Tasks panel; renders nothing until the agent populates the working doc */}
          <div style={{ padding: "0 16px", paddingTop: 12 }}>
            <PlanTasks threadId={thread.id} />
          </div>
          <ChatView threadId={thread.id} agentId={thread.agentId} />
        </div>
      </LiveblocksRoom>
    </AppShell>
  );
}
