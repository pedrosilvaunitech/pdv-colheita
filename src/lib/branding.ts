import { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";

export interface Branding {
  appName: string;
  appTagline: string;
  primary: string;
  accent: string;
  background: string;
  mode: ThemeMode;
}

export const DEFAULT_BRANDING: Branding = {
  appName: "BASTION POS",
  appTagline: "Operações fiscais",
  primary: "oklch(0.78 0.18 155)",
  accent: "oklch(0.72 0.16 220)",
  background: "oklch(0.16 0.015 250)",
  mode: "dark",
};

const STORAGE_KEY = "bastion-branding";

export function loadBranding(): Branding {
  if (typeof window === "undefined") return DEFAULT_BRANDING;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_BRANDING;
    return { ...DEFAULT_BRANDING, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_BRANDING;
  }
}

export function saveBranding(b: Branding) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(b));
  applyBranding(b);
  window.dispatchEvent(new CustomEvent("branding-changed", { detail: b }));
}

function resolveMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "system" && typeof window !== "undefined") {
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return mode === "light" ? "light" : "dark";
}

export function applyBranding(b: Branding) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const resolved = resolveMode(b.mode);
  root.classList.toggle("dark", resolved === "dark");
  root.classList.toggle("light", resolved === "light");
  root.style.colorScheme = resolved;

  root.style.setProperty("--primary", b.primary);
  root.style.setProperty("--ring", b.primary);
  root.style.setProperty("--sidebar-primary", b.primary);
  root.style.setProperty("--success", b.primary);
  root.style.setProperty("--accent", b.accent);
  root.style.setProperty("--info", b.accent);
  // Fundo customizado só faz sentido no modo escuro; no claro deixe o CSS decidir.
  if (resolved === "dark") {
    root.style.setProperty("--background", b.background);
  } else {
    root.style.removeProperty("--background");
  }
}

export function resetBranding() {
  localStorage.removeItem(STORAGE_KEY);
  applyBranding(DEFAULT_BRANDING);
  window.dispatchEvent(new CustomEvent("branding-changed", { detail: DEFAULT_BRANDING }));
}

export function useBranding(): Branding {
  const [b, setB] = useState<Branding>(() => loadBranding());
  useEffect(() => {
    applyBranding(b);
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<Branding>).detail;
      if (detail) setB(detail);
    };
    const mq = window.matchMedia?.("(prefers-color-scheme: light)");
    const onSystem = () => { if (b.mode === "system") applyBranding(b); };
    window.addEventListener("branding-changed", onChange);
    mq?.addEventListener?.("change", onSystem);
    return () => {
      window.removeEventListener("branding-changed", onChange);
      mq?.removeEventListener?.("change", onSystem);
    };
  }, [b]);
  return b;
}
