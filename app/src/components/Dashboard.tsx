import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  KeyRound,
  Plus,
  Terminal as TerminalIcon,
} from "lucide-react";
import {
  parseCmdError,
  type Server,
  type ServerStats,
} from "../types";

interface DashboardProps {
  servers: Server[];
  visible: boolean;
  acceptedHostKeys: Record<string, string>;
  pollTrigger: number;
  onOpenTerminal: (server: Server) => void;
  onAddServer: () => void;
  onNeedPassword: (server: Server) => void;
  onHostKeyUnknown: (hostPort: string, fingerprint: string) => void;
}

type CardState =
  | { kind: "connecting"; stats?: ServerStats; cpuHistory: number[] }
  | { kind: "online"; stats: ServerStats; cpuHistory: number[] }
  | { kind: "need_password"; cpuHistory: number[] }
  | { kind: "error"; message: string; cpuHistory: number[] };

export function Dashboard({
  servers,
  visible,
  acceptedHostKeys,
  pollTrigger,
  onOpenTerminal,
  onAddServer,
  onNeedPassword,
  onHostKeyUnknown,
}: DashboardProps) {
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [docVisible, setDocVisible] = useState(
    () => document.visibilityState === "visible"
  );

  useEffect(() => {
    const onVis = () => setDocVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    if (!visible || !docVisible || servers.length === 0) return;

    let cancelled = false;
    const timers = new Map<string, number>();

    const pollOne = async (srv: Server) => {
      if (cancelled) return;

      setCards((prev) => {
        const cur = prev[srv.id];
        if (cur?.kind === "online") return prev;
        return {
          ...prev,
          [srv.id]: {
            kind: "connecting",
            stats: cur && "stats" in cur ? cur.stats : undefined,
            cpuHistory: cur?.cpuHistory ?? [],
          },
        };
      });

      const hostPort = `${srv.host}:${srv.port}`;
      const auth =
        srv.auth.type === "password"
          ? { type: "password", password: null }
          : { type: "key", path: srv.auth.path, passphrase: null };

      try {
        const stats = await invoke<ServerStats>("monitor_poll", {
          cfg: {
            server_id: srv.id,
            host: srv.host,
            port: srv.port,
            username: srv.username,
            auth,
            accept_host_key: acceptedHostKeys[hostPort] ?? null,
          },
        });
        if (cancelled) return;
        setCards((prev) => {
          const hist = prev[srv.id]?.cpuHistory ?? [];
          const nextHist =
            stats.cpuPercent !== null
              ? [...hist.slice(-29), stats.cpuPercent]
              : hist;
          return {
            ...prev,
            [srv.id]: {
              kind: "online",
              stats,
              cpuHistory: nextHist,
            },
          };
        });
        timers.set(
          srv.id,
          window.setTimeout(() => void pollOne(srv), 3000)
        );
      } catch (rawErr) {
        if (cancelled) return;
        const err = parseCmdError(rawErr);
        if (err.kind === "auth" && srv.auth.type === "password") {
          setCards((prev) => ({
            ...prev,
            [srv.id]: {
              kind: "need_password",
              cpuHistory: prev[srv.id]?.cpuHistory ?? [],
            },
          }));
          return;
        }
        if (err.kind === "host_key_unknown" && err.fingerprint) {
          setCards((prev) => ({
            ...prev,
            [srv.id]: {
              kind: "error",
              message: "等待确认主机公钥指纹",
              cpuHistory: prev[srv.id]?.cpuHistory ?? [],
            },
          }));
          onHostKeyUnknown(hostPort, err.fingerprint);
          return;
        }
        setCards((prev) => ({
          ...prev,
          [srv.id]: {
            kind: "error",
            message: err.message,
            cpuHistory: prev[srv.id]?.cpuHistory ?? [],
          },
        }));
        timers.set(
          srv.id,
          window.setTimeout(() => void pollOne(srv), 6000)
        );
      }
    };

    for (const srv of servers) {
      void pollOne(srv);
    }

    return () => {
      cancelled = true;
      for (const tid of timers.values()) {
        window.clearTimeout(tid);
      }
    };
  }, [servers, visible, docVisible, acceptedHostKeys, pollTrigger, onHostKeyUnknown]);

  if (servers.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="card max-w-md p-7 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-500/15 text-blue-500">
            <Activity className="h-6 w-6" />
          </div>
          <h1 className="mb-2 text-lg font-semibold">欢迎使用 ServerHub</h1>
          <p className="mb-5 text-xs leading-relaxed opacity-70">
            添加你的第一台 Linux 服务器或导入 ~/.ssh/config，即可在此查看实时资源占用、延迟与开启交互终端。
          </p>
          <button
            type="button"
            onClick={onAddServer}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500 px-4 py-2 text-xs font-medium text-white shadow-sm transition hover:bg-blue-600"
          >
            <Plus className="h-4 w-4" />
            <span>添加服务器</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold">服务器概览</h1>
          <p className="text-xs opacity-60">
            无 Agent SSH 实时监控 · 共 {servers.length} 台
          </p>
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3.5">
        {servers.map((srv) => {
          const state = cards[srv.id] ?? {
            kind: "connecting" as const,
            cpuHistory: [],
          };
          const stats =
            state.kind === "online" || state.kind === "connecting"
              ? state.stats
              : undefined;

          const statusDot =
            state.kind === "online"
              ? "bg-emerald-500"
              : state.kind === "connecting"
                ? "bg-amber-400 animate-pulse"
                : state.kind === "need_password"
                  ? "bg-zinc-400"
                  : "bg-red-500";

          const latency = stats?.latencyMs;
          const latencyClass =
            latency == null
              ? "opacity-50"
              : latency < 80
                ? "bg-emerald-500/15 text-emerald-500"
                : latency < 200
                  ? "bg-amber-500/15 text-amber-500"
                  : "bg-red-500/15 text-red-500";

          const memPct =
            stats && stats.memTotal > 0
              ? (stats.memUsed / stats.memTotal) * 100
              : 0;
          const diskPct =
            stats && stats.diskTotal > 0
              ? (stats.diskUsed / stats.diskTotal) * 100
              : 0;

          return (
            <div key={srv.id} className="card flex flex-col justify-between p-4">
              <div>
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${statusDot}`}
                      />
                      <span className="truncate text-sm font-semibold">
                        {srv.name}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] opacity-60">
                      {srv.username}@{srv.host}:{srv.port}
                    </div>
                  </div>
                  {latency != null && (
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-medium ${latencyClass}`}
                    >
                      {Math.round(latency)} ms
                    </span>
                  )}
                </div>

                {state.kind === "need_password" ? (
                  <div className="my-5 flex flex-col items-center gap-2 text-center">
                    <p className="text-xs opacity-65">需要登录密码以采集状态</p>
                    <button
                      type="button"
                      onClick={() => onNeedPassword(srv)}
                      className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition hover:bg-black/5 dark:hover:bg-white/10"
                      style={{ borderColor: "var(--separator)" }}
                    >
                      <KeyRound className="h-3.5 w-3.5 text-blue-500" />
                      <span>输入密码开始监控</span>
                    </button>
                  </div>
                ) : state.kind === "error" && !stats ? (
                  <div className="my-4 rounded-lg bg-red-500/10 p-2.5 text-xs text-red-500">
                    {state.message}
                  </div>
                ) : stats ? (
                  <div className="space-y-2.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="opacity-65">
                        CPU ({stats.cores} 核)
                      </span>
                      <div className="flex items-center gap-2">
                        <Sparkline values={state.cpuHistory} />
                        <span className="w-11 text-right font-mono font-medium">
                          {stats.cpuPercent !== null
                            ? `${stats.cpuPercent.toFixed(1)}%`
                            : "—"}
                        </span>
                      </div>
                    </div>
                    <ProgressBar percent={stats.cpuPercent ?? 0} />

                    <div className="flex items-center justify-between">
                      <span className="opacity-65">内存</span>
                      <span className="font-mono text-[11px]">
                        {formatBytes(stats.memUsed)} /{" "}
                        {formatBytes(stats.memTotal)} ({memPct.toFixed(0)}%)
                      </span>
                    </div>
                    <ProgressBar percent={memPct} />

                    <div className="flex items-center justify-between">
                      <span className="opacity-65">磁盘 (/)</span>
                      <span className="font-mono text-[11px]">
                        {formatBytes(stats.diskUsed)} /{" "}
                        {formatBytes(stats.diskTotal)} ({diskPct.toFixed(0)}%)
                      </span>
                    </div>
                    <ProgressBar percent={diskPct} />

                    <div
                      className="flex items-center justify-between border-t pt-2 text-[11px] opacity-75"
                      style={{ borderColor: "var(--separator)" }}
                    >
                      <span>
                        负载 {stats.load1.toFixed(2)} ·{" "}
                        {formatUptime(stats.uptimeSecs)}
                      </span>
                      <span className="inline-flex items-center gap-2 font-mono">
                        <span className="inline-flex items-center gap-0.5">
                          <ArrowDown className="h-3 w-3 text-emerald-500" />
                          {formatRate(stats.netRxRate)}
                        </span>
                        <span className="inline-flex items-center gap-0.5">
                          <ArrowUp className="h-3 w-3 text-blue-500" />
                          {formatRate(stats.netTxRate)}
                        </span>
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="py-8 text-center text-xs opacity-55">
                    正在采集系统指标…
                  </div>
                )}
              </div>

              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={() => onOpenTerminal(srv)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500/12 px-3 py-1.5 text-xs font-medium text-blue-500 transition hover:bg-blue-500/20"
                >
                  <TerminalIcon className="h-3.5 w-3.5" />
                  <span>打开终端</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const color =
    clamped > 85
      ? "bg-red-500"
      : clamped > 65
        ? "bg-amber-500"
        : "bg-blue-500";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/8 dark:bg-white/10">
      <div
        className={`h-full rounded-full transition-all duration-300 ${color}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return <div className="h-4 w-16" />;
  }
  const w = 64;
  const h = 16;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - (Math.max(0, Math.min(100, v)) / 100) * (h - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={pts}
      />
    </svg>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(val >= 10 ? 1 : 2)} ${units[i]}`;
}

function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  if (rate < 1024) return `${Math.round(rate)} B/s`;
  if (rate < 1024 * 1024) return `${(rate / 1024).toFixed(1)} K/s`;
  return `${(rate / (1024 * 1024)).toFixed(1)} M/s`;
}

function formatUptime(secs: number): string {
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((secs % 3600) / 60);
  return `${hours}h ${mins}m`;
}
