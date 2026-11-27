import { useEffect, useState } from "react";
import {
  ConfirmPanel,
  type ConfirmPanelProps,
} from "@/components/ui/swipe-to-confirm";

interface ConfirmDialogProps {
  open: boolean;
  onCancel: () => void;
  panel: ConfirmPanelProps;
}

export function ConfirmDialog({ open, onCancel, panel }: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setBusy(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const panelWithBusy: ConfirmPanelProps = panel.swipe
    ? {
        ...panel,
        swipe: {
          ...panel.swipe,
          onBusyChange: (nextBusy) => {
            setBusy(nextBusy);
            panel.swipe?.onBusyChange?.(nextBusy);
          },
        },
      }
    : panel;

  return (
    <div
      className="motion-backdrop fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="motion-modal flex w-full max-w-[380px] flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        <ConfirmPanel {...panelWithBusy} presentation="card" />
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (!busy) onCancel();
          }}
          className="motion-press mt-3 h-11 w-full rounded-[12px] bg-muted px-5 text-[15px] font-semibold text-foreground hover:bg-muted/85 disabled:cursor-not-allowed disabled:opacity-50"
        >
          取消
        </button>
      </div>
    </div>
  );
}
