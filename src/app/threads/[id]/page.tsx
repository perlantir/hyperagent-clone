import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getThread } from "@/lib/db";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";
import { LiveblocksRoom } from "@/components/LiveblocksRoom";
import { PresenceAvatars } from "@/components/PresenceAvatars";
import { SaveAsAgentButton } from "@/components/SaveAsAgentButton";
import { ThreadWorkspace } from "@/components/ThreadWorkspace";
import { ThreadHeader } from "@/components/ThreadHeader";

// P37 — Two-column workspace: ChatView on the left, Canvas on the right.
// Canvas auto-opens on first artifact emit; user can toggle + resize.
// P50 — header has inline title editing + 3-dot actions menu.

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
            <ThreadHeader
              threadId={thread.id}
              initialTitle={thread.title}
              projectId={thread.projectId}
            />
          }
          actions={
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <SaveAsAgentButton threadId={thread.id} />
              <PresenceAvatars />
            </div>
          }
        />
        <ThreadWorkspace threadId={thread.id} agentId={thread.agentId} />
      </LiveblocksRoom>
    </AppShell>
  );
}
