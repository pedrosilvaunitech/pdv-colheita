import { getBrowserDeviceBlockedMessage, isBrowserDevicePolicyError } from "./browser-device-permissions";

export function isPermissionPolicyError(error: unknown): boolean {
  return isBrowserDevicePolicyError(error) || (error instanceof Error && error.name === "SecurityError");
}

/**
 * Retorna uma mensagem amigável para o usuário quando ocorre erro de hardware.
 */
export function getHardwareErrorMessage(error: unknown, type: 'serial' | 'usb'): string {
  if (isPermissionPolicyError(error)) {
    return getBrowserDeviceBlockedMessage(type);
  }

  const msg = error instanceof Error ? error.message : String(error);
  
  if (msg.includes("User cancelled") || msg.includes("no device selected") || msg.includes("The device was disconnected")) {
    return "Seleção cancelada ou dispositivo desconectado.";
  }

  if (msg.includes("Access denied")) {
    return "Acesso negado. O dispositivo pode estar em uso por outro programa.";
  }

  if (msg.includes("NetworkError") || msg.includes("failed to open")) {
    return "Erro ao abrir a porta. Verifique se o cabo está conectado e se o driver está instalado.";
  }

  return msg;
}
