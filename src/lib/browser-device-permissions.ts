export type BrowserDeviceFeature = "serial" | "usb";

interface BrowserDevicePolicy {
  allowsFeature?: (feature: string, origin?: string) => boolean;
  allowedFeatures?: () => string[];
}

interface DocumentWithDevicePolicy extends Document {
  permissionsPolicy?: BrowserDevicePolicy;
  featurePolicy?: BrowserDevicePolicy;
}

interface BrowserDeviceFeatureState {
  available: boolean;
  blockedByPolicy: boolean;
  embeddedFrame: boolean;
  message: string;
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

function isEmbeddedFrame(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export function getBrowserDeviceBlockedMessage(feature: BrowserDeviceFeature): string {
  const label = FEATURE_LABEL[feature];
  return `${label} bloqueado pela política de permissões deste ambiente. No preview/editor o app roda em iframe e o navegador não permite abrir Serial/USB. Use o app em janela própria/publicado, Agente Local ou fallback HTML.`;
}

export function isBrowserDeviceFeatureAllowed(feature: BrowserDeviceFeature): boolean {
  if (isEmbeddedFrame()) return false;

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

export function getBrowserDeviceFeatureState(feature: BrowserDeviceFeature): BrowserDeviceFeatureState {
  const nav = typeof navigator !== "undefined" ? navigator : null;
  const hasApi = !!nav && feature in nav;
  const embeddedFrame = isEmbeddedFrame();
  const allowed = isBrowserDeviceFeatureAllowed(feature);
  const label = FEATURE_LABEL[feature];

  if (!hasApi) {
    return { available: false, blockedByPolicy: false, embeddedFrame, message: `${label} não suportado neste navegador.` };
  }

  if (!allowed) {
    return {
      available: false,
      blockedByPolicy: true,
      embeddedFrame,
      message: getBrowserDeviceBlockedMessage(feature),
    };
  }

  return { available: true, blockedByPolicy: false, embeddedFrame, message: `${label} disponível.` };
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