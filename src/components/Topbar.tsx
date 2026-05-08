export function Topbar({ title, breadcrumb, actions }: { title?: string; breadcrumb?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div style={{ height: 50, borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", padding: "0 24px", gap: 12, flexShrink: 0 }}>
      {breadcrumb || (title && <div style={{ fontSize: 13, fontWeight: 500 }}>{title}</div>)}
      {actions && <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>{actions}</div>}
    </div>
  );
}
