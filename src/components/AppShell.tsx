import { Sidebar } from "./Sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "256px 1fr", height: "100vh" }}>
      <Sidebar />
      <main style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}>{children}</main>
    </div>
  );
}
