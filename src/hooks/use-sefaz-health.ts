/**
 * Monitoramento automático do motor fiscal (Direto SEFAZ via Agente Local).
 *
 * Estratégia de polling em dois níveis, para não martelar a SEFAZ:
 *   - Motor local (`/nfce/config`): barato, roda a cada 60s.
 *   - Status SEFAZ (`/nfce/status`): consulta real, roda a cada 5 min.
 *
 * Dispara alerta (toast) apenas na TRANSIÇÃO saudável → falho e na volta,
 * evitando spam a cada ciclo.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getNfceEngineStatus, testSefazViaAgent } from "@/lib/nfce-agent";
import { diagnoseSefazFailure, type SefazDiagnosis } from "@/lib/sefaz-diagnostics";

const ENGINE_INTERVAL_MS = 60_000;
const SEFAZ_INTERVAL_MS = 5 * 60_000;

export type SefazHealthState = "checking" | "ok" | "degraded" | "down";

export interface SefazHealth {
  state: SefazHealthState;
  /** Agente respondeu em 127.0.0.1:9100. */
  agentOnline: boolean;
  /** node-dfe carregado no agente. */
  engineReady: boolean;
  /** Última mensagem de sucesso da SEFAZ (cStat/xMotivo). */
  sefazMessage: string | null;
  /** Diagnóstico acionável quando algo falha. */
  diagnosis: SefazDiagnosis | null;
  /** Momento da última verificação completa. */
  lastCheckedAt: Date | null;
  /** Verificação em andamento. */
  checking: boolean;
  /** Força uma verificação completa agora. */
  refresh: () => Promise<void>;
}

export function useSefazHealth(enabled: boolean): SefazHealth {
  const [state, setState] = useState<SefazHealthState>("checking");
  const [agentOnline, setAgentOnline] = useState(false);
  const [engineReady, setEngineReady] = useState(false);
  const [sefazMessage, setSefazMessage] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<SefazDiagnosis | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const [checking, setChecking] = useState(false);

  // Guarda o último estado notificado para alertar só nas transições.
  const notifiedState = useRef<SefazHealthState | null>(null);
  const alive = useRef(true);

  const announce = useCallback((next: SefazHealthState, diag: SefazDiagnosis | null) => {
    if (notifiedState.current === next) return;
    const previous = notifiedState.current;
    notifiedState.current = next;
    if (previous === null) return; // primeira leitura não alerta
    if (next === "ok") {
      toast.success("Emissão fiscal restabelecida — SEFAZ respondendo.");
      return;
    }
    const title = diag?.title ?? "Falha na emissão fiscal";
    if (next === "down") toast.error(`${title}. Vendas seguem gravando como pendentes.`, { duration: 10000 });
    else toast.warning(`${title}. Verifique o diagnóstico fiscal.`, { duration: 8000 });
  }, []);

  /** Checagem barata: só o motor local. */
  const checkEngine = useCallback(async () => {
    const st = await getNfceEngineStatus();
    if (!alive.current) return false;
    setAgentOnline(st.agentOnline);
    setEngineReady(st.engineReady);
    if (!st.agentOnline || !st.engineReady) {
      const diag = diagnoseSefazFailure(st.error ?? "Agente Local offline");
      setDiagnosis(diag);
      setState("down");
      setLastCheckedAt(new Date());
      announce("down", diag);
      return false;
    }
    return true;
  }, [announce]);

  /** Checagem completa: motor local + status do serviço na SEFAZ. */
  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const engineOk = await checkEngine();
      if (!engineOk || !alive.current) return;
      const r = await testSefazViaAgent();
      if (!alive.current) return;
      setLastCheckedAt(new Date());
      if (r.ok) {
        setSefazMessage(r.message);
        setDiagnosis(null);
        setState("ok");
        announce("ok", null);
      } else {
        const diag = diagnoseSefazFailure(r.message);
        setDiagnosis(diag);
        // Rejeição/manutenção da SEFAZ é degradado; resto é queda.
        const next: SefazHealthState = diag.severity === "warning" ? "degraded" : "down";
        setState(next);
        announce(next, diag);
      }
    } finally {
      if (alive.current) setChecking(false);
    }
  }, [announce, checkEngine]);

  useEffect(() => {
    alive.current = true;
    if (!enabled) {
      setState("checking");
      notifiedState.current = null;
      return () => {
        alive.current = false;
      };
    }

    void refresh();
    const engineTimer = setInterval(() => void checkEngine(), ENGINE_INTERVAL_MS);
    const sefazTimer = setInterval(() => void refresh(), SEFAZ_INTERVAL_MS);

    // Revalida ao voltar para a aba — o caixa costuma alternar entre janelas.
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkEngine();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      alive.current = false;
      clearInterval(engineTimer);
      clearInterval(sefazTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, refresh, checkEngine]);

  return { state, agentOnline, engineReady, sefazMessage, diagnosis, lastCheckedAt, checking, refresh };
}
