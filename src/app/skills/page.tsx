"use client";
// P63 — Skills page with full CRUD.
//
// Two stacked sections:
//   1. Installed skills — each row has Edit / Uninstall buttons.
//      Custom skills (no installedFromTemplate) say "Custom".
//   2. Templates — Install button. Already-installed templates show a
//      muted "Installed" badge and a disabled button.
//
// + New custom skill opens an inline modal with Name / Category /
// Description / Prompt / Tool hints. Same modal handles Edit by being
// pre-populated with the existing row.

import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";

interface SkillRow {
  id: string;
  userId: string | null;
  name: string;
  description: string;
  category: string;
  systemPromptAddition: string;
  toolHints: string[];
  isTemplate: number;
  installedFromTemplate: string | null;
  createdAt: number;
}

export default function SkillsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [templates, setTemplates] = useState<SkillRow[]>([]);
  const [installed, setInstalled] = useState<SkillRow[]>([]);
  const [filter, setFilter] = useState("all");
  const [installing, setInstalling] = useState<string | null>(null);
  const [editing, setEditing] = useState<SkillRow | null>(null);
  const [creating, setCreating] = useState(false);

  async function reload() {
    const r = await (await fetch("/api/skills")).json();
    setTemplates(r.templates || []);
    setInstalled(r.skills || []);
  }
  useEffect(() => { reload(); }, []);

  async function install(id: string) {
    setInstalling(id);
    const r = await fetch("/api/skills", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installFromTemplate: id }),
    });
    setInstalling(null);
    if (r.ok) { toast.success("Installed"); reload(); }
    else toast.error("Install failed");
  }

  async function uninstall(s: SkillRow) {
    const ok = await confirm({
      title: `Uninstall "${s.name}"?`,
      body: s.installedFromTemplate
        ? "Removes your copy of this skill. You can re-install the template anytime."
        : "Permanently deletes this custom skill.",
      confirmLabel: s.installedFromTemplate ? "Uninstall" : "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    const r = await fetch(`/api/skills/${s.id}`, { method: "DELETE" });
    if (r.ok) { toast.success("Removed"); reload(); }
    else toast.error("Could not remove");
  }

  const categories = Array.from(new Set([
    ...templates.map(t => t.category),
    ...installed.map(s => s.category),
  ].filter(Boolean))).sort();
  const installedTemplateIds = new Set(installed.map(s => s.installedFromTemplate).filter(Boolean));
  const filteredTemplates = filter === "all" ? templates : templates.filter(t => t.category === filter);
  const filteredInstalled = filter === "all" ? installed : installed.filter(s => s.category === filter);

  return (
    <AppShell>
      <Topbar title="Skills" />
      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 1000, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8, gap: 16 }}>
            <div>
              <h1 className="h-display" style={{ fontSize: 44, marginBottom: 8 }}>Skills</h1>
              <div style={{ color: "var(--text-muted)", fontSize: 15, maxWidth: 580 }}>
                Templated capabilities you can install onto your agents. Each adds a system-prompt fragment and recommends tools.
              </div>
            </div>
            <button onClick={() => setCreating(true)} className="btn btn-primary"
              style={{ fontSize: 13, padding: "8px 14px", whiteSpace: "nowrap" }}>
              + New custom skill
            </button>
          </div>

          {/* Category chips */}
          <div style={{ display: "flex", gap: 8, marginTop: 16, marginBottom: 28, flexWrap: "wrap" }}>
            <button className={`chip ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>
              All ({templates.length + installed.length})
            </button>
            {categories.map(c => (
              <button key={c} className={`chip ${filter === c ? "active" : ""}`} onClick={() => setFilter(c)}>{c}</button>
            ))}
          </div>

          {/* INSTALLED section */}
          <h2 style={{ fontSize: 13, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 12 }}>
            Installed · {installed.length}
          </h2>
          {filteredInstalled.length === 0 ? (
            <div className="card" style={{ padding: 20, color: "var(--text-faint)", fontSize: 13, marginBottom: 32 }}>
              {installed.length === 0
                ? "No skills installed yet. Pick a template below or create a custom skill."
                : "No installed skills in this category."}
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px,1fr))", gap: 12, marginBottom: 36 }}>
              {filteredInstalled.map(s => (
                <div key={s.id} className="card" style={{ padding: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                    <span style={CATEGORY_PILL}>{s.category}</span>
                    <span className="badge badge-green" style={{ fontSize: 10 }}>
                      {s.installedFromTemplate ? "Installed" : "Custom"}
                    </span>
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>{s.name}</div>
                  <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5, marginBottom: 12, minHeight: 56 }}>
                    {s.description || <em>(no description)</em>}
                  </div>
                  {s.toolHints?.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      {s.toolHints.map(h => <span key={h} className="badge badge-gray" style={{ marginRight: 4 }}>{h}</span>)}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn" style={{ flex: 1, fontSize: 12 }}
                      onClick={() => setEditing(s)}>Edit</button>
                    <button className="btn" style={{ flex: 1, fontSize: 12, color: "#dc2626", borderColor: "rgba(220,38,38,0.3)" }}
                      onClick={() => uninstall(s)}>
                      {s.installedFromTemplate ? "Uninstall" : "Delete"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* TEMPLATES section */}
          <h2 style={{ fontSize: 13, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 12 }}>
            Templates · {templates.length}
          </h2>
          {filteredTemplates.length === 0 ? (
            <div className="card" style={{ padding: 20, color: "var(--text-faint)", fontSize: 13 }}>
              No templates match this filter.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px,1fr))", gap: 12 }}>
              {filteredTemplates.map(t => {
                const isInstalled = installedTemplateIds.has(t.id);
                return (
                  <div key={t.id} className="card" style={{ padding: 16 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                      <span style={CATEGORY_PILL}>{t.category}</span>
                      {isInstalled && <span className="badge badge-green" style={{ fontSize: 10 }}>Installed</span>}
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>{t.name}</div>
                    <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5, marginBottom: 12, minHeight: 56 }}>
                      {t.description}
                    </div>
                    {t.toolHints?.length > 0 && (
                      <div style={{ marginBottom: 12 }}>
                        {t.toolHints.map(h => <span key={h} className="badge badge-gray" style={{ marginRight: 4 }}>{h}</span>)}
                      </div>
                    )}
                    <button className="btn btn-primary"
                      disabled={isInstalled || installing === t.id}
                      onClick={() => install(t.id)}
                      style={{ width: "100%", justifyContent: "center", fontSize: 12 }}>
                      {installing === t.id ? "Installing…" : isInstalled ? "Installed" : "Install"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {(editing || creating) && (
        <SkillEditor
          skill={editing}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSaved={() => { setEditing(null); setCreating(false); reload(); }}
        />
      )}
    </AppShell>
  );
}

const CATEGORY_PILL: React.CSSProperties = {
  fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase",
  letterSpacing: 0.08 * 16, fontWeight: 600,
};

// ─── Editor modal ────────────────────────────────────────────────────

function SkillEditor({ skill, onClose, onSaved }: {
  skill: any | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const isEdit = !!skill;
  const [name, setName] = useState(skill?.name || "");
  const [description, setDescription] = useState(skill?.description || "");
  const [category, setCategory] = useState(skill?.category || "Custom");
  const [systemPromptAddition, setSystemPromptAddition] = useState(skill?.systemPromptAddition || "");
  const [toolHintsRaw, setToolHintsRaw] = useState((skill?.toolHints || []).join(", "));
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim() || !systemPromptAddition.trim()) {
      toast.error("Name and prompt are required");
      return;
    }
    setSaving(true);
    const toolHints = toolHintsRaw.split(",").map(s => s.trim()).filter(Boolean);
    const body = {
      name: name.trim(),
      description: description.trim(),
      category: category.trim() || "Custom",
      systemPromptAddition,
      toolHints,
    };
    let r: Response;
    if (isEdit) {
      r = await fetch(`/api/skills/${skill.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } else {
      r = await fetch("/api/skills", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    setSaving(false);
    const j = await r.json().catch(() => ({}));
    if (r.ok) { toast.success(isEdit ? "Saved" : "Created"); onSaved(); }
    else toast.error("Save failed", j.error || "");
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
      display: "grid", placeItems: "center", zIndex: 100, backdropFilter: "blur(4px)",
    }}>
      <div onClick={e => e.stopPropagation()} className="card"
        style={{ width: "min(620px, 95vw)", padding: 24, maxHeight: "90vh", overflowY: "auto" }}>
        <h2 className="h-display" style={{ fontSize: 26, marginBottom: 4 }}>
          {isEdit ? "Edit skill" : "New custom skill"}
        </h2>
        <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 18 }}>
          A skill is a named system-prompt fragment that gets composed into the agent&apos;s prompt when bound.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Name">
            <input className="input" value={name} onChange={e => setName(e.target.value)}
              placeholder="Stripe operator" />
          </Field>
          <Field label="Category">
            <input className="input" value={category} onChange={e => setCategory(e.target.value)}
              placeholder="Operations" />
          </Field>
          <Field label="Description">
            <textarea className="input" rows={2} value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What this skill does. Surfaces in the catalog + Skills tab."
              style={{ resize: "vertical" }} />
          </Field>
          <Field label="System-prompt addition">
            <textarea className="input" rows={6} value={systemPromptAddition}
              onChange={e => setSystemPromptAddition(e.target.value)}
              placeholder="Concrete instructions appended to the agent's system prompt when this skill is bound."
              style={{ resize: "vertical", fontFamily: "JetBrains Mono, monospace", fontSize: 13 }} />
          </Field>
          <Field label="Tool hints (comma-separated)">
            <input className="input" value={toolHintsRaw}
              onChange={e => setToolHintsRaw(e.target.value)}
              placeholder="web_search, run_shell, generate_artifact" />
          </Field>
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 22 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : (isEdit ? "Save changes" : "Create skill")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)",
        textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>{label}</div>
      {children}
    </label>
  );
}
