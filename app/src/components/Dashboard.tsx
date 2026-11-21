import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  BarChart3,
  Check,
  Copy,
  KeyRound,
  Plus,
  Server as ServerIcon,
  ShieldCheck,
  Sparkles,
  Terminal as TerminalIcon,
  Zap,
} from "lucide-react";
import { cn, copyToClipboard } from "@/lib/utils";
import { ProviderIcon } from "./ProviderIcon";
import { ServerCopyActions } from "./ServerCopyActions";
import {
  ServerStatusBlock,
  type Availability,
  type AvailabilityIncident,
} from "./ServerStatusBlock";
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

const CARD_CLS =
  "rounded-[22px] bg-card p-5 shadow-[0_0_0_0.5px_var(--color-border),0_8px_24px_rgb(0_0_0/0.04)]";

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedMetric, setSelectedMetric] = useState(0);
  const [availability, setAvailability] = useState<
    Record<string, { history: Availability[]; lastIncidentAt?: number }>
  >({});
  const [incidents, setIncidents] = useState<AvailabilityIncident[]>([]);
  const [copiedEndpointId, setCopiedEndpointId] = useState<string | null>(null);
  const endpointCopyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (endpointCopyTimerRef.current !== null) {
        window.clearTimeout(endpointCopyTimerRef.current);
      }
    };
  }, []);

  const handleCopyEndpoint = async (srv: Server) => {
    const ok = await copyToClipboard(`${srv.username}@${srv.host}:${srv.port}`);
    if (!ok) return;
    setCopiedEndpointId(srv.id);
    if (endpointCopyTimerRef.current !== null) {
      window.clearTimeout(endpointCopyTimerRef.current);
    }
    endpointCopyTimerRef.current = window.setTimeout(() => {
      setCopiedEndpointId(null);
      endpointCopyTimerRef.current = null;
    }, 1600);
  };

  const recordSample = (srv: Server, status: Availability, desc: string) => {
    const now = Date.now();
    setAvailability((prev) => {
      const entry = prev[srv.id] ?? { history: [] };
      const prevStatus =
        entry.history.length > 0
          ? entry.history[entry.history.length - 1]
          : undefined;
      const nextHistory = [...entry.history.slice(-29), status];
      let nextLastIncidentAt = entry.lastIncidentAt;

      if (prevStatus !== status) {
        if (status === "degraded" || status === "down") {
          nextLastIncidentAt = now;
          setIncidents((incPrev) =>
            [
              {
                id: crypto.randomUUID(),
                serverId: srv.id,
                serverName: srv.name,
                at: now,
                status,
                desc,
              },
              ...incPrev,
            ].slice(0, 20)
          );
        } else if (
          status === "up" &&
          (prevStatus === "degraded" || prevStatus === "down")
        ) {
          setIncidents((incPrev) =>
            [
              {
                id: crypto.randomUUID(),
                serverId: srv.id,
                serverName: srv.name,
                at: now,
                status: "up" as Availability,
                desc: "已恢复",
              },
              ...incPrev,
            ].slice(0, 20)
          );
        }
      }

      return {
        ...prev,
        [srv.id]: {
          history: nextHistory,
          lastIncidentAt: nextLastIncidentAt,
        },
      };
    });
  };

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
        const reasons: string[] = [];
        if (stats.latencyMs !== null && stats.latencyMs > 200) {
          reasons.push(`延迟过高 ${Math.round(stats.latencyMs)}ms`);
        }
        if (stats.cpuPercent !== null && stats.cpuPercent > 90) {
          reasons.push("CPU 过高");
        }
        if (stats.memTotal > 0 && stats.memUsed / stats.memTotal > 0.9) {
          reasons.push("内存不足");
        }
        if (stats.diskTotal > 0 && stats.diskUsed / stats.diskTotal > 0.9) {
          reasons.push("磁盘将满");
        }
        if (reasons.length > 0) {
          recordSample(srv, "degraded", reasons.join("、"));
        } else {
          recordSample(srv, "up", "");
        }
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
          recordSample(srv, "unknown", "");
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
          recordSample(srv, "unknown", "");
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
        recordSample(srv, "down", err.message);
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

  const summary = useMemo(() => {
    let onlineCount = 0;
    let latSum = 0;
    let latCount = 0;
    let cpuSum = 0;
    let cpuCount = 0;
    let rxSum = 0;
    let txSum = 0;
    let hasNet = false;
    const ranking: { server: Server; latencyMs: number }[] = [];

    for (const srv of servers) {
      const st = cards[srv.id];
      if (!st || st.kind !== "online") continue;
      onlineCount++;
      const s = st.stats;
      if (s.latencyMs !== null) {
        latSum += s.latencyMs;
        latCount++;
        ranking.push({ server: srv, latencyMs: s.latencyMs });
      }
      if (s.cpuPercent !== null) {
        cpuSum += s.cpuPercent;
        cpuCount++;
      }
      if (s.netRxRate !== null) {
        rxSum += s.netRxRate;
        hasNet = true;
      }
      if (s.netTxRate !== null) {
        txSum += s.netTxRate;
        hasNet = true;
      }
    }

    ranking.sort((a, b) => a.latencyMs - b.latencyMs);

    return {
      onlineCount,
      avgLatency: latCount > 0 ? latSum / latCount : null,
      avgCpu: cpuCount > 0 ? cpuSum / cpuCount : null,
      totalRx: hasNet ? rxSum : null,
      totalTx: hasNet ? txSum : null,
      latencyRanking: ranking.slice(0, 5),
    };
  }, [servers, cards]);

  const effectiveSelectedId =
    selectedId && servers.some((s) => s.id === selectedId)
      ? selectedId
      : (servers[0]?.id ?? null);
  const selectedServer =
    servers.find((s) => s.id === effectiveSelectedId) ?? null;
  const selectedState = selectedServer
    ? (cards[selectedServer.id] ?? {
        kind: "connecting" as const,
        cpuHistory: [],
      })
    : null;
  const selectedStats =
    selectedState &&
    (selectedState.kind === "online" || selectedState.kind === "connecting")
      ? selectedState.stats
      : undefined;

  if (servers.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-8">
        <div className={cn(CARD_CLS, "max-w-md p-7 text-center")}>
          <div className="mx-auto mb-4 inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1 text-[13px] font-medium text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            <span>无 Agent · SSH 实时监控</span>
          </div>
          <h1 className="mb-2 text-[28px] font-bold tracking-[-0.02em] text-card-foreground">
            欢迎使用 ServerHub
          </h1>
          <p className="mb-6 text-[15px] leading-relaxed text-muted-foreground">
            添加你的第一台 Linux 服务器或导入 ~/.ssh/config，即可在此查看实时资源占用、延迟排行与快速开启终端。
          </p>
          <button
            type="button"
            onClick={onAddServer}
            className="inline-flex h-11 items-center gap-1.5 rounded-[12px] bg-primary px-5 text-[15px] font-semibold text-primary-foreground transition active:scale-[.97]"
          >
            <Plus className="h-4 w-4" />
            <span>添加服务器</span>
          </button>
        </div>
      </div>
    );
  }

  const perfMetrics = [
    {
      label: "在线率",
      value: `${summary.onlineCount}/${servers.length}`,
      badge:
        servers.length > 0
          ? `${Math.round((summary.onlineCount / servers.length) * 100)}%`
          : "0%",
    },
    {
      label: "平均延迟",
      value:
        summary.avgLatency !== null
          ? `${Math.round(summary.avgLatency)} ms`
          : "—",
      badge: "TCP",
    },
    {
      label: "平均 CPU",
      value:
        summary.avgCpu !== null ? `${summary.avgCpu.toFixed(1)}%` : "—",
      badge: "Load",
    },
    {
      label: "总网速",
      value: `↓${formatRate(summary.totalRx)}`,
      badge: `↑${formatRate(summary.totalTx)}`,
    },
  ];

  const availabilityRows = servers.map((s) => {
    const a = availability[s.id];
    const h = a?.history ?? [];
    return {
      server: s,
      current: h.length > 0 ? h[h.length - 1] : ("unknown" as Availability),
      history: h,
      lastIncidentAt: a?.lastIncidentAt,
    };
  });

  const bottomStats = [
    {
      label: "服务器总数",
      value: String(servers.length),
      icon: ServerIcon,
    },
    {
      label: "当前在线",
      value: `${summary.onlineCount} 台`,
      icon: ShieldCheck,
    },
    {
      label: "平均延迟",
      value:
        summary.avgLatency !== null
          ? `${Math.round(summary.avgLatency)} ms`
          : "—",
      icon: Zap,
    },
    {
      label: "总下行 / 上行",
      value: `${formatRate(summary.totalRx)} / ${formatRate(summary.totalTx)}`,
      icon: ArrowDownUp,
    },
  ];

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-5 py-6">
        {/* Hero Header */}
        <div className="flex flex-col gap-1">
          <h1 className="text-[28px] font-bold tracking-[-0.02em] text-foreground">
            服务器概览
          </h1>
          <p className="text-[13px] text-muted-foreground">
            共 {servers.length} 台 · 在线 {summary.onlineCount} 台 · 每 3 秒刷新
          </p>
        </div>

        {/* Main Bento Grid */}
        <div className="grid auto-rows-[minmax(150px,auto)] grid-cols-1 gap-3 md:grid-cols-4">
          {/* Large Hero Card - Cluster Health */}
          <div
            className={cn(
              CARD_CLS,
              "flex flex-col justify-between gap-4 md:col-span-2 md:row-span-2"
            )}
          >
            <div>
              <div className="mb-2.5 inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-[13px] font-medium text-foreground">
                <Activity className="h-3.5 w-3.5 text-emerald-500" />
                <span>集群健康</span>
              </div>
              <h2 className="text-[17px] font-semibold text-card-foreground">
                节点实时状态
              </h2>
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                点击节点切换查看详细指标
              </p>
            </div>

            {/* 2-col Server Selector */}
            <div className="grid grid-cols-2 gap-2.5">
              {servers.slice(0, 6).map((srv) => {
                const st = cards[srv.id];
                const isSelected = srv.id === effectiveSelectedId;
                const dot = getStatusDot(st?.kind ?? "connecting");
                const subText =
                  st?.kind === "online"
                    ? st.stats.cpuPercent !== null
                      ? `CPU ${st.stats.cpuPercent.toFixed(1)}%`
                      : "在线"
                    : st?.kind === "need_password"
                      ? "需要密码"
                      : st?.kind === "error"
                        ? "连接异常"
                        : "采集中…";
                return (
                  <button
                    key={srv.id}
                    type="button"
                    onClick={() => setSelectedId(srv.id)}
                    className={cn(
                      "flex flex-col rounded-[14px] p-3 text-left transition-all duration-200",
                      isSelected
                        ? "bg-primary/10 ring-1 ring-primary/40"
                        : "bg-muted hover:bg-muted/80"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <ProviderIcon server={srv} className="h-3.5 w-3.5" />
                      <span
                        className={cn("h-2 w-2 shrink-0 rounded-full", dot)}
                      />
                      <span className="truncate text-[13px] font-semibold text-card-foreground">
                        {srv.name}
                      </span>
                    </div>
                    <span className="mt-1 font-mono text-[12px] text-muted-foreground">
                      {subText}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Selected Server Detail */}
            {selectedServer && (
              <div className="rounded-[14px] bg-muted p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="font-mono text-[12px] text-muted-foreground">
                      {selectedStats
                        ? `${selectedStats.hostname} · ${selectedStats.os}`
                        : `${selectedServer.username}@${selectedServer.host}:${selectedServer.port}`}
                    </p>
                    <div className="mt-1 flex items-baseline gap-2">
                      <span className="font-mono text-4xl font-bold tabular-nums text-card-foreground">
                        {selectedStats?.cpuPercent !== null &&
                        selectedStats?.cpuPercent !== undefined
                          ? `${selectedStats.cpuPercent.toFixed(1)}%`
                          : "—"}
                      </span>
                      {selectedStats && (
                        <span className="text-[13px] text-muted-foreground">
                          CPU ({selectedStats.cores} 核)
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <Sparkline
                      values={selectedState?.cpuHistory ?? []}
                      width={240}
                      height={48}
                    />
                    <button
                      type="button"
                      onClick={() => onOpenTerminal(selectedServer)}
                      className="inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground transition active:scale-[.97]"
                    >
                      <TerminalIcon className="h-3.5 w-3.5" />
                      <span>打开终端</span>
                    </button>
                  </div>
                </div>

                {selectedStats && (
                  <div className="mt-4 space-y-2 text-[13px]">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="mb-1 flex justify-between text-[12px]">
                          <span className="text-muted-foreground">内存</span>
                          <span className="font-mono tabular-nums text-card-foreground">
                            {formatBytes(selectedStats.memUsed)} /{" "}
                            {formatBytes(selectedStats.memTotal)}
                          </span>
                        </div>
                        <ProgressBar
                          percent={
                            selectedStats.memTotal > 0
                              ? (selectedStats.memUsed /
                                  selectedStats.memTotal) *
                                100
                              : 0
                          }
                        />
                      </div>
                      <div>
                        <div className="mb-1 flex justify-between text-[12px]">
                          <span className="text-muted-foreground">磁盘 (/)</span>
                          <span className="font-mono tabular-nums text-card-foreground">
                            {formatBytes(selectedStats.diskUsed)} /{" "}
                            {formatBytes(selectedStats.diskTotal)}
                          </span>
                        </div>
                        <ProgressBar
                          percent={
                            selectedStats.diskTotal > 0
                              ? (selectedStats.diskUsed /
                                  selectedStats.diskTotal) *
                                100
                              : 0
                          }
                        />
                      </div>
                    </div>
                    <div className="flex justify-between pt-1 text-[12px] text-muted-foreground">
                      <span>
                        负载 {selectedStats.load1.toFixed(2)} /{" "}
                        {selectedStats.load5.toFixed(2)} /{" "}
                        {selectedStats.load15.toFixed(2)}
                      </span>
                      <span>运行时长 {formatUptime(selectedStats.uptimeSecs)}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Performance Summary Card */}
          <div className={cn(CARD_CLS, "flex flex-col justify-between")}>
            <div>
              <div className="mb-3 flex items-center justify-between">
                <div className="rounded-[10px] bg-muted p-2">
                  <BarChart3 className="h-4 w-4 text-foreground" />
                </div>
                <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[12px] font-semibold text-emerald-500">
                  Live
                </span>
              </div>
              <h3 className="text-[17px] font-semibold text-card-foreground">
                全局性能
              </h3>
              <p className="mb-3 text-[13px] text-muted-foreground">
                实时聚合指标
              </p>

              <div className="space-y-2">
                {perfMetrics.map((m, idx) => (
                  <button
                    key={m.label}
                    type="button"
                    onClick={() => setSelectedMetric(idx)}
                    className={cn(
                      "w-full rounded-[12px] p-2.5 text-left transition-all duration-200",
                      selectedMetric === idx
                        ? "bg-primary/10 ring-1 ring-primary/40"
                        : "bg-muted hover:bg-muted/80"
                    )}
                  >
                    <p className="text-[11px] text-muted-foreground">
                      {m.label}
                    </p>
                    <div className="mt-0.5 flex items-baseline justify-between">
                      <span className="font-mono text-[15px] font-bold tabular-nums text-card-foreground">
                        {m.value}
                      </span>
                      <span className="font-mono text-[11px] font-semibold text-muted-foreground">
                        {m.badge}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Latency Ranking Card */}
          <div className={cn(CARD_CLS, "flex flex-col justify-between")}>
            <div>
              <div className="mb-3 w-fit rounded-[10px] bg-muted p-2">
                <Zap className="h-4 w-4 text-amber-500" />
              </div>
              <h3 className="text-[17px] font-semibold text-card-foreground">
                延迟排行
              </h3>
              <p className="mb-3 text-[13px] text-muted-foreground">
                TCP 握手往返耗时
              </p>

              {summary.latencyRanking.length === 0 ? (
                <div className="py-8 text-center text-[13px] text-muted-foreground">
                  暂无延迟数据
                </div>
              ) : (
                <div className="space-y-2.5">
                  {summary.latencyRanking.map(({ server, latencyMs }) => {
                    const pct = Math.min(100, (latencyMs / 300) * 100);
                    const barColor =
                      latencyMs < 80
                        ? "bg-emerald-500"
                        : latencyMs < 200
                          ? "bg-amber-500"
                          : "bg-red-500";
                    return (
                      <div key={server.id} className="space-y-1">
                        <div className="flex items-center justify-between text-[13px]">
                          <span className="truncate font-medium text-card-foreground">
                            {server.name}
                          </span>
                          <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground">
                            {Math.round(latencyMs)} ms
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn(
                              "h-full rounded-full transition-all duration-300",
                              barColor
                            )}
                            style={{ width: `${Math.max(6, pct)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Quick Connect Card */}
          <div
            className={cn(
              CARD_CLS,
              "flex flex-col justify-between md:col-span-2"
            )}
          >
            <div>
              <div className="mb-3 flex items-center gap-2.5">
                <div className="rounded-[10px] bg-muted p-2">
                  <TerminalIcon className="h-4 w-4 text-foreground" />
                </div>
                <h3 className="text-[17px] font-semibold text-card-foreground">
                  快速连接
                </h3>
              </div>

              <div className="max-h-40 overflow-auto rounded-[14px] bg-black p-3 font-mono text-xs leading-relaxed text-zinc-300">
                <div className="flex gap-3 text-zinc-500">
                  <span className="w-5 text-right select-none">1</span>
                  <span>{"// 点击任意一行打开终端"}</span>
                </div>
                {servers.slice(0, 6).map((srv, idx) => (
                  <button
                    key={srv.id}
                    type="button"
                    onClick={() => onOpenTerminal(srv)}
                    className="flex w-full gap-3 rounded px-1 py-0.5 text-left transition hover:bg-white/10"
                  >
                    <span className="w-5 text-right text-zinc-600 select-none">
                      {idx + 2}
                    </span>
                    <span className="truncate">
                      <span className="text-emerald-400">ssh</span>{" "}
                      <span className="text-zinc-200">
                        {srv.username}@{srv.host}
                      </span>{" "}
                      {srv.port !== 22 && (
                        <span className="text-zinc-400">-p {srv.port} </span>
                      )}
                      <span className="text-zinc-500"># {srv.name}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Batch Availability */}
        <ServerStatusBlock rows={availabilityRows} incidents={incidents} />

        {/* Bottom Stats */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {bottomStats.map((stat) => {
            const Icon = stat.icon;
            return (
              <div key={stat.label} className={CARD_CLS}>
                <Icon className="mb-2.5 h-4 w-4 text-muted-foreground" />
                <p className="text-[13px] text-muted-foreground">
                  {stat.label}
                </p>
                <p className="mt-1 font-mono text-xl font-bold tabular-nums text-card-foreground">
                  {stat.value}
                </p>
              </div>
            );
          })}
        </div>

        {/* All Servers Detail Grid */}
        <div>
          <h2 className="mb-3 text-[17px] font-semibold text-foreground">
            全部服务器
          </h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
            {servers.map((srv) => {
              const state = cards[srv.id] ?? {
                kind: "connecting" as const,
                cpuHistory: [],
              };
              const stats =
                state.kind === "online" || state.kind === "connecting"
                  ? state.stats
                  : undefined;

              const statusDot = getStatusDot(state.kind);
              const latency = stats?.latencyMs;
              const latencyClass =
                latency == null
                  ? "text-muted-foreground"
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
                <div
                  key={srv.id}
                  className={cn(CARD_CLS, "flex flex-col justify-between")}
                >
                  <div>
                    <div className="mb-3 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <ProviderIcon server={srv} />
                          <span
                            className={cn(
                              "h-2 w-2 shrink-0 rounded-full",
                              statusDot
                            )}
                          />
                          <span className="truncate text-[15px] font-semibold text-card-foreground">
                            {srv.name}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleCopyEndpoint(srv)}
                          title="点击复制连接地址"
                          className="group/addr mt-0.5 inline-flex max-w-full items-center gap-1.5 rounded-[6px] px-1 -mx-1 py-0.5 font-mono text-[12px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
                        >
                          <span className="truncate">
                            {srv.username}@{srv.host}:{srv.port}
                          </span>
                          {copiedEndpointId === srv.id ? (
                            <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-sans font-medium text-emerald-500">
                              <Check className="h-3 w-3" />
                              已复制
                            </span>
                          ) : (
                            <Copy className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/addr:opacity-100" />
                          )}
                        </button>
                      </div>
                      {latency != null && (
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-2.5 py-0.5 font-mono text-[11px] font-medium tabular-nums",
                            latencyClass
                          )}
                        >
                          {Math.round(latency)} ms
                        </span>
                      )}
                    </div>

                    {state.kind === "need_password" ? (
                      <div className="my-5 flex flex-col items-center gap-2.5 text-center">
                        <p className="text-[13px] text-muted-foreground">
                          需要登录密码以采集状态
                        </p>
                        <button
                          type="button"
                          onClick={() => onNeedPassword(srv)}
                          className="inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-muted px-3.5 text-[13px] font-medium text-foreground transition active:scale-[.97]"
                        >
                          <KeyRound className="h-3.5 w-3.5 text-primary" />
                          <span>输入密码开始监控</span>
                        </button>
                      </div>
                    ) : state.kind === "error" && !stats ? (
                      <div className="my-4 rounded-[12px] bg-destructive/10 p-3 text-[13px] text-destructive">
                        {state.message}
                      </div>
                    ) : stats ? (
                      <div className="space-y-2.5 text-[13px]">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-muted-foreground">
                            CPU ({stats.cores} 核)
                          </span>
                          <div className="flex items-center gap-2">
                            <Sparkline values={state.cpuHistory} />
                            <span className="w-12 text-right font-mono font-medium tabular-nums text-card-foreground">
                              {stats.cpuPercent !== null
                                ? `${stats.cpuPercent.toFixed(1)}%`
                                : "—"}
                            </span>
                          </div>
                        </div>
                        <ProgressBar percent={stats.cpuPercent ?? 0} />

                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">内存</span>
                          <span className="font-mono text-[12px] tabular-nums text-card-foreground">
                            {formatBytes(stats.memUsed)} /{" "}
                            {formatBytes(stats.memTotal)} ({memPct.toFixed(0)}%)
                          </span>
                        </div>
                        <ProgressBar percent={memPct} />

                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">磁盘 (/)</span>
                          <span className="font-mono text-[12px] tabular-nums text-card-foreground">
                            {formatBytes(stats.diskUsed)} /{" "}
                            {formatBytes(stats.diskTotal)} ({diskPct.toFixed(0)}
                            %)
                          </span>
                        </div>
                        <ProgressBar percent={diskPct} />

                        <div className="flex items-center justify-between border-t-[0.5px] border-border pt-2.5 text-[12px] text-muted-foreground">
                          <span>
                            负载 {stats.load1.toFixed(2)} ·{" "}
                            {formatUptime(stats.uptimeSecs)}
                          </span>
                          <span className="inline-flex items-center gap-2 font-mono tabular-nums">
                            <span className="inline-flex items-center gap-0.5">
                              <ArrowDown className="h-3 w-3 text-emerald-500" />
                              {formatRate(stats.netRxRate)}
                            </span>
                            <span className="inline-flex items-center gap-0.5">
                              <ArrowUp className="h-3 w-3 text-primary" />
                              {formatRate(stats.netTxRate)}
                            </span>
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="py-8 text-center text-[13px] text-muted-foreground">
                        正在采集系统指标…
                      </div>
                    )}
                  </div>

                  <div className="mt-4 flex items-center justify-end gap-2">
                    <ServerCopyActions server={srv} />
                    <button
                      type="button"
                      onClick={() => onOpenTerminal(srv)}
                      className="inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-primary/10 px-3.5 text-[13px] font-semibold text-primary transition hover:bg-primary/15 active:scale-[.97]"
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
      </div>
    </div>
  );
}

function getStatusDot(kind: CardState["kind"]): string {
  switch (kind) {
    case "online":
      return "bg-emerald-500";
    case "connecting":
      return "bg-amber-400 animate-pulse";
    case "need_password":
      return "bg-muted-foreground/50";
    case "error":
      return "bg-red-500";
  }
}

function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const color =
    clamped > 85
      ? "bg-red-500"
      : clamped > 65
        ? "bg-amber-500"
        : "bg-primary";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn("h-full rounded-full transition-all duration-300", color)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function Sparkline({
  values,
  width = 64,
  height = 16,
}: {
  values: number[];
  width?: number;
  height?: number;
}) {
  if (values.length < 2) {
    return <div style={{ width, height }} />;
  }
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y =
        height - (Math.max(0, Math.min(100, v)) / 100) * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline
        fill="none"
        stroke="var(--color-primary)"
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
