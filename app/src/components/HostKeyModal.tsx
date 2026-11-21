import { ShieldAlert, X } from "lucide-react";

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4">
      <div className="popover w-full max-w-md p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-500" />
            <h2 className="text-sm font-semibold">确认服务器公钥指纹</h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md p-1 opacity-70 transition hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mb-2 text-xs leading-relaxed opacity-80">
          首次连接 <span className="font-mono font-medium">{info.hostPort}</span>
          ，请核对服务器公钥指纹是否可信：
        </p>

        <div
          className="card mb-4 p-3 font-mono text-xs break-all select-text"
        >
          {info.fingerprint}
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border px-3 py-1.5 text-xs font-medium opacity-80"
            style={{ borderColor: "var(--separator)" }}
          >
            拒绝
          </button>
          <button
            type="button"
            onClick={() => onConfirm(info.fingerprint)}
            className="rounded-lg bg-blue-500 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-600"
          >
            信任并连接
          </button>
        </div>
      </div>
    </div>
  );
}
