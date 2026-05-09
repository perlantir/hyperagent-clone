// P62 — Home redesigned to match Hyperagent's "Let's get to work" landing.
//
// Composer-first hero with quick chips and recent threads inline. Heavy
// landing surface: returning users see what's recent without clicking
// away. Brand-new users no longer get auto-routed into a fresh thread —
// they land here and can read the hero copy + start typing.

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";
import { HomeView } from "@/components/HomeView";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return (
    <AppShell>
      <Topbar title="" />
      <HomeView />
    </AppShell>
  );
}

// /threads stays the dedicated "Show all" view (ThreadsListPage there).
