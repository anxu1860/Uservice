import { ShieldCheck } from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog";

interface HostKeyModalProps {
  info: {
    hostPort: string;
    fingerprint: string;
  } | null;
  onCancel: () => void;
  onConfirm: (fingerprint: string) => void;
}

export function HostKeyModal({ info, onCancel, onConfirm }: HostKeyModalProps) {
  if (!info) return null;

  return (
    <ConfirmDialog
      open={true}
      onCancel={onCancel}
      panel={{
        title: "确认主机指纹",
        caption: "首次连接",
        party: {
          name: info.hostPort,
          detail: "请核对服务器公钥指纹是否可信",
        },
        hero: (
          <div className="select-text break-all rounded-[14px] bg-muted px-3.5 py-3 font-mono text-[13px] text-foreground">
            {info.fingerprint}
          </div>
        ),
        rows: [{ label: "算法", value: "SHA256" }],
        swipe: {
          label: "滑动以信任并连接",
          doneLabel: "已信任",
          icon: <ShieldCheck className="h-6 w-6" />,
          onConfirm: () => {},
          onDone: () => setTimeout(() => onConfirm(info.fingerprint), 500),
        },
      }}
    />
  );
}
