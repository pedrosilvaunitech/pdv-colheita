import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export type ReceiptPreviewZoom = "100" | "125" | "150" | "175";

interface ReceiptPaperPreviewProps {
  html: string;
  paperWidth: 58 | 80;
  zoom?: ReceiptPreviewZoom;
  title?: string;
  className?: string;
}

const PAPER_WIDTH_PX: Record<58 | 80, number> = {
  58: 219,
  80: 302,
};

const ZOOM_SCALE: Record<ReceiptPreviewZoom, number> = {
  "100": 1,
  "125": 1.25,
  "150": 1.5,
  "175": 1.75,
};

export function ReceiptPaperPreview({
  html,
  paperWidth,
  zoom = "150",
  title = "Prévia do cupom",
  className,
}: ReceiptPaperPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [contentHeight, setContentHeight] = useState(640);
  const paperPx = PAPER_WIDTH_PX[paperWidth];
  const scale = ZOOM_SCALE[zoom];

  useEffect(() => {
    setContentHeight(640);
  }, [html, paperWidth]);

  const resizeToContent = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const body = doc.body;
    const root = doc.documentElement;
    const nextHeight = Math.max(
      body?.scrollHeight ?? 0,
      root?.scrollHeight ?? 0,
      420,
    );
    setContentHeight(nextHeight + 8);
  };

  return (
    <div className={cn("mx-auto", className)} style={{ width: paperPx * scale, minHeight: contentHeight * scale }}>
      <iframe
        ref={iframeRef}
        title={title}
        srcDoc={html}
        onLoad={resizeToContent}
        className="block rounded-sm border border-border shadow-sm"
        style={{
          width: paperPx,
          height: contentHeight,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      />
    </div>
  );
}