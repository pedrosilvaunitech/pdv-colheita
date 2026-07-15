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
  
  if (/device was disconnected|disconnected|desconectado/i.test(msg)) {
    return "A conexão WebUSB foi perdida. Desconecte e reconecte o cabo USB, clique em Reautorizar USB e tente imprimir novamente.";
  }

  if (msg.includes("User cancelled") || msg.includes("no device selected")) {
    return "Seleção cancelada ou dispositivo desconectado.";
  }

  if (/access denied|acesso negado|permission denied|libusb_error_access|libusb_error_not_supported|not_supported/i.test(msg)) {
    return "Acesso USB negado. A impressora está presa pelo driver/spooler do sistema ou por outra sessão. Use o Agente Local/Windows ou resete a conexão WebUSB.";
  }

  if (msg.includes("NetworkError") || msg.includes("failed to open")) {
    return "Erro ao abrir a porta. Verifique se o cabo está conectado e se o driver está instalado.";
  }

  return msg;
}
