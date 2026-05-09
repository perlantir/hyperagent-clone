"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { CommandK } from "./CommandK";
import { MobileNav } from "./MobileNav";
import { ToastProvider } from "./Toast";
import { ConfirmProvider } from "./ConfirmDialog";
import { OnboardingModal } from "./OnboardingModal";
import { SkeletonStyles } from "./Skeleton";
import { ErrorBoundary } from "./ErrorBoundary";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [isMobile, setIsMobile] = useState(false);
  // P60 — pathname is the resetKey for the per-page ErrorBoundary so
  // navigating elsewhere automatically clears a stale error state.
  const pathname = usePathname();
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 900);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  return (
    <ToastProvider>
      <ConfirmProvider>
        <SkeletonStyles />
        <CommandK />
        <OnboardingModal />
        {isMobile ? (
          <>
            <MobileNav><Sidebar /></MobileNav>
            <main style={{ height: "100vh", overflow: "hidden", display: "flex", flexDirection: "column", paddingTop: 56 }}>
              {/* P60 — ErrorBoundary scoped to the page content. Sidebar +
                  toasts stay alive even when the page render throws. */}
              <ErrorBoundary resetKey={pathname || ""}>{children}</ErrorBoundary>
            </main>
          </>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "256px 1fr", height: "100vh" }}>
            <Sidebar />
            <main style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <ErrorBoundary resetKey={pathname || ""}>{children}</ErrorBoundary>
            </main>
          </div>
        )}
      </ConfirmProvider>
    </ToastProvider>
  );
}
