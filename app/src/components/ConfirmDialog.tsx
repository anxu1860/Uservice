import { useEffect } from "react";
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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        className="flex w-full max-w-[380px] flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        <ConfirmPanel {...panel} presentation="card" />
        <button
          type="button"
          onClick={onCancel}
          className="mt-3 h-11 w-full rounded-[12px] bg-muted px-5 text-[15px] font-semibold text-foreground transition active:scale-[.97]"
        >
          取消
        </button>
      </div>
    </div>
  );
}
