"use client";
import { useState } from "react";

export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("demo@hyperagent.local");
  const [password, setPassword] = useState("demo");
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setErr(null);
    try {
      const url = mode === "login" ? "/api/auth/login" : "/api/auth/signup";
      const body = mode === "login" ? { email, password } : { email, password, name };
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "Login failed");
      }
      window.location.href = "/";
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <div className="card" style={{ width: 420, padding: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}>
          <div style={{ width: 28, height: 28, borderRadius: 7, background: "var(--text)", color: "var(--bg)", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 13 }}>H</div>
          <span style={{ fontWeight: 600, fontSize: 16 }}>Hyperagent</span>
        </div>
        <h1 className="h-display" style={{ fontSize: 36, marginBottom: 8 }}>{mode === "login" ? "Welcome back." : "Create your account."}</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 24 }}>
          {mode === "login" ? "Sign in to continue." : "Sign up to spin up your first agent."}
        </p>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {mode === "signup" && (
            <input className="input" placeholder="Your name" value={name} onChange={e => setName(e.target.value)} required />
          )}
          <input className="input" type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
          <input className="input" type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required />
          {err && <div style={{ color: "#dc2626", fontSize: 13 }}>{err}</div>}
          <button className="btn btn-primary" type="submit" disabled={loading} style={{ justifyContent: "center", padding: "10px 14px" }}>
            {loading ? "…" : (mode === "login" ? "Sign in" : "Create account")}
          </button>
        </form>
        <div style={{ marginTop: 16, fontSize: 13, color: "var(--text-muted)", textAlign: "center" }}>
          {mode === "login" ? (
            <>No account? <button onClick={() => setMode("signup")} style={{ background: "none", border: "none", color: "var(--accent)", padding: 0, font: "inherit", cursor: "pointer" }}>Sign up</button></>
          ) : (
            <>Have an account? <button onClick={() => setMode("login")} style={{ background: "none", border: "none", color: "var(--accent)", padding: 0, font: "inherit", cursor: "pointer" }}>Sign in</button></>
          )}
        </div>
        <div style={{ marginTop: 24, padding: "12px 14px", background: "var(--bg-subtle)", borderRadius: 8, fontSize: 12, color: "var(--text-muted)" }}>
          <strong>Demo:</strong> demo@hyperagent.local / demo
        </div>
      </div>
    </div>
  );
}
