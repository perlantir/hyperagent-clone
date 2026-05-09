"use client";
import { useEffect, useState } from "react";
import { Sidebar } from "./Sidebar";
import { CommandK } from "./CommandK";
import { MobileNav } from "./MobileNav";
import { ToastProvider } from "./Toast";
import { ConfirmProvider } from "./ConfirmDialog";
import { OnboardingModal } from "./OnboardingModal";
import { SkeletonStyles } from "./Skeleton";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [isMobile, setIsMobile] = useState(false);
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
            <main style={{ height: "100vh", overflow: "hidden", display: "flex", flexDirection: "column", paddingTop: 56 }}>{children}</main>
          </>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "256px 1fr", height: "100vh" }}>
            <Sidebar />
            <main style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}>{children}</main>
          </div>
        )}
      </ConfirmProvider>
    </ToastProvider>
  );
}
