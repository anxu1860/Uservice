import { useEffect, useRef } from "react";
import { ShieldCheck } from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog";

interface HostKeyModalProps {
  info: {
    hostPort: string;
    fingerprint: string;
  } | null;
  pendingQueue?: Array<{
    hostPort: string;
    fingerprint: string;
  }>;
  remainingCount?: number;
  onCancel: () => void;
  onConfirm: (fingerprint: string) => void;
  onConfirmAll?: () => void;
}

export function HostKeyModal({
  info,
  pendingQueue,
  remainingCount = 0,
  onCancel,
  onConfirm,
  onConfirmAll,
}: HostKeyModalProps) {
  const timerRef = useRef<number | null>(null);

  const clearPendingTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    clearPendingTimer();
    return () => {
      clearPendingTimer();
    };
  }, [info?.hostPort]);

  if (!info) return null;

  const extraItems = (pendingQueue ?? []).slice(1);
  const effectiveRemaining =
    pendingQueue && pendingQueue.length > 1
      ? pendingQueue.length - 1
      : remainingCount;

  const handleCancel = () => {
    clearPendingTimer();
    onCancel();
  };

  const handleConfirmAll = () => {
    clearPendingTimer();
    onConfirmAll?.();
  };

  return (
    <ConfirmDialog
      key={info.hostPort}
      open={true}
      onCancel={handleCancel}
      panel={{
        title: "确认主机指纹",
        caption:
          effectiveRemaining > 0
            ? `首次连接 · 还有 ${effectiveRemaining} 台待确认`
            : "首次连接",
        party: {
          name: info.hostPort,
          detail: "请核对服务器公钥指纹是否可信",
        },
        hero: (
          <div className="space-y-2">
            <div className="select-text break-all rounded-[14px] bg-muted px-3.5 py-3 text-[13px] text-foreground">
              {info.fingerprint}
            </div>
            {extraItems.length > 0 && (
              <div className="max-h-32 space-y-1.5 overflow-y-auto rounded-[12px] border border-border/70 bg-muted/40 p-2 text-left text-[11px]">
                <div className="font-medium text-muted-foreground">
                  队列中其余 {extraItems.length} 台待信任主机（请逐一核对）：
                </div>
                {extraItems.map((item) => (
                  <div
                    key={`${item.hostPort}-${item.fingerprint}`}
                    className="rounded-lg bg-background/70 px-2 py-1"
                  >
                    <div className="font-mono font-medium text-foreground">
                      {item.hostPort}
                    </div>
                    <div className="select-text break-all font-mono text-[10px] text-muted-foreground">
                      {item.fingerprint}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {effectiveRemaining > 0 && onConfirmAll && (
              <button
                type="button"
                onClick={handleConfirmAll}
                className="motion-press flex h-9 w-full items-center justify-center rounded-[12px] bg-primary/12 text-[12.5px] font-semibold text-primary hover:bg-primary/20"
              >
                确认以上全部指纹并信任（共 {effectiveRemaining + 1} 台）
              </button>
            )}
          </div>
        ),
        rows: [{ label: "算法", value: "SHA256" }],
        swipe: {
          label: "滑动以信任并连接",
          doneLabel: "已信任",
          icon: <ShieldCheck className="h-6 w-6" />,
          onConfirm: () => {},
          onDone: () => {
            clearPendingTimer();
            const fp = info.fingerprint;
            timerRef.current = window.setTimeout(() => {
              timerRef.current = null;
              onConfirm(fp);
            }, 350);
          },
        },
      }}
    />
  );
}
