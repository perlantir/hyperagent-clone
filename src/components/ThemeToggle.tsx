"use client";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    const t = (typeof window !== "undefined" && document.documentElement.getAttribute("data-theme")) || "light";
    setTheme(t === "dark" ? "dark" : "light");
  }, []);
  function toggle() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("hyperagent-theme", next); } catch {}
  }
  return (
    <button onClick={toggle}
      style={{ width: 26, height: 26, borderRadius: 6, background: "transparent", border: "none", color: "var(--text-muted)", fontSize: 14 }}
      title={theme === "light" ? "Dark mode" : "Light mode"}>
      {theme === "light" ? "☾" : "☀"}
    </button>
  );
}
