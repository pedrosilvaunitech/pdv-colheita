export type BrowserDeviceFeature = "serial" | "usb";

interface BrowserDevicePolicy {
  allowsFeature?: (feature: string, origin?: string) => boolean;
  allowedFeatures?: () => string[];
}

interface DocumentWithDevicePolicy extends Document {
  permissionsPolicy?: BrowserDevicePolicy;
  featurePolicy?: BrowserDevicePolicy;
}

const FEATURE_LABEL: Record<BrowserDeviceFeature, string> = {
  serial: "Web Serial",
  usb: "WebUSB",
};

function getPolicy(): BrowserDevicePolicy | null {
  if (typeof document === "undefined") return null;
  const doc = document as DocumentWithDevicePolicy;
  return doc.permissionsPolicy ?? doc.featurePolicy ?? null;
}

export function isBrowserDeviceFeatureAllowed(feature: BrowserDeviceFeature): boolean {
  const policy = getPolicy();
  if (!policy) return true;

  try {
    if (typeof policy.allowsFeature === "function") return policy.allowsFeature(feature);
  } catch {
    return true;
  }

  try {
    if (typeof policy.allowedFeatures === "function") return policy.allowedFeatures().includes(feature);
  } catch {
    return true;
  }

  return true;
}

export function getBrowserDeviceFeatureState(feature: BrowserDeviceFeature): {
  available: boolean;
  blockedByPolicy: boolean;
  message: string;
} {
  const nav = typeof navigator !== "undefined" ? navigator : null;
  const hasApi = !!nav && feature in nav;
  const allowed = isBrowserDeviceFeatureAllowed(feature);
  const label = FEATURE_LABEL[feature];

  if (!hasApi) {
    return { available: false, blockedByPolicy: false, message: `${label} não suportado neste navegador.` };
  }

  if (!allowed) {
    return {
      available: false,
      blockedByPolicy: true,
      message: `${label} bloqueado pela política de permissões deste ambiente. Use o app em janela própria/publicado ou utilize o Agente Local/fallback HTML.`,
    };
  }

  return { available: true, blockedByPolicy: false, message: `${label} disponível.` };
}

export function isBrowserDevicePolicyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const text = `${error.name} ${error.message}`.toLowerCase();
  return text.includes("permissions policy") || text.includes("disallowed by permissions policy");
}

export function describeBrowserDeviceError(error: unknown, feature: BrowserDeviceFeature): string {
  if (isBrowserDevicePolicyError(error)) return getBrowserDeviceFeatureState(feature).message;
  if (error instanceof Error) return error.message;
  return `Falha ao acessar ${FEATURE_LABEL[feature]}.`;
}