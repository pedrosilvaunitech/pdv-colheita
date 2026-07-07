/**
 * Detecta se o erro foi causado por uma política de permissões (Permissions-Policy)
 * que bloqueia o acesso ao recurso (Serial ou USB).
 */
export function isPermissionPolicyError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.toLowerCase().includes("permissions policy") || 
    msg.toLowerCase().includes("disallowed by permissions policy") ||
    (error instanceof Error && error.name === "SecurityError")
  );
}

/**
 * Retorna uma mensagem amigável para o usuário quando ocorre erro de hardware.
 */
export function getHardwareErrorMessage(error: unknown, type: 'serial' | 'usb'): string {
  if (isPermissionPolicyError(error)) {
    return `O acesso ao recurso ${type.toUpperCase()} está bloqueado pela política de permissões do navegador. \n\nIsso pode ocorrer em iframes ou sites sem permissão explícita. Tente usar o Agente Local ou verifique as configurações de segurança do navegador.`;
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
