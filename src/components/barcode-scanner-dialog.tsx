import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Camera, CameraOff, RotateCw } from "lucide-react";
import { toast } from "sonner";

/**
 * Scanner de código de barras via câmera do dispositivo.
 *
 * Usa a API nativa BarcodeDetector (Chrome/Edge/Android) — leitura instantânea
 * sem dependências externas. Em navegadores sem suporte (Safari iOS antigo),
 * mostra aviso e permite fechar; o operador digita manualmente.
 *
 * Formatos aceitos: EAN-13, EAN-8, UPC-A, UPC-E, Code128, Code39, ITF.
 */

type BarcodeFormat =
  | "aztec" | "code_128" | "code_39" | "code_93" | "codabar"
  | "data_matrix" | "ean_13" | "ean_8" | "itf" | "pdf417"
  | "qr_code" | "upc_a" | "upc_e";

interface DetectedBarcode {
  rawValue: string;
  format: string;
}

interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorCtor {
  new (opts?: { formats?: BarcodeFormat[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<BarcodeFormat[]>;
}

function getBarcodeDetector(): BarcodeDetectorCtor | null {
  const w = window as unknown as { BarcodeDetector?: BarcodeDetectorCtor };
  return w.BarcodeDetector ?? null;
}

export function isBarcodeScannerSupported(): boolean {
  return !!getBarcodeDetector() && !!navigator.mediaDevices?.getUserMedia;
}

export function BarcodeScannerDialog({
  open, onOpenChange, onDetected,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDetected: (code: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const [status, setStatus] = useState<"idle" | "starting" | "scanning" | "error" | "unsupported">("idle");
  const [error, setError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const start = async () => {
      const Ctor = getBarcodeDetector();
      if (!Ctor || !navigator.mediaDevices?.getUserMedia) {
        setStatus("unsupported");
        return;
      }
      setStatus("starting");
      setError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        await video.play();

        const detector = new Ctor({
          formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf"],
        });
        setStatus("scanning");

        const loop = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes.length > 0) {
              const value = codes[0].rawValue.replace(/\D/g, "");
              if (value) {
                if (navigator.vibrate) navigator.vibrate(80);
                onDetected(value);
                onOpenChange(false);
                return;
              }
            }
          } catch { /* ignora quadro sem código */ }
          rafRef.current = requestAnimationFrame(loop);
        };
        loop();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[scanner] falhou:", e);
        setError(msg);
        setStatus("error");
        toast.error(`Câmera: ${msg}`);
      }
    };
    start();
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [open, facingMode, onDetected, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="size-4" /> Escanear código de barras
          </DialogTitle>
          <DialogDescription>
            Aponte a câmera para o código. A leitura é automática.
          </DialogDescription>
        </DialogHeader>

        {status === "unsupported" ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <CameraOff className="size-10 text-muted-foreground" />
            <div className="text-sm">Este navegador não suporta leitura por câmera.</div>
            <div className="text-xs text-muted-foreground">
              Use Chrome/Edge no Android ou desktop. Em iPhone, digite o código manualmente.
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="relative aspect-[4/3] bg-black rounded-md overflow-hidden">
              <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
              {/* Guia visual */}
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div className="w-4/5 h-1/3 border-2 border-primary/80 rounded-md shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
              </div>
              {status === "starting" && (
                <div className="absolute inset-0 flex items-center justify-center text-white text-xs">
                  Abrindo câmera…
                </div>
              )}
              {status === "error" && error && (
                <div className="absolute inset-0 flex items-center justify-center text-destructive text-xs p-4 text-center">
                  {error}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setFacingMode((m) => (m === "environment" ? "user" : "environment"))}
                className="gap-1"
              >
                <RotateCw className="size-3" /> Trocar câmera
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
