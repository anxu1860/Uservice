import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  BarChart3,
  KeyRound,
  Plus,
  Server as ServerIcon,
  ShieldCheck,
  Sparkles,
  Terminal as TerminalIcon,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
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
  "rounded-2xl border border-zinc-200 bg-white p-6 transition-all duration-300 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-700";

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
      <div className="flex h-full items-center justify-center bg-zinc-50 p-8 dark:bg-black">
        <div className={cn(CARD_CLS, "max-w-md text-center")}>
          <div className="mx-auto mb-4 inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            <Sparkles className="h-3.5 w-3.5" />
            <span>无 Agent · SSH 实时监控</span>
          </div>
          <h1 className="mb-2 text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
            欢迎使用 ServerHub
          </h1>
          <p className="mb-6 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
            添加你的第一台 Linux 服务器或导入 ~/.ssh/config，即可在此查看实时资源占用、延迟排行与快速开启终端。
          </p>
          <button
            type="button"
            onClick={onAddServer}
            className="inline-flex items-center gap-1.5 rounded-xl bg-blue-500 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-blue-600"
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
    <div className="h-full overflow-y-auto bg-zinc-50 dark:bg-black">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 px-6 py-8">
        {/* Hero Header */}
        <div className="flex flex-col gap-3">
          <div className="inline-flex w-fit items-center gap-2 rounded-full border border-zinc-200 bg-white px-3.5 py-1.5 dark:border-zinc-700 dark:bg-zinc-900">
            <Sparkles className="h-3.5 w-3.5 text-blue-500" />
            <span className="text-xs font-semibold tracking-wide text-zinc-600 dark:text-zinc-300">
              无 Agent · SSH 实时监控
            </span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 md:text-4xl dark:text-white">
            服务器概览
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            共 {servers.length} 台 · 在线 {summary.onlineCount} 台 · 每 3 秒刷新
          </p>
        </div>

        {/* Main Bento Grid */}
        <div className="grid auto-rows-[minmax(150px,auto)] grid-cols-1 gap-4 md:grid-cols-4">
          {/* Large Hero Card - Cluster Health */}
          <div
            className={cn(
              CARD_CLS,
              "flex flex-col justify-between gap-5 md:col-span-2 md:row-span-2"
            )}
          >
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                <Activity className="h-3.5 w-3.5 text-emerald-500" />
                <span>集群健康</span>
              </div>
              <h2 className="text-xl font-bold tracking-tight text-zinc-900 dark:text-white">
                节点实时状态
              </h2>
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
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
                      "flex flex-col rounded-xl border p-3 text-left transition-all duration-200",
                      isSelected
                        ? "border-zinc-300 bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-800"
                        : "border-zinc-200 bg-zinc-50 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={cn("h-2 w-2 shrink-0 rounded-full", dot)}
                      />
                      <span className="truncate text-xs font-semibold text-zinc-900 dark:text-white">
                        {srv.name}
                      </span>
                    </div>
                    <span className="mt-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                      {subText}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Selected Server Detail */}
            {selectedServer && (
              <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                      {selectedStats
                        ? `${selectedStats.hostname} · ${selectedStats.os}`
                        : `${selectedServer.username}@${selectedServer.host}:${selectedServer.port}`}
                    </p>
                    <div className="mt-1 flex items-baseline gap-2">
                      <span className="font-mono text-4xl font-bold text-zinc-900 dark:text-white">
                        {selectedStats?.cpuPercent !== null &&
                        selectedStats?.cpuPercent !== undefined
                          ? `${selectedStats.cpuPercent.toFixed(1)}%`
                          : "—"}
                      </span>
                      {selectedStats && (
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">
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
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-600"
                    >
                      <TerminalIcon className="h-3.5 w-3.5" />
                      <span>打开终端</span>
                    </button>
                  </div>
                </div>

                {selectedStats && (
                  <div className="mt-4 space-y-2 text-xs">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="mb-1 flex justify-between text-[11px]">
                          <span className="text-zinc-500 dark:text-zinc-400">
                            内存
                          </span>
                          <span className="font-mono text-zinc-700 dark:text-zinc-300">
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
                        <div className="mb-1 flex justify-between text-[11px]">
                          <span className="text-zinc-500 dark:text-zinc-400">
                            磁盘 (/)
                          </span>
                          <span className="font-mono text-zinc-700 dark:text-zinc-300">
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
                    <div className="flex justify-between pt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
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
              <div className="mb-4 flex items-center justify-between">
                <div className="rounded-lg border border-zinc-200 bg-zinc-100 p-2 dark:border-zinc-700 dark:bg-zinc-800">
                  <BarChart3 className="h-4 w-4 text-zinc-900 dark:text-white" />
                </div>
                <span className="rounded-lg bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-500">
                  Live
                </span>
              </div>
              <h3 className="text-sm font-bold text-zinc-900 dark:text-white">
                全局性能
              </h3>
              <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
                实时聚合指标
              </p>

              <div className="space-y-2">
                {perfMetrics.map((m, idx) => (
                  <button
                    key={m.label}
                    type="button"
                    onClick={() => setSelectedMetric(idx)}
                    className={cn(
                      "w-full rounded-lg border p-2 text-left transition-all duration-200",
                      selectedMetric === idx
                        ? "border-zinc-300 bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-800"
                        : "border-zinc-200 bg-zinc-50 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
                    )}
                  >
                    <p className="text-[10px] text-zinc-500 dark:text-zinc-400">
                      {m.label}
                    </p>
                    <div className="mt-0.5 flex items-baseline justify-between">
                      <span className="font-mono text-sm font-bold text-zinc-900 dark:text-white">
                        {m.value}
                      </span>
                      <span className="font-mono text-[10px] font-semibold text-zinc-500 dark:text-zinc-300">
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
              <div className="mb-4 w-fit rounded-lg border border-zinc-200 bg-zinc-100 p-2 dark:border-zinc-700 dark:bg-zinc-800">
                <Zap className="h-4 w-4 text-amber-500" />
              </div>
              <h3 className="text-sm font-bold text-zinc-900 dark:text-white">
                延迟排行
              </h3>
              <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
                TCP 握手往返耗时
              </p>

              {summary.latencyRanking.length === 0 ? (
                <div className="py-8 text-center text-xs text-zinc-500 dark:text-zinc-400">
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
                        <div className="flex items-center justify-between text-xs">
                          <span className="truncate font-medium text-zinc-900 dark:text-white">
                            {server.name}
                          </span>
                          <span className="shrink-0 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                            {Math.round(latencyMs)} ms
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
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
              <div className="mb-3 flex items-center gap-2">
                <div className="rounded-lg border border-zinc-200 bg-zinc-100 p-2 dark:border-zinc-700 dark:bg-zinc-800">
                  <TerminalIcon className="h-4 w-4 text-zinc-900 dark:text-white" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-zinc-900 dark:text-white">
                    快速连接
                  </h3>
                </div>
              </div>

              <div className="max-h-40 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-300 dark:bg-black">
                <div className="flex gap-3 text-zinc-500">
                  <span className="w-5 text-right select-none">1</span>
                  <span>{"// 点击任意一行打开终端"}</span>
                </div>
                {servers.slice(0, 6).map((srv, idx) => (
                  <button
                    key={srv.id}
                    type="button"
                    onClick={() => onOpenTerminal(srv)}
                    className="flex w-full gap-3 rounded px-1 py-0.5 text-left transition hover:bg-zinc-800/80"
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

        {/* Bottom Stats */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {bottomStats.map((stat) => {
            const Icon = stat.icon;
            return (
              <div key={stat.label} className={cn(CARD_CLS, "p-4")}>
                <Icon className="mb-3 h-4 w-4 text-zinc-700 dark:text-zinc-300" />
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {stat.label}
                </p>
                <p className="mt-1 font-mono text-xl font-bold text-zinc-900 dark:text-white">
                  {stat.value}
                </p>
              </div>
            );
          })}
        </div>

        {/* All Servers Detail Grid */}
        <div>
          <h2 className="mb-4 text-base font-semibold text-zinc-900 dark:text-white">
            全部服务器
          </h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
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
                  ? "text-zinc-500 dark:text-zinc-400"
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
                  className={cn(
                    CARD_CLS,
                    "flex flex-col justify-between p-5"
                  )}
                >
                  <div>
                    <div className="mb-3 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "h-2 w-2 shrink-0 rounded-full",
                              statusDot
                            )}
                          />
                          <span className="truncate text-sm font-semibold text-zinc-900 dark:text-white">
                            {srv.name}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                          {srv.username}@{srv.host}:{srv.port}
                        </div>
                      </div>
                      {latency != null && (
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-medium",
                            latencyClass
                          )}
                        >
                          {Math.round(latency)} ms
                        </span>
                      )}
                    </div>

                    {state.kind === "need_password" ? (
                      <div className="my-5 flex flex-col items-center gap-2 text-center">
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          需要登录密码以采集状态
                        </p>
                        <button
                          type="button"
                          onClick={() => onNeedPassword(srv)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs font-medium text-zinc-800 transition hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-700"
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
                          <span className="text-zinc-500 dark:text-zinc-400">
                            CPU ({stats.cores} 核)
                          </span>
                          <div className="flex items-center gap-2">
                            <Sparkline values={state.cpuHistory} />
                            <span className="w-11 text-right font-mono font-medium text-zinc-900 dark:text-white">
                              {stats.cpuPercent !== null
                                ? `${stats.cpuPercent.toFixed(1)}%`
                                : "—"}
                            </span>
                          </div>
                        </div>
                        <ProgressBar percent={stats.cpuPercent ?? 0} />

                        <div className="flex items-center justify-between">
                          <span className="text-zinc-500 dark:text-zinc-400">
                            内存
                          </span>
                          <span className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                            {formatBytes(stats.memUsed)} /{" "}
                            {formatBytes(stats.memTotal)} ({memPct.toFixed(0)}%)
                          </span>
                        </div>
                        <ProgressBar percent={memPct} />

                        <div className="flex items-center justify-between">
                          <span className="text-zinc-500 dark:text-zinc-400">
                            磁盘 (/)
                          </span>
                          <span className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                            {formatBytes(stats.diskUsed)} /{" "}
                            {formatBytes(stats.diskTotal)} ({diskPct.toFixed(0)}
                            %)
                          </span>
                        </div>
                        <ProgressBar percent={diskPct} />

                        <div className="flex items-center justify-between border-t border-zinc-200 pt-2 text-[11px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
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
                      <div className="py-8 text-center text-xs text-zinc-500 dark:text-zinc-400">
                        正在采集系统指标…
                      </div>
                    )}
                  </div>

                  <div className="mt-4 flex justify-end">
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
      return "bg-zinc-400";
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
        : "bg-blue-500";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
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
