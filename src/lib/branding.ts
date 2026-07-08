import { useEffect, useState } from "react";

export interface Branding {
  appName: string;
  appTagline: string;
  primary: string;   // oklch/hex/hsl string
  accent: string;
  background: string;
}

export const DEFAULT_BRANDING: Branding = {
  appName: "BASTION POS",
  appTagline: "Operações fiscais",
  primary: "oklch(0.78 0.18 155)",
  accent: "oklch(0.72 0.16 220)",
  background: "oklch(0.16 0.015 250)",
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

export function applyBranding(b: Branding) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--primary", b.primary);
  root.style.setProperty("--ring", b.primary);
  root.style.setProperty("--sidebar-primary", b.primary);
  root.style.setProperty("--success", b.primary);
  root.style.setProperty("--accent", b.accent);
  root.style.setProperty("--info", b.accent);
  root.style.setProperty("--background", b.background);
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
    window.addEventListener("branding-changed", onChange);
    return () => window.removeEventListener("branding-changed", onChange);
  }, [b]);
  return b;
}
