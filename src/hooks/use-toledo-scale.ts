import { useEffect, useState, useCallback } from "react";
import {
  getToledoScale,
  isWebSerialSupported,
  loadToledoConfig,
  replaceToledoScale,
  saveToledoConfig,
  type ScaleReading,
  type ToledoConfig,
} from "@/lib/toledo-scale";

/**
 * Hook React para operar a balança Toledo.
 * - Mantém a última leitura recebida (`reading`)
 * - Reconecta automaticamente se o usuário já autorizou a porta
 * - Persiste configuração em localStorage
 */
export function useToledoScale() {
  const [supported] = useState<boolean>(() => isWebSerialSupported());
  const [connected, setConnected] = useState<boolean>(() => getToledoScale().isOpen());
  const [reading, setReading] = useState<ScaleReading | null>(() => getToledoScale().getLast());
  const [config, setConfig] = useState<ToledoConfig>(() => loadToledoConfig());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const scale = getToledoScale();
    const off = scale.onReading((r) => setReading(r));
    // tenta reconectar silenciosamente com a última porta autorizada
    if (!scale.isOpen()) {
      scale.tryReopenLast().then((ok) => { if (ok) setConnected(true); }).catch(() => { /* noop */ });
    }
    return () => { off(); };
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    try {
      const scale = getToledoScale();
      await scale.requestPort();
      setConnected(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    }
  }, []);

  const disconnect = useCallback(async () => {
    await getToledoScale().close();
    setConnected(false);
  }, []);

  const requestWeight = useCallback(async (): Promise<ScaleReading> => {
    return await getToledoScale().requestWeight();
  }, []);

  const updateConfig = useCallback(async (patch: Partial<ToledoConfig>) => {
    const next = { ...config, ...patch };
    saveToledoConfig(next);
    setConfig(next);
    // reinicia instância se estava conectada (nova baud/protocolo)
    const wasOpen = getToledoScale().isOpen();
    if (wasOpen) await getToledoScale().close();
    replaceToledoScale(next);
    setConnected(false);
    // tenta reabrir a porta previamente autorizada
    if (wasOpen) {
      const ok = await getToledoScale().tryReopenLast();
      setConnected(ok);
    }
  }, [config]);

  return { supported, connected, reading, config, error, connect, disconnect, requestWeight, updateConfig };
}
