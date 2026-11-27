import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  BellRing,
  Check,
  Clock,
  Copy,
  Cpu,
  KeyRound,
  LayoutGrid,
  List,
  Pencil,
  Plus,
  Server as ServerIcon,
  ShieldCheck,
  Sparkles,
  Terminal as TerminalIcon,
  Wallet,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import { cn, copyToClipboard } from "@/lib/utils";
import {
  calcDailyCost,
  formatCycleCost,
  formatMoney,
  getBillingCycleMeta,
  getCostFunComparison,
  getExpirationInfo,
  summarizeOverallCost,
} from "@/lib/cost";
import { BrandLogo } from "./BrandLogo";
import { getProviderCardGradient, ProviderIcon } from "./ProviderIcon";
import { RegionBadge } from "./RegionBadge";
import { ServerMoreMenu } from "./ServerMoreMenu";
import {
  buildSshAuthPayload,
  parseCmdError,
  type Server,
  type ServerStats,
} from "../types";

interface DashboardProps {
  servers: Server[];
  groups?: string[];
  selectedGroup?: string;
  onSelectGroup?: (group: string) => void;
  recentServerIds?: string[];
  visible: boolean;
  acceptedHostKeys: Record<string, string>;
  pollTrigger: number;
  onOpenTerminal: (server: Server) => void;
  onAddServer: () => void;
  onNeedPassword: (server: Server) => void;
  onHostKeyUnknown: (hostPort: string, fingerprint: string) => void;
  onServerOsDetected?: (serverId: string, os: string) => void;
  onServerLatency?: (serverId: string, latencyMs: number) => void;
  onServerStatsSummary?: (serverId: string, summary: string) => void;
  onDuplicateServer?: (server: Server) => void;
  onEditServer?: (server: Server) => void;
  onDeleteServer?: (server: Server) => void;
  monitorIntervalSec?: number;
  hideIp?: boolean;
}

type CardState =
  | { kind: "connecting"; stats?: ServerStats; cpuHistory: number[] }
  | { kind: "online"; stats: ServerStats; cpuHistory: number[] }
  | { kind: "need_password"; reason?: string; cpuHistory: number[] }
  | { kind: "error"; message: string; cpuHistory: number[] };

const CARD_CLS =
  "rounded-[22px] bg-card p-5 shadow-[0_0_0_0.5px_var(--color-border),0_8px_24px_rgb(0_0_0/0.04)]";

const VIEW_MODE_STORAGE_KEY = "serverhub.dashboard_view_mode.v1";
type ServerViewMode = "card" | "list";
type ListSortField = "name" | "cpu" | "memory" | "disk" | "network" | "latency";
type ListSortDir = "asc" | "desc";
type ListStatusFilter = "all" | "online" | "offline";

export const Dashboard = memo(function Dashboard({
  servers,
  groups = [],
  selectedGroup = "__all__",
  onSelectGroup,
  recentServerIds = [],
  visible,
  acceptedHostKeys,
  pollTrigger,
  onOpenTerminal,
  onAddServer,
  onNeedPassword,
  onHostKeyUnknown,
  onServerOsDetected,
  onServerLatency,
  onServerStatsSummary,
  onDuplicateServer,
  onEditServer,
  onDeleteServer,
  monitorIntervalSec = 3,
  hideIp = true,
}: DashboardProps) {
  const onOsDetectedRef = useRef(onServerOsDetected);
  onOsDetectedRef.current = onServerOsDetected;
  const onLatencyRef = useRef(onServerLatency);
  onLatencyRef.current = onServerLatency;
  const onStatsSummaryRef = useRef(onServerStatsSummary);
  onStatsSummaryRef.current = onServerStatsSummary;
  const onHostKeyUnknownRef = useRef(onHostKeyUnknown);
  onHostKeyUnknownRef.current = onHostKeyUnknown;
  const acceptedHostKeysRef = useRef(acceptedHostKeys);
  acceptedHostKeysRef.current = acceptedHostKeys;
  const intervalMsRef = useRef(monitorIntervalSec * 1000);
  intervalMsRef.current = Math.max(1, monitorIntervalSec) * 1000;
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const pollNowRef = useRef<((serverId: string) => void) | null>(null);
  const pausedIdsRef = useRef<Set<string>>(new Set());
  const [docVisible, setDocVisible] = useState(
    () => document.visibilityState === "visible"
  );
  const [copiedEndpointId, setCopiedEndpointId] = useState<string | null>(null);
  const [expiryDismissed, setExpiryDismissed] = useState(false);
  const [viewMode, setViewMode] = useState<ServerViewMode>(() => {
    try {
      const saved = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
      return saved === "list" ? "list" : "card";
    } catch {
      return "card";
    }
  });
  const handleViewModeChange = (mode: ServerViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore storage write errors
    }
  };
  const [listSort, setListSort] = useState<{
    field: ListSortField;
    dir: ListSortDir;
  } | null>(null);
  const [listStatusFilter, setListStatusFilter] =
    useState<ListStatusFilter>("all");

  const handleToggleListSort = useCallback((field: ListSortField) => {
    setListSort((prev) => {
      const defaultDir: ListSortDir =
        field === "name" || field === "latency" ? "asc" : "desc";
      const reverseDir: ListSortDir = defaultDir === "asc" ? "desc" : "asc";
      if (!prev || prev.field !== field) {
        return { field, dir: defaultDir };
      }
      if (prev.dir === defaultDir) {
        return { field, dir: reverseDir };
      }
      return null;
    });
  }, []);

  const handleCycleStatusFilter = useCallback(() => {
    setListStatusFilter((prev) =>
      prev === "all" ? "online" : prev === "online" ? "offline" : "all"
    );
  }, []);
  const endpointCopyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (endpointCopyTimerRef.current !== null) {
        window.clearTimeout(endpointCopyTimerRef.current);
      }
    };
  }, []);

  const handleCopyEndpoint = useCallback(async (srv: Server) => {
    const ok = await copyToClipboard(
      `${srv.username ? `${srv.username}@` : ""}${srv.host}:${srv.port}`
    );
    if (!ok) return;
    setCopiedEndpointId(srv.id);
    if (endpointCopyTimerRef.current !== null) {
      window.clearTimeout(endpointCopyTimerRef.current);
    }
    endpointCopyTimerRef.current = window.setTimeout(() => {
      setCopiedEndpointId(null);
      endpointCopyTimerRef.current = null;
    }, 1600);
  }, []);

  useEffect(() => {
    const onVis = () => setDocVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let ungrouped = 0;
    for (const s of servers) {
      const g = (s.group ?? "").trim();
      if (g) {
        counts.set(g, (counts.get(g) ?? 0) + 1);
      } else {
        ungrouped++;
      }
    }
    return { counts, ungrouped };
  }, [servers]);

  const recentCount = useMemo(() => {
    if (recentServerIds.length === 0) return 0;
    const idSet = new Set(servers.map((s) => s.id));
    return recentServerIds.filter((id) => idSet.has(id)).length;
  }, [servers, recentServerIds]);

  const displayedServers = useMemo(() => {
    if (selectedGroup === "__all__") return servers;
    if (selectedGroup === "__recent__") {
      const byId = new Map(servers.map((s) => [s.id, s]));
      return recentServerIds
        .map((id) => byId.get(id))
        .filter((s): s is Server => Boolean(s));
    }
    if (selectedGroup === "__ungrouped__") {
      return servers.filter((s) => !(s.group ?? "").trim());
    }
    return servers.filter((s) => (s.group ?? "").trim() === selectedGroup);
  }, [servers, selectedGroup, recentServerIds]);

  const activeGroupLabel =
    selectedGroup === "__all__"
      ? "全部服务器"
      : selectedGroup === "__recent__"
        ? "最近连接"
        : selectedGroup === "__ungrouped__"
          ? "未分组"
          : selectedGroup;

  const serversRef = useRef(displayedServers);
  serversRef.current = displayedServers;
  const prevServerSigsRef = useRef<Map<string, string>>(new Map());
  const serversKey = useMemo(
    () =>
      displayedServers
        .map(
          (s) =>
            `${s.id}:${s.host}:${s.port}:${s.username}:${JSON.stringify(s.auth)}:${JSON.stringify(s.auth_priority ?? [])}:${JSON.stringify(s.jump_hosts ?? [])}:${s.timeout_secs ?? ""}:${s.keepalive_secs ?? ""}:${s.protocol ?? "ssh"}`
        )
        .join("|"),
    [displayedServers]
  );

  // Prune stale card states when servers are deleted
  useEffect(() => {
    const validIds = new Set(servers.map((s) => s.id));
    setCards((prev) => {
      let changed = false;
      const next: Record<string, CardState> = {};
      for (const [id, val] of Object.entries(prev)) {
        if (validIds.has(id)) {
          next[id] = val;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    for (const id of Array.from(pausedIdsRef.current)) {
      if (!validIds.has(id)) {
        pausedIdsRef.current.delete(id);
      }
    }
  }, [servers]);

  useEffect(() => {
    const currentServers = serversRef.current;
    if (!visible || !docVisible || currentServers.length === 0) {
      pollNowRef.current = null;
      return;
    }

    let cancelled = false;
    const timers = new Map<string, number>();
    const failCounts = new Map<string, number>();
    const inFlight = new Set<string>();
    const pausedIds = pausedIdsRef.current;

    // Preserve pausedIds across tab/visibility switches, only unpausing servers whose config changed
    const nextSigs = new Map<string, string>();
    const currentIdSet = new Set<string>();
    for (const s of currentServers) {
      currentIdSet.add(s.id);
      const sig = `${s.host}:${s.port}:${s.username}:${JSON.stringify(s.auth)}:${JSON.stringify(s.auth_priority ?? [])}:${JSON.stringify(s.jump_hosts ?? [])}:${s.protocol ?? "ssh"}`;
      nextSigs.set(s.id, sig);
      if (prevServerSigsRef.current.get(s.id) !== sig) {
        pausedIds.delete(s.id);
      }
    }
    for (const id of Array.from(pausedIds)) {
      if (!currentIdSet.has(id)) {
        pausedIds.delete(id);
      }
    }
    prevServerSigsRef.current = nextSigs;

    // Coalesce rapid concurrent poll state updates into batched React commits (120ms window)
    const pendingPatches = new Map<string, (prev: CardState | undefined) => CardState | undefined>();
    let flushTimer: number | null = null;

    const flushCardPatches = () => {
      flushTimer = null;
      if (cancelled || pendingPatches.size === 0) return;
      const batch = new Map(pendingPatches);
      pendingPatches.clear();
      setCards((prev) => {
        let next: Record<string, CardState> | null = null;
        for (const [id, updater] of batch) {
          const cur = (next ?? prev)[id];
          const updated = updater(cur);
          if (updated && updated !== cur) {
            if (!next) next = { ...prev };
            next[id] = updated;
          }
        }
        return next ?? prev;
      });
    };

    const queueCardPatch = (
      serverId: string,
      updater: (prev: CardState | undefined) => CardState | undefined,
      immediate = false
    ) => {
      const existing = pendingPatches.get(serverId);
      pendingPatches.set(
        serverId,
        existing ? (prev) => updater(existing(prev)) : updater
      );
      if (immediate) {
        if (flushTimer !== null) {
          window.clearTimeout(flushTimer);
          flushTimer = null;
        }
        flushCardPatches();
      } else if (flushTimer === null) {
        flushTimer = window.setTimeout(flushCardPatches, 120);
      }
    };

    const schedulePoll = (srv: Server, delayMs: number) => {
      if (cancelled) return;
      const existing = timers.get(srv.id);
      if (existing !== undefined) {
        window.clearTimeout(existing);
      }
      timers.set(
        srv.id,
        window.setTimeout(() => {
          timers.delete(srv.id);
          void pollOne(srv);
        }, delayMs)
      );
    };

    const pollOne = async (srv: Server) => {
      if (cancelled) return;
      if (srv.protocol && srv.protocol !== "ssh") {
        return;
      }
      if (inFlight.has(srv.id)) {
        return;
      }
      inFlight.add(srv.id);
      pausedIds.delete(srv.id);

      queueCardPatch(srv.id, (cur) => {
        if (cur?.kind === "online") return cur;
        return {
          kind: "connecting",
          stats: cur && "stats" in cur ? cur.stats : undefined,
          cpuHistory: cur?.cpuHistory ?? [],
        };
      });

      const hostPort = `${srv.host}:${srv.port}`;
      const auth = buildSshAuthPayload(srv.auth);

      try {
        const stats = await invoke<ServerStats>("monitor_poll", {
          cfg: {
            server_id: srv.id,
            host: srv.host,
            port: srv.port,
            username: srv.username,
            auth,
            auth_priority: srv.auth_priority ?? [],
            timeout_secs: srv.timeout_secs ?? null,
            keepalive_secs: srv.keepalive_secs ?? null,
            jump_hosts: srv.jump_hosts ?? [],
            term_type: srv.term_type ?? null,
            accept_host_key: acceptedHostKeysRef.current[hostPort] ?? null,
          },
        });
        if (cancelled) return;
        const detectedOs = stats.os.trim();
        if (detectedOs && detectedOs !== srv.os) {
          onOsDetectedRef.current?.(srv.id, detectedOs);
        }
        if (stats.latencyMs !== null) {
          onLatencyRef.current?.(srv.id, Math.max(1, Math.round(stats.latencyMs)));
        }
        if (onStatsSummaryRef.current) {
          const parts: string[] = [];
          if (stats.cpuPercent !== null) {
            parts.push(`CPU ${stats.cpuPercent.toFixed(0)}% (${stats.cores}核)`);
          }
          if (stats.memTotal > 0) {
            const memPct = Math.round((stats.memUsed / stats.memTotal) * 100);
            const usedGb = (stats.memUsed / 1024 ** 3).toFixed(1);
            const totalGb = (stats.memTotal / 1024 ** 3).toFixed(1);
            parts.push(`内存 ${usedGb}/${totalGb}GB (${memPct}%)`);
          }
          if (stats.diskTotal > 0) {
            const diskPct = Math.round((stats.diskUsed / stats.diskTotal) * 100);
            parts.push(`磁盘 ${diskPct}%`);
          }
          parts.push(
            `负载 ${stats.load1.toFixed(2)}/${stats.load5.toFixed(2)}/${stats.load15.toFixed(2)}`
          );
          onStatsSummaryRef.current(srv.id, parts.join(" · "));
        }
        queueCardPatch(srv.id, (cur) => {
          const hist = cur?.cpuHistory ?? [];
          const nextHist =
            stats.cpuPercent !== null
              ? [...hist.slice(-29), stats.cpuPercent]
              : hist;
          return {
            kind: "online",
            stats,
            cpuHistory: nextHist,
          };
        });
        failCounts.delete(srv.id);
        const nextDelay =
          stats.cpuPercent === null ? 600 : intervalMsRef.current;
        schedulePoll(srv, nextDelay);
      } catch (rawErr) {
        if (cancelled) return;
        const err = parseCmdError(rawErr);
        if (err.kind === "busy") {
          schedulePoll(srv, 1000);
          return;
        }
        if (err.kind === "auth" && srv.auth.type !== "key") {
          pausedIds.add(srv.id);
          queueCardPatch(
            srv.id,
            (cur) => ({
              kind: "need_password",
              reason:
                srv.auth.type === "ask"
                  ? "每次询问模式：点击连接终端并输入本次密码"
                  : err.message && err.message !== "需要密码"
                    ? err.message
                    : undefined,
              cpuHistory: cur?.cpuHistory ?? [],
            }),
            true
          );
          return;
        }
        if (err.kind === "host_key_unknown" && err.fingerprint) {
          pausedIds.add(srv.id);
          queueCardPatch(
            srv.id,
            (cur) => ({
              kind: "error",
              message: "等待确认主机公钥指纹",
              cpuHistory: cur?.cpuHistory ?? [],
            }),
            true
          );
          onHostKeyUnknownRef.current(err.host || hostPort, err.fingerprint);
          return;
        }
        const fails = (failCounts.get(srv.id) ?? 0) + 1;
        failCounts.set(srv.id, fails);
        const friendlyMsg =
          err.message === "Disconnected"
            ? "连接被远端关闭（可能触发了限流/fail2ban 或 SSH 服务不可用）"
            : err.message;
        queueCardPatch(srv.id, (cur) => {
          // Keep online card stable across 1-2 transient network/NAT jitters
          if (cur?.kind === "online" && fails <= 2) {
            return cur;
          }
          return {
            kind: "error",
            message: friendlyMsg,
            cpuHistory: cur?.cpuHistory ?? [],
          };
        });
        const backoffMs =
          fails <= 2 ? 2500 : fails === 3 ? 6000 : fails === 4 ? 15000 : 30000;
        schedulePoll(srv, backoffMs);
      } finally {
        inFlight.delete(srv.id);
      }
    };

    pollNowRef.current = (serverId: string) => {
      const target = serversRef.current.find((s) => s.id === serverId);
      if (!target || cancelled) return;
      failCounts.delete(serverId);
      schedulePoll(target, 0);
    };

    // Stagger initial polls smoothly so large fleets don't spike simultaneously
    // Skip servers that are already paused waiting for password or host key confirmation
    let pollIdx = 0;
    currentServers.forEach((srv) => {
      if (srv.protocol && srv.protocol !== "ssh") return;
      if (pausedIds.has(srv.id)) return;
      if (pollIdx === 0) {
        void pollOne(srv);
      } else {
        schedulePoll(srv, pollIdx * 40);
      }
      pollIdx++;
    });

    return () => {
      cancelled = true;
      pollNowRef.current = null;
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      pendingPatches.clear();
      for (const tid of timers.values()) {
        window.clearTimeout(tid);
      }
      timers.clear();
    };
  }, [serversKey, visible, docVisible]);

  // Selectively retry only paused servers (e.g. after trusting host key or entering password)
  // without cancelling healthy/in-flight polls on other machines.
  useEffect(() => {
    const retry = pollNowRef.current;
    if (!retry || pausedIdsRef.current.size === 0) return;
    const ids = Array.from(pausedIdsRef.current);
    const retryTimers = ids.map((id, idx) =>
      window.setTimeout(() => retry(id), idx * 40)
    );
    return () => {
      for (const tid of retryTimers) {
        window.clearTimeout(tid);
      }
    };
  }, [acceptedHostKeys, pollTrigger]);

  const summary = useMemo(() => {
    let onlineCount = 0;
    let offlineCount = 0;
    let latSum = 0;
    let latCount = 0;
    let minLatency: number | null = null;
    let maxLatency: number | null = null;
    let cpuSum = 0;
    let cpuCount = 0;
    let totalCores = 0;
    let memUsed = 0;
    let memTotal = 0;
    let diskUsed = 0;
    let diskTotal = 0;
    let rxSum = 0;
    let txSum = 0;
    let hasNet = false;
    let diskReadSum = 0;
    let diskWriteSum = 0;
    let hasDiskIo = false;

    const groupSet = new Set<string>();
    const providerSet = new Set<string>();
    for (const srv of displayedServers) {
      if (srv.group?.trim()) groupSet.add(srv.group.trim());
      if (srv.provider?.trim()) providerSet.add(srv.provider.trim());
      const st = cards[srv.id];
      if (!st) continue;
      if (st.kind === "error" || st.kind === "need_password") {
        offlineCount++;
        continue;
      }
      if (st.kind !== "online") continue;
      onlineCount++;
      const s = st.stats;
      if (s.cores > 0) {
        totalCores += s.cores;
      }
      if (s.latencyMs !== null) {
        latSum += s.latencyMs;
        latCount++;
        minLatency = minLatency === null ? s.latencyMs : Math.min(minLatency, s.latencyMs);
        maxLatency = maxLatency === null ? s.latencyMs : Math.max(maxLatency, s.latencyMs);
      }
      if (s.cpuPercent !== null) {
        cpuSum += s.cpuPercent;
        cpuCount++;
      }
      if (s.memTotal > 0) {
        memUsed += s.memUsed;
        memTotal += s.memTotal;
      }
      if (s.diskTotal > 0) {
        diskUsed += s.diskUsed;
        diskTotal += s.diskTotal;
      }
      if (s.netRxRate !== null) {
        rxSum += s.netRxRate;
        hasNet = true;
      }
      if (s.netTxRate !== null) {
        txSum += s.netTxRate;
        hasNet = true;
      }
      if (s.diskReadRate !== null) {
        diskReadSum += s.diskReadRate;
        hasDiskIo = true;
      }
      if (s.diskWriteRate !== null) {
        diskWriteSum += s.diskWriteRate;
        hasDiskIo = true;
      }
    }

    return {
      onlineCount,
      offlineCount,
      groupCount: groupSet.size,
      providerCount: providerSet.size,
      totalCores,
      avgLatency: latCount > 0 ? latSum / latCount : null,
      minLatency,
      maxLatency,
      avgCpu: cpuCount > 0 ? cpuSum / cpuCount : null,
      memUsed,
      memTotal,
      diskUsed,
      diskTotal,
      totalRx: hasNet ? rxSum : null,
      totalTx: hasNet ? txSum : null,
      totalDiskRead: hasDiskIo ? diskReadSum : null,
      totalDiskWrite: hasDiskIo ? diskWriteSum : null,
    };
  }, [displayedServers, cards]);

  const overallCost = useMemo(
    () => summarizeOverallCost(displayedServers),
    [displayedServers]
  );

  const expiringServers = useMemo(() => {
    return displayedServers
      .map((srv) => ({
        server: srv,
        exp: getExpirationInfo(srv.expires_at),
      }))
      .filter(
        (item): item is { server: Server; exp: NonNullable<ReturnType<typeof getExpirationInfo>> } =>
          item.exp !== null && item.exp.daysLeft <= 30
      )
      .sort((a, b) => a.exp.daysLeft - b.exp.daysLeft);
  }, [displayedServers]);

  const listServers = useMemo(() => {
    let list = displayedServers;
    if (listStatusFilter !== "all") {
      list = list.filter((srv) => {
        const st = cards[srv.id];
        const isOnline = st?.kind === "online";
        const isOffline =
          st?.kind === "error" || st?.kind === "need_password";
        return listStatusFilter === "online" ? isOnline : isOffline;
      });
    }
    if (!listSort) return list;

    const { field, dir } = listSort;
    const mul = dir === "asc" ? 1 : -1;

    const getStats = (id: string) => {
      const st = cards[id];
      return st && (st.kind === "online" || st.kind === "connecting")
        ? st.stats
        : undefined;
    };

    const getMetricValue = (srv: Server): number | null => {
      const stats = getStats(srv.id);
      if (!stats) return null;
      switch (field) {
        case "cpu":
          return stats.cpuPercent;
        case "memory":
          return stats.memTotal > 0
            ? (stats.memUsed / stats.memTotal) * 100
            : null;
        case "disk":
          return stats.diskTotal > 0
            ? (stats.diskUsed / stats.diskTotal) * 100
            : null;
        case "network":
          return stats.netRxRate !== null || stats.netTxRate !== null
            ? (stats.netRxRate ?? 0) + (stats.netTxRate ?? 0)
            : null;
        case "latency":
          return stats.latencyMs;
        default:
          return null;
      }
    };

    return [...list].sort((a, b) => {
      if (field === "name") {
        return (
          a.name.localeCompare(b.name, "zh-CN", { numeric: true }) * mul
        );
      }
      const va = getMetricValue(a);
      const vb = getMetricValue(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * mul;
    });
  }, [displayedServers, cards, listStatusFilter, listSort]);

  const sshDisplayedCount = useMemo(
    () =>
      displayedServers.filter((s) => !s.protocol || s.protocol === "ssh")
        .length,
    [displayedServers]
  );
  const nonSshDisplayedCount = displayedServers.length - sshDisplayedCount;

  const hasListFilter = listStatusFilter !== "all" || listSort !== null;

  if (servers.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className={cn(CARD_CLS, "motion-modal max-w-md p-7 text-center")}>
          <BrandLogo className="mx-auto mb-5 block h-7 w-auto select-none text-card-foreground transition-colors duration-150" />
          <div className="mx-auto mb-4 inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1 text-[13px] font-medium text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            <span>无 Agent · SSH 实时监控</span>
          </div>
          <h1 className="mb-2 text-[28px] font-bold tracking-display text-card-foreground">
            欢迎使用 UService
          </h1>
          <p className="mb-6 text-[15px] leading-relaxed text-muted-foreground">
            添加你的第一台 Linux 服务器或导入 ~/.ssh/config，即可在此查看实时资源占用、延迟排行与快速开启终端。
          </p>
          <button
            type="button"
            onClick={onAddServer}
            className="motion-press inline-flex h-11 items-center gap-1.5 rounded-[12px] bg-primary px-5 text-[15px] font-semibold text-primary-foreground hover:opacity-92"
          >
            <Plus className="h-4 w-4" />
            <span>添加服务器</span>
          </button>
        </div>
      </div>
    );
  }

  const dailyCostText =
    overallCost.totals.length > 0
      ? overallCost.totals
          .map((t) => formatMoney(t.daily, t.currency))
          .join(" + ")
      : "—";

  const onlineRate =
    sshDisplayedCount > 0
      ? Math.round((summary.onlineCount / sshDisplayedCount) * 100)
      : 0;

  const costFunHint = getCostFunComparison(overallCost.totals);

  const latencyBadge =
    summary.avgLatency === null
      ? undefined
      : summary.avgLatency < 80
        ? { text: "⚡ 极快", tone: "success" as const }
        : summary.avgLatency < 200
          ? { text: "🟢 良好", tone: "success" as const }
          : summary.avgLatency < 400
            ? { text: "🟡 一般", tone: "warning" as const }
            : { text: "🔴 偏高", tone: "danger" as const };

  const cpuBadge =
    summary.avgCpu === null
      ? undefined
      : summary.avgCpu < 35
        ? { text: "😌 轻松", tone: "success" as const }
        : summary.avgCpu < 70
          ? { text: "⚙️ 适中", tone: "warning" as const }
          : { text: "🔥 繁忙", tone: "danger" as const };

  type SummaryDetailItem = {
    label: string;
    value: string;
    tone?: "default" | "success" | "warning" | "danger";
    progress?: { percent: number; colorClass: string };
  };

  const memTotalPct =
    summary.memTotal > 0 ? (summary.memUsed / summary.memTotal) * 100 : 0;
  const diskTotalPct =
    summary.diskTotal > 0 ? (summary.diskUsed / summary.diskTotal) * 100 : 0;

  const bottomStats: {
    label: string;
    value: string;
    valueSuffix?: string;
    details: SummaryDetailItem[];
    funHint?: string | null;
    badge?: { text: string; tone: "neutral" | "success" | "warning" | "danger" };
    icon: typeof ServerIcon;
    iconTone: string;
  }[] = [
    {
      label: selectedGroup === "__all__" ? "服务器总数" : "当前分组机器",
      value: `${displayedServers.length}`,
      valueSuffix: "台",
      details: [
        selectedGroup === "__all__"
          ? { label: "分组数量", value: `${summary.groupCount} 个分组` }
          : { label: "全部机器", value: `共 ${servers.length} 台` },
        expiringServers.length > 0
          ? {
              label: "到期状态",
              value: `${expiringServers.length} 台即将到期`,
              tone: "warning",
            }
          : {
              label: "到期状态",
              value: "全部正常",
              tone: "success",
            },
      ],
      badge:
        expiringServers.length > 0
          ? { text: `⏰ ${expiringServers.length} 台快到期`, tone: "warning" }
          : { text: "✅ 正常", tone: "neutral" },
      icon: ServerIcon,
      iconTone: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    },
    {
      label: "当前在线",
      value:
        sshDisplayedCount > 0
          ? `${summary.onlineCount} / ${sshDisplayedCount}`
          : `${displayedServers.length}`,
      valueSuffix: "台",
      details:
        sshDisplayedCount === 0
          ? [
              { label: "主机类型", value: `${nonSshDisplayedCount} 台 RDP/VNC` },
              { label: "监控状态", value: "不计入 SSH 探针" },
            ]
          : [
              {
                label: "在线率",
                value: `${onlineRate}%`,
                tone: summary.offlineCount > 0 ? "warning" : "success",
                progress: {
                  percent: onlineRate,
                  colorClass:
                    summary.offlineCount > 0 ? "bg-amber-500" : "bg-emerald-500",
                },
              },
              summary.offlineCount > 0
                ? {
                    label: "异常节点",
                    value: `${summary.offlineCount} 台离线${nonSshDisplayedCount > 0 ? ` · ${nonSshDisplayedCount} 桌面` : ""}`,
                    tone: "danger",
                  }
                : {
                    label: "运行状态",
                    value: `全部稳定${nonSshDisplayedCount > 0 ? ` · ${nonSshDisplayedCount} 台桌面` : ""}`,
                  },
            ],
      badge:
        sshDisplayedCount === 0
          ? { text: "🖥️ 桌面主机", tone: "neutral" }
          : summary.offlineCount > 0
            ? { text: `⚠️ ${summary.offlineCount} 离线`, tone: "danger" }
            : { text: `🟢 ${onlineRate}%`, tone: "success" },
      icon: ShieldCheck,
      iconTone:
        summary.offlineCount > 0
          ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
          : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    },
    {
      label: "平均延迟",
      value:
        summary.avgLatency !== null
          ? `${Math.round(summary.avgLatency)}`
          : "—",
      valueSuffix: summary.avgLatency !== null ? "ms" : undefined,
      details:
        summary.minLatency !== null && summary.maxLatency !== null
          ? [
              {
                label: "最低延迟",
                value: `${Math.round(summary.minLatency)} ms`,
                tone: "success",
              },
              {
                label: "最高延迟",
                value: `${Math.round(summary.maxLatency)} ms`,
                tone: summary.maxLatency >= 300 ? "warning" : "default",
              },
            ]
          : [{ label: "探测状态", value: "等待延迟探测" }],
      badge: latencyBadge,
      icon: Zap,
      iconTone: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    },
    {
      label: "集群平均负载",
      value:
        summary.avgCpu !== null
          ? `CPU ${Math.round(summary.avgCpu)}%`
          : "—",
      valueSuffix:
        summary.totalCores > 0 ? `${summary.totalCores} 核` : undefined,
      details:
        summary.memTotal > 0 || summary.diskTotal > 0
          ? [
              ...(summary.memTotal > 0
                ? [
                    {
                      label: "内存",
                      value: `${formatUsedTotal(summary.memUsed, summary.memTotal)} (${Math.round(memTotalPct)}%)`,
                      progress: {
                        percent: memTotalPct,
                        colorClass:
                          memTotalPct > 85
                            ? "bg-rose-500"
                            : memTotalPct > 65
                              ? "bg-amber-500"
                              : "bg-emerald-500",
                      },
                    } satisfies SummaryDetailItem,
                  ]
                : []),
              ...(summary.diskTotal > 0
                ? [
                    {
                      label: "磁盘",
                      value: `${formatUsedTotal(summary.diskUsed, summary.diskTotal)} (${Math.round(diskTotalPct)}%)`,
                      progress: {
                        percent: diskTotalPct,
                        colorClass:
                          diskTotalPct > 85
                            ? "bg-rose-500"
                            : diskTotalPct > 65
                              ? "bg-amber-500"
                              : "bg-sky-500",
                      },
                    } satisfies SummaryDetailItem,
                  ]
                : []),
            ]
          : [{ label: "资源状态", value: "等待采集资源数据" }],
      badge: cpuBadge,
      icon: Cpu,
      iconTone: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    },
    {
      label: "实时网络与 I/O",
      value:
        summary.totalRx !== null || summary.totalTx !== null
          ? `↓ ${formatRate(summary.totalRx)}`
          : "—",
      details: [
        {
          label: "网络上行",
          value: `↑ ${formatRate(summary.totalTx)}`,
        },
        summary.totalDiskRead !== null || summary.totalDiskWrite !== null
          ? {
              label: "磁盘读写",
              value: `R ${formatRate(summary.totalDiskRead)} · W ${formatRate(summary.totalDiskWrite)}`,
            }
          : {
              label: "磁盘读写",
              value: "等待采集 I/O",
            },
      ],
      badge: { text: "📡 实时", tone: "neutral" },
      icon: ArrowDownUp,
      iconTone: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
    },
    {
      label:
        overallCost.configuredCount > 0
          ? `整体成本 (${overallCost.configuredCount}/${displayedServers.length})`
          : "整体成本",
      value: dailyCostText,
      valueSuffix: overallCost.totals.length > 0 ? "/ 天" : undefined,
      details:
        overallCost.totals.length > 0
          ? [
              {
                label: "月均支出",
                value: overallCost.totals
                  .map((t) => formatMoney(t.monthly, t.currency))
                  .join(" + "),
              },
              {
                label: "年均支出",
                value: overallCost.totals
                  .map((t) => formatMoney(t.annual, t.currency))
                  .join(" + "),
              },
            ]
          : [{ label: "账单统计", value: "未设置服务器成本" }],
      funHint: costFunHint,
      badge:
        overallCost.configuredCount > 0
          ? { text: "💸 烧钱中", tone: "neutral" }
          : { text: "💡 待配置", tone: "neutral" },
      icon: Wallet,
      iconTone: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="motion-stagger mx-auto flex max-w-7xl flex-col gap-6 px-5 py-6">
        {/* Hero Header + Group Switcher */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <h1 className="text-[28px] font-bold tracking-display text-foreground">
            服务器概览
          </h1>
          {onSelectGroup && (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => onSelectGroup("__all__")}
                className={cn(
                  "motion-press inline-flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-[12.5px] font-medium",
                  selectedGroup === "__all__"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                )}
              >
                <span>全部</span>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.2 text-[11px] tabular-nums transition-colors duration-150",
                    selectedGroup === "__all__"
                      ? "bg-primary-foreground/20 text-primary-foreground"
                      : "bg-background/60 text-muted-foreground"
                  )}
                >
                  {servers.length}
                </span>
              </button>
              {recentCount > 0 && (
                <button
                  type="button"
                  onClick={() => onSelectGroup("__recent__")}
                  className={cn(
                    "motion-press inline-flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-[12.5px] font-medium",
                    selectedGroup === "__recent__"
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                  )}
                >
                  <span>最近</span>
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.2 text-[11px] tabular-nums transition-colors duration-150",
                      selectedGroup === "__recent__"
                        ? "bg-primary-foreground/20 text-primary-foreground"
                        : "bg-background/60 text-muted-foreground"
                    )}
                  >
                    {recentCount}
                  </span>
                </button>
              )}
              {groups.map((g) => {
                const active = selectedGroup === g;
                const count = groupCounts.counts.get(g) ?? 0;
                return (
                  <button
                    key={g}
                    type="button"
                    onClick={() => onSelectGroup(g)}
                    className={cn(
                      "motion-press inline-flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-[12.5px] font-medium",
                      active
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                    )}
                  >
                    <span>{g}</span>
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.2 text-[11px] tabular-nums transition-colors duration-150",
                        active
                          ? "bg-primary-foreground/20 text-primary-foreground"
                          : "bg-background/60 text-muted-foreground"
                      )}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
              {groupCounts.ungrouped > 0 && (
                <button
                  type="button"
                  onClick={() => onSelectGroup("__ungrouped__")}
                  className={cn(
                    "motion-press inline-flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-[12.5px] font-medium",
                    selectedGroup === "__ungrouped__"
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                  )}
                >
                  <span>未分组</span>
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.2 text-[11px] tabular-nums transition-colors duration-150",
                      selectedGroup === "__ungrouped__"
                        ? "bg-primary-foreground/20 text-primary-foreground"
                        : "bg-background/60 text-muted-foreground"
                    )}
                  >
                    {groupCounts.ungrouped}
                  </span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Expiration Reminder Banner */}
        {!expiryDismissed && expiringServers.length > 0 && (
          <div className="motion-banner-enter flex items-center justify-between gap-3 rounded-[18px] border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px]">
            <div className="flex min-w-0 items-center gap-3">
              <BellRing className="motion-bell-ring h-7 w-7 shrink-0 text-amber-500" />
              <div className="min-w-0 space-y-1">
                <div className="font-semibold text-foreground">
                  到期提醒：有 {expiringServers.length} 台服务器已过期或即将在 30 天内到期
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {expiringServers.map(({ server, exp }) => (
                    <button
                      key={server.id}
                      type="button"
                      onClick={() => onEditServer?.(server)}
                      title={`点击编辑 ${server.name}（到期日 ${exp.dateStr}）`}
                      className={cn(
                        "motion-press inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11.5px] font-medium hover:opacity-80",
                        exp.level === "expired" || exp.level === "urgent"
                          ? "bg-red-500/15 text-red-500"
                          : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                      )}
                    >
                      <span>{server.name}</span>
                      <span>·</span>
                      <span>{exp.dateStr}</span>
                      <span>({exp.label})</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setExpiryDismissed(true)}
              title="本次忽略提醒"
              className="motion-press shrink-0 rounded-md p-1 opacity-60 hover:bg-muted hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Bottom Stats */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {bottomStats.map((stat, idx) => {
            const Icon = stat.icon;
            const badgeToneClass =
              stat.badge?.tone === "success"
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : stat.badge?.tone === "warning"
                  ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  : stat.badge?.tone === "danger"
                    ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                    : "bg-muted text-muted-foreground";
            return (
              <div
                key={stat.label}
                className={cn(
                  CARD_CLS,
                  "motion-card-enter motion-card-hover flex flex-col justify-between p-4"
                )}
                style={{ "--stagger-index": idx } as CSSProperties}
              >
                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div
                      className={cn(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                        stat.iconTone
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </div>
                    {stat.badge && (
                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium tabular-nums",
                          badgeToneClass
                        )}
                      >
                        {stat.badge.text}
                      </span>
                    )}
                  </div>
                  <p className="text-[12.5px] font-medium text-muted-foreground">
                    {stat.label}
                  </p>
                  <div className="mt-1 flex items-baseline gap-1.5">
                    <p className="truncate text-xl font-bold tracking-tight tabular-nums text-card-foreground">
                      {stat.value}
                    </p>
                    {stat.valueSuffix && (
                      <span className="shrink-0 text-[11.5px] font-medium tabular-nums text-muted-foreground">
                        {stat.valueSuffix}
                      </span>
                    )}
                  </div>
                </div>

                <div className="mt-3 flex flex-col gap-1.5 border-t-[0.5px] border-border/70 pt-2.5">
                  {stat.details.map((item) => {
                    const valueToneClass =
                      item.tone === "success"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : item.tone === "warning"
                          ? "text-amber-600 dark:text-amber-400"
                          : item.tone === "danger"
                            ? "text-rose-600 dark:text-rose-400"
                            : "text-card-foreground";
                    return (
                      <div key={item.label} className="min-w-0">
                        <div className="flex items-center justify-between gap-2 text-[11px] leading-snug">
                          <span className="shrink-0 text-muted-foreground">
                            {item.label}
                          </span>
                          <span
                            className={cn(
                              "truncate font-medium tabular-nums",
                              valueToneClass
                            )}
                            title={item.value}
                          >
                            {item.value}
                          </span>
                        </div>
                        {item.progress && (
                          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className={cn(
                                "h-full rounded-full transition-[width,background-color] duration-500 [transition-timing-function:var(--ease-decelerate)]",
                                item.progress.colorClass
                              )}
                              style={{
                                width: `${Math.max(0, Math.min(100, item.progress.percent))}%`,
                              }}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {stat.funHint && (
                    <p
                      className="mt-0.5 inline-flex w-fit max-w-full items-center truncate rounded-full bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-medium text-amber-600 dark:text-amber-400"
                      title={stat.funHint}
                    >
                      {stat.funHint}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Grouped Servers Detail Grid / List */}
        <div>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-[17px] font-semibold tracking-tight text-foreground">
              {activeGroupLabel}
              <span className="ml-2 text-[13px] font-normal tracking-normal tabular-nums text-muted-foreground">
                ({displayedServers.length})
              </span>
            </h2>
            <div
              role="group"
              aria-label="视图切换"
              className="relative grid grid-cols-2 rounded-[10px] bg-muted p-0.5"
            >
              <div
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0.5 left-0.5 top-0.5 w-[calc((100%-4px)/2)] rounded-[8px] bg-card shadow-[0_2px_6px_rgb(0_0_0/.08)] transition-transform duration-300 [transition-timing-function:var(--ease-apple)]"
                style={{
                  transform: `translateX(${viewMode === "card" ? 0 : 100}%)`,
                }}
              />
              <button
                type="button"
                onClick={() => handleViewModeChange("card")}
                aria-pressed={viewMode === "card"}
                title="卡片视图"
                className={cn(
                  "relative z-10 inline-flex items-center justify-center gap-1.5 rounded-[8px] px-2.5 py-1 text-[12px] font-medium transition-colors duration-150",
                  viewMode === "card"
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                <span>卡片</span>
              </button>
              <button
                type="button"
                onClick={() => handleViewModeChange("list")}
                aria-pressed={viewMode === "list"}
                title="列表视图"
                className={cn(
                  "relative z-10 inline-flex items-center justify-center gap-1.5 rounded-[8px] px-2.5 py-1 text-[12px] font-medium transition-colors duration-150",
                  viewMode === "list"
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <List className="h-3.5 w-3.5" />
                <span>列表</span>
              </button>
            </div>
          </div>
          {displayedServers.length === 0 ? (
            <div className={cn(CARD_CLS, "motion-card-enter flex flex-col items-center justify-center gap-3 py-12 text-center")}>
              <p className="text-[14px] text-muted-foreground">
                {selectedGroup === "__recent__"
                  ? "暂无最近连接记录"
                  : `分组「${activeGroupLabel}」暂无服务器`}
              </p>
              {onSelectGroup && selectedGroup !== "__all__" && (
                <button
                  type="button"
                  onClick={() => onSelectGroup("__all__")}
                  className="motion-press rounded-[10px] bg-muted px-3.5 py-1.5 text-[13px] font-medium text-foreground hover:bg-foreground/10"
                >
                  查看全部服务器
                </button>
              )}
            </div>
          ) : viewMode === "card" ? (
          <div
            key={`${selectedGroup}-card`}
            className="grid grid-cols-1 gap-3 min-[820px]:grid-cols-2 xl:grid-cols-3"
          >
            {displayedServers.map((srv, idx) => {
              const state = cards[srv.id] ?? {
                kind: "connecting" as const,
                cpuHistory: [],
              };
              const stats =
                state.kind === "online" || state.kind === "connecting"
                  ? state.stats
                  : undefined;

              const isNonSsh = Boolean(srv.protocol && srv.protocol !== "ssh");
              const statusDot = isNonSsh
                ? "bg-sky-500/60"
                : getStatusDot(state.kind);
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
                  className={cn(
                    CARD_CLS,
                    "@container group/card motion-card-enter motion-card-hover relative flex flex-col justify-between rounded-[18px] p-3 hover:z-20 focus-within:z-20 @[310px]:p-3.5"
                  )}
                  style={
                    {
                      backgroundImage: getProviderCardGradient(srv),
                      "--stagger-index": idx,
                    } as CSSProperties
                  }
                >
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 overflow-hidden rounded-[18px]"
                  >
                    <div className="absolute -right-4 -top-4 opacity-[0.08] select-none transition-opacity duration-300 [transition-timing-function:var(--ease-decelerate)] group-hover/card:opacity-[0.12]">
                      <ProviderIcon server={srv} className="h-28 w-28" />
                    </div>
                  </div>
                  <div className="relative z-10 flex flex-1 flex-col">
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              "h-2 w-2 shrink-0 rounded-full",
                              statusDot
                            )}
                          />
                          <ProviderIcon server={srv} />
                          <RegionBadge server={srv} />
                          <span className="truncate text-[14px] font-semibold text-card-foreground">
                            {srv.name}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleCopyEndpoint(srv)}
                          title="点击复制完整连接地址"
                          className="group/addr mt-0.5 flex w-full items-center justify-between gap-1.5 rounded-[6px] px-1 -mx-1 py-0 font-mono text-[11.5px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
                        >
                          <span className="truncate">
                            {srv.username ? `${srv.username}@` : ""}
                            {hideIp ? maskHost(srv.host) : srv.host}:{srv.port}
                          </span>
                          {copiedEndpointId === srv.id ? (
                            <span className="motion-pop inline-flex shrink-0 items-center gap-0.5 text-[10.5px] font-sans font-medium text-emerald-500">
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
                          title="权威网络延迟（ICMP / SSH 端到端往返）"
                          className={cn(
                            "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium tabular-nums",
                            latencyClass
                          )}
                        >
                          <Wifi className="h-3 w-3" />
                          <span>{Math.round(latency)} ms</span>
                        </span>
                      )}
                    </div>

                    {srv.protocol && srv.protocol !== "ssh" ? (
                      <div className="flex flex-1 items-center justify-center py-5 text-center text-[12.5px] text-muted-foreground">
                        {srv.protocol.toUpperCase()} 协议暂不支持 SSH 系统指标采集
                      </div>
                    ) : state.kind === "need_password" ? (
                      <div className="my-3 flex flex-col items-center gap-2 text-center">
                        <p className="text-[12.5px] text-muted-foreground">
                          {state.reason ?? "需要登录密码以采集状态"}
                        </p>
                        <button
                          type="button"
                          onClick={() => onNeedPassword(srv)}
                          className="inline-flex h-8 items-center gap-1.5 rounded-[9px] bg-muted px-3 text-[12.5px] font-medium text-foreground transition active:scale-[.97]"
                        >
                          <KeyRound className="h-3.5 w-3.5 text-primary" />
                          <span>输入密码开始监控</span>
                        </button>
                      </div>
                    ) : state.kind === "error" && !stats ? (
                      <div className="my-2.5 flex flex-col gap-1.5 rounded-[10px] bg-destructive/10 p-2.5 text-[12.5px] text-destructive">
                        <div className="break-words">{state.message}</div>
                        <button
                          type="button"
                          onClick={() => pollNowRef.current?.(srv.id)}
                          className="self-start rounded-[7px] bg-destructive/15 px-2 py-0.5 text-[11.5px] font-medium text-destructive transition hover:bg-destructive/25"
                        >
                          立即重试
                        </button>
                      </div>
                    ) : stats ? (
                      <div className="motion-view-enter text-[12.5px]">
                        <div className="flex flex-col gap-2 py-0.5 @[310px]:flex-row @[310px]:items-stretch @[310px]:justify-between @[310px]:gap-2.5">
                          {/* Left: 3 Ring Charts (CPU / Mem / Disk) + Load/Uptime */}
                          <div className="flex shrink-0 flex-col justify-between gap-1.5">
                            <div className="grid grid-cols-3 justify-items-center gap-1.5 @[310px]:gap-2">
                              {(() => {
                              const cpuVal = stats.cpuPercent ?? 0;
                              const cpuColor =
                                cpuVal > 85
                                  ? "text-red-500"
                                  : cpuVal > 65
                                    ? "text-amber-500"
                                    : "text-primary";
                              const memColor =
                                memPct > 85
                                  ? "text-red-500"
                                  : memPct > 65
                                    ? "text-amber-500"
                                    : "text-emerald-500";
                              const diskColor =
                                diskPct > 85
                                  ? "text-red-500"
                                  : diskPct > 65
                                    ? "text-amber-500"
                                    : "text-sky-500";

                              return (
                                <>
                                  <RingChart
                                    percent={cpuVal}
                                    colorClass={cpuColor}
                                    centerText={
                                      stats.cpuPercent !== null
                                        ? `${Math.round(cpuVal)}%`
                                        : "—"
                                    }
                                    label="CPU"
                                    subLabel={`${stats.cores}核`}
                                  />
                                  <RingChart
                                    percent={memPct}
                                    colorClass={memColor}
                                    centerText={`${Math.round(memPct)}%`}
                                    label="内存"
                                    subLabel={formatUsedTotal(stats.memUsed, stats.memTotal)}
                                  />
                                  <RingChart
                                    percent={diskPct}
                                    colorClass={diskColor}
                                    centerText={`${Math.round(diskPct)}%`}
                                    label="磁盘"
                                    subLabel={formatUsedTotal(stats.diskUsed, stats.diskTotal)}
                                  />
                                </>
                              );
                            })()}
                            </div>
                            <div className="flex items-center justify-between border-t-[0.5px] border-border pt-1.5 text-[11px] leading-none text-muted-foreground">
                              <span className="tabular-nums">
                                已运行 {formatUptime(stats.uptimeSecs)}
                              </span>
                            </div>
                          </div>

                          {/* Right: Real-time NET & IO */}
                          <div className="grid min-w-0 flex-1 grid-cols-2 gap-1.5 rounded-[10px] bg-muted/60 px-2 py-1.5 @[310px]:flex @[310px]:flex-col @[310px]:justify-between">
                            <div>
                              <div className="text-[10px] font-semibold leading-tight tracking-wide text-muted-foreground uppercase">
                                NET
                              </div>
                              <div className="mt-0.5 space-y-0 font-mono text-[10.5px] leading-[1.35] tabular-nums">
                                <div className="flex items-center justify-between gap-1">
                                  <span className="text-emerald-500">↓</span>
                                  <span className="truncate text-card-foreground">
                                    {formatRate(stats.netRxRate)}
                                  </span>
                                </div>
                                <div className="flex items-center justify-between gap-1">
                                  <span className="text-primary">↑</span>
                                  <span className="truncate text-card-foreground">
                                    {formatRate(stats.netTxRate)}
                                  </span>
                                </div>
                              </div>
                            </div>

                            <div className="border-l-[0.5px] border-border pl-2 @[310px]:border-l-0 @[310px]:border-t-[0.5px] @[310px]:pl-0 @[310px]:pt-1">
                              <div className="text-[10px] font-semibold leading-tight tracking-wide text-muted-foreground uppercase">
                                IO
                              </div>
                              <div className="mt-0.5 space-y-0 font-mono text-[10.5px] leading-[1.35] tabular-nums">
                                <div className="flex items-center justify-between gap-1">
                                  <span className="text-sky-500">R</span>
                                  <span className="truncate text-card-foreground">
                                    {formatRate(stats.diskReadRate)}
                                  </span>
                                </div>
                                <div className="flex items-center justify-between gap-1">
                                  <span className="text-amber-500">W</span>
                                  <span className="truncate text-card-foreground">
                                    {formatRate(stats.diskWriteRate)}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2 py-0.5 @[310px]:flex-row @[310px]:items-stretch @[310px]:justify-between @[310px]:gap-2.5" aria-label="正在采集系统指标">
                        <div className="flex shrink-0 flex-col justify-between gap-1.5">
                          <div className="grid grid-cols-3 justify-items-center gap-1.5 @[310px]:gap-2">
                            {[0, 1, 2].map((i) => (
                              <div key={i} className="flex w-[54px] flex-col items-center">
                                <div className="motion-shimmer h-[46px] w-[46px] rounded-full" />
                                <div className="motion-shimmer mt-1 h-2 w-7 rounded-full" />
                                <div className="motion-shimmer mt-0.5 h-2 w-9 rounded-full" />
                              </div>
                            ))}
                          </div>
                          <div className="border-t-[0.5px] border-border pt-1.5">
                            <div className="motion-shimmer h-2.5 w-20 rounded-full" />
                          </div>
                        </div>
                        <div className="grid min-w-0 flex-1 grid-cols-2 gap-1.5 rounded-[10px] bg-muted/50 px-2 py-1.5 @[310px]:flex @[310px]:flex-col @[310px]:justify-between">
                          <div className="space-y-1">
                            <div className="motion-shimmer h-2 w-7 rounded-full" />
                            <div className="motion-shimmer h-2.5 w-full rounded-md" />
                            <div className="motion-shimmer h-2.5 w-4/5 rounded-md" />
                          </div>
                          <div className="space-y-1 border-l-[0.5px] border-border pl-2 @[310px]:border-l-0 @[310px]:border-t-[0.5px] @[310px]:pl-0 @[310px]:pt-1">
                            <div className="motion-shimmer h-2 w-5 rounded-full" />
                            <div className="motion-shimmer h-2.5 w-full rounded-md" />
                            <div className="motion-shimmer h-2.5 w-3/4 rounded-md" />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="relative z-10 mt-2.5 flex flex-col gap-1.5 border-t-[0.5px] border-border/70 pt-2">
                    {(() => {
                      const exp = getExpirationInfo(srv.expires_at);
                      const hasCost = srv.cost && srv.cost.amount > 0;
                      if (!hasCost && !exp) return null;

                      const daily = hasCost ? calcDailyCost(srv.cost!) : 0;
                      const cycleLabel = hasCost
                        ? getBillingCycleMeta(srv.cost!.cycle).label
                        : "";
                      return (
                        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11.5px] tabular-nums">
                          {hasCost && (
                            <div
                              className="min-w-0 truncate"
                              title={`${cycleLabel} ${formatMoney(srv.cost!.amount, srv.cost!.currency)} · 月均 ${formatMoney(daily * 30, srv.cost!.currency)} · 年均 ${formatMoney(daily * 365, srv.cost!.currency)}`}
                            >
                              <span className="font-semibold text-card-foreground">
                                {formatMoney(daily, srv.cost!.currency)}/天
                              </span>
                              <span className="ml-1 text-muted-foreground">
                                ({formatCycleCost(srv.cost!)})
                              </span>
                            </div>
                          )}
                          {exp && (
                            <span
                              title={`到期时间：${exp.dateStr}`}
                              className={cn(
                                "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium leading-none",
                                exp.level === "expired" || exp.level === "urgent"
                                  ? "bg-red-500/15 text-red-500"
                                  : exp.level === "soon"
                                    ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                                    : "bg-muted text-muted-foreground"
                              )}
                            >
                              <Clock className="h-3 w-3" />
                              <span>{exp.label}</span>
                            </span>
                          )}
                        </div>
                      );
                    })()}
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => onEditServer?.(srv)}
                        className="motion-press inline-flex h-[30px] items-center gap-1 rounded-[8px] bg-muted px-2.5 text-[12px] font-medium text-foreground hover:bg-foreground/10"
                      >
                        <Pencil className="h-3 w-3 text-muted-foreground" />
                        <span>编辑</span>
                      </button>
                      <ServerMoreMenu
                        server={srv}
                        compact
                        onOpenConcurrent={onOpenTerminal}
                        onDuplicate={(s) => onDuplicateServer?.(s)}
                        onDelete={(s) => onDeleteServer?.(s)}
                      />
                      <button
                        type="button"
                        onClick={() => onOpenTerminal(srv)}
                        className="motion-press inline-flex h-[30px] items-center gap-1 rounded-[8px] bg-primary/10 px-3 text-[12px] font-semibold text-primary hover:bg-primary/18"
                      >
                        <TerminalIcon className="h-3 w-3" />
                        <span>连接</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          ) : (
            <div
              key={`${selectedGroup}-list`}
              className="motion-card-enter divide-y divide-border/60 rounded-[22px] bg-card shadow-[0_0_0_0.5px_var(--color-border),0_8px_24px_rgb(0_0_0/0.04)]"
            >
              {/* Compact sort/filter bar for viewports < lg */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-t-[22px] bg-muted/40 px-4 py-2 text-[11.5px] font-medium text-muted-foreground lg:hidden">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleCycleStatusFilter}
                    title="筛选状态（点击切换：全部 / 仅在线 / 仅异常）"
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] leading-none transition-colors",
                      listStatusFilter === "online"
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : listStatusFilter === "offline"
                          ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                          : "bg-background/70 text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        listStatusFilter === "online"
                          ? "bg-emerald-500"
                          : listStatusFilter === "offline"
                            ? "bg-rose-500"
                            : "bg-muted-foreground/50"
                      )}
                    />
                    <span>
                      {listStatusFilter === "online"
                        ? "仅在线"
                        : listStatusFilter === "offline"
                          ? "仅异常"
                          : "全部状态"}
                    </span>
                  </button>
                  {(
                    [
                      { field: "name" as const, label: "名称" },
                      { field: "cpu" as const, label: "CPU" },
                      { field: "memory" as const, label: "内存" },
                      { field: "disk" as const, label: "磁盘" },
                      { field: "latency" as const, label: "延迟" },
                    ]
                  ).map((item) => {
                    const active = listSort?.field === item.field;
                    return (
                      <button
                        key={item.field}
                        type="button"
                        onClick={() => handleToggleListSort(item.field)}
                        className={cn(
                          "inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground",
                          active && "bg-primary/10 text-primary"
                        )}
                      >
                        <span>{item.label}</span>
                        {active &&
                          (listSort.dir === "asc" ? (
                            <ArrowUp className="h-3 w-3 shrink-0" />
                          ) : (
                            <ArrowDown className="h-3 w-3 shrink-0" />
                          ))}
                      </button>
                    );
                  })}
                </div>
                {(listSort !== null || listStatusFilter !== "all") && (
                  <button
                    type="button"
                    onClick={() => {
                      setListSort(null);
                      setListStatusFilter("all");
                    }}
                    className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-primary transition-colors hover:bg-primary/10"
                  >
                    <X className="h-3 w-3 shrink-0" />
                    <span>重置</span>
                  </button>
                )}
              </div>
              <div className="hidden rounded-t-[22px] bg-muted/40 px-4 py-2.5 text-[11.5px] font-medium text-muted-foreground lg:grid lg:grid-cols-[minmax(190px,1.4fr)_minmax(220px,1.5fr)_minmax(96px,0.65fr)_74px_auto] lg:items-center lg:gap-3">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleToggleListSort("name")}
                    title="按服务器名称排序"
                    className={cn(
                      "inline-flex items-center gap-0.5 rounded px-1 -mx-1 -my-0.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground",
                      listSort?.field === "name" && "text-primary"
                    )}
                  >
                    <span>服务器</span>
                    {listSort?.field === "name" ? (
                      listSort.dir === "asc" ? (
                        <ArrowUp className="h-3 w-3 shrink-0" />
                      ) : (
                        <ArrowDown className="h-3 w-3 shrink-0" />
                      )
                    ) : (
                      <ArrowDownUp className="h-3 w-3 shrink-0 opacity-40" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={handleCycleStatusFilter}
                    title="筛选状态（点击切换：全部 / 仅在线 / 仅异常）"
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-1.5 -my-0.5 py-0.5 text-[10.5px] leading-none transition-colors",
                      listStatusFilter === "online"
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : listStatusFilter === "offline"
                          ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                          : "bg-background/60 text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        listStatusFilter === "online"
                          ? "bg-emerald-500"
                          : listStatusFilter === "offline"
                            ? "bg-rose-500"
                            : "bg-muted-foreground/50"
                      )}
                    />
                    <span>
                      {listStatusFilter === "online"
                        ? "在线"
                        : listStatusFilter === "offline"
                          ? "异常"
                          : "状态"}
                    </span>
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  {(
                    [
                      { field: "cpu" as const, label: "CPU" },
                      { field: "memory" as const, label: "内存" },
                      { field: "disk" as const, label: "磁盘" },
                    ]
                  ).map((item, i) => {
                    const active = listSort?.field === item.field;
                    return (
                      <span key={item.field} className="inline-flex items-center gap-1">
                        {i > 0 && <span className="opacity-40">/</span>}
                        <button
                          type="button"
                          onClick={() => handleToggleListSort(item.field)}
                          title={`按${item.label}占用排序`}
                          className={cn(
                            "inline-flex items-center gap-0.5 rounded px-1 -my-0.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground",
                            i === 0 && "-ml-1",
                            active && "text-primary"
                          )}
                        >
                          <span>{item.label}</span>
                          {active ? (
                            listSort.dir === "asc" ? (
                              <ArrowUp className="h-3 w-3 shrink-0" />
                            ) : (
                              <ArrowDown className="h-3 w-3 shrink-0" />
                            )
                          ) : (
                            <ArrowDownUp className="h-3 w-3 shrink-0 opacity-40" />
                          )}
                        </button>
                      </span>
                    );
                  })}
                </div>
                <div>
                  <button
                    type="button"
                    onClick={() => handleToggleListSort("network")}
                    title="按实时网络总吞吐排序"
                    className={cn(
                      "inline-flex items-center gap-0.5 rounded px-1 -mx-1 -my-0.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground",
                      listSort?.field === "network" && "text-primary"
                    )}
                  >
                    <span>网络吞吐</span>
                    {listSort?.field === "network" ? (
                      listSort.dir === "asc" ? (
                        <ArrowUp className="h-3 w-3 shrink-0" />
                      ) : (
                        <ArrowDown className="h-3 w-3 shrink-0" />
                      )
                    ) : (
                      <ArrowDownUp className="h-3 w-3 shrink-0 opacity-40" />
                    )}
                  </button>
                </div>
                <div>
                  <button
                    type="button"
                    onClick={() => handleToggleListSort("latency")}
                    title="按网络延迟排序"
                    className={cn(
                      "inline-flex items-center gap-0.5 rounded px-1 -mx-1 -my-0.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground",
                      listSort?.field === "latency" && "text-primary"
                    )}
                  >
                    <span>延迟</span>
                    {listSort?.field === "latency" ? (
                      listSort.dir === "asc" ? (
                        <ArrowUp className="h-3 w-3 shrink-0" />
                      ) : (
                        <ArrowDown className="h-3 w-3 shrink-0" />
                      )
                    ) : (
                      <ArrowDownUp className="h-3 w-3 shrink-0 opacity-40" />
                    )}
                  </button>
                </div>
                <div className="relative flex items-center justify-end text-right">
                  {hasListFilter && (
                    <button
                      type="button"
                      onClick={() => {
                        setListSort(null);
                        setListStatusFilter("all");
                      }}
                      title="重置排序与状态筛选"
                      className="absolute right-8 inline-flex items-center gap-0.5 whitespace-nowrap rounded px-1 -my-0.5 py-0.5 text-[10.5px] text-primary transition-colors hover:bg-primary/10"
                    >
                      <X className="h-2.5 w-2.5 shrink-0" />
                      <span>重置</span>
                    </button>
                  )}
                  <span>操作</span>
                </div>
              </div>
              {listServers.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-[13px] text-muted-foreground">
                  <span>
                    没有符合当前筛选条件（
                    {listStatusFilter === "online" ? "仅在线" : "仅异常"}
                    ）的服务器
                  </span>
                  <button
                    type="button"
                    onClick={() => setListStatusFilter("all")}
                    className="motion-press rounded-[8px] bg-muted px-3 py-1 text-[12px] font-medium text-foreground hover:bg-foreground/10"
                  >
                    清除状态筛选
                  </button>
                </div>
              ) : (
              listServers.map((srv, idx) => {
                const state = cards[srv.id] ?? {
                  kind: "connecting" as const,
                  cpuHistory: [],
                };
                const stats =
                  state.kind === "online" || state.kind === "connecting"
                    ? state.stats
                    : undefined;

                const isNonSsh = Boolean(
                  srv.protocol && srv.protocol !== "ssh"
                );
                const statusDot = isNonSsh
                  ? "bg-sky-500/60"
                  : getStatusDot(state.kind);
                const latency = stats?.latencyMs;
                const latencyClass =
                  latency == null
                    ? "text-muted-foreground"
                    : latency < 80
                      ? "bg-emerald-500/15 text-emerald-500"
                      : latency < 200
                        ? "bg-amber-500/15 text-amber-500"
                        : "bg-red-500/15 text-red-500";

                const cpuVal = stats?.cpuPercent ?? 0;
                const memPct =
                  stats && stats.memTotal > 0
                    ? (stats.memUsed / stats.memTotal) * 100
                    : 0;
                const diskPct =
                  stats && stats.diskTotal > 0
                    ? (stats.diskUsed / stats.diskTotal) * 100
                    : 0;

                const cpuBarColor =
                  cpuVal > 85
                    ? "bg-red-500"
                    : cpuVal > 65
                      ? "bg-amber-500"
                      : "bg-primary";
                const memBarColor =
                  memPct > 85
                    ? "bg-red-500"
                    : memPct > 65
                      ? "bg-amber-500"
                      : "bg-emerald-500";
                const diskBarColor =
                  diskPct > 85
                    ? "bg-red-500"
                    : diskPct > 65
                      ? "bg-amber-500"
                      : "bg-sky-500";

                const isLast = idx === listServers.length - 1;

                return (
                  <div
                    key={srv.id}
                    className={cn(
                      "motion-card-enter flex flex-col gap-3 px-4 py-3 transition-colors duration-150 hover:bg-muted/35 lg:grid lg:grid-cols-[minmax(190px,1.4fr)_minmax(220px,1.5fr)_minmax(96px,0.65fr)_74px_auto] lg:items-center lg:gap-3",
                      isLast && "rounded-b-[22px]"
                    )}
                    style={{ "--stagger-index": idx } as CSSProperties}
                  >
                    {/* Col 1: Server identity + endpoint */}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "h-2 w-2 shrink-0 rounded-full",
                            statusDot
                          )}
                        />
                        <ProviderIcon server={srv} />
                        <span className="truncate text-[14px] font-semibold text-card-foreground">
                          {srv.name}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleCopyEndpoint(srv)}
                          title="点击复制完整连接地址"
                          className="group/addr -mx-1 inline-flex min-w-0 items-center gap-1 rounded-[6px] px-1 py-0.5 font-mono text-[11.5px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
                        >
                          <span className="truncate">
                            {srv.username ? `${srv.username}@` : ""}
                            {hideIp ? maskHost(srv.host) : srv.host}:{srv.port}
                          </span>
                          {copiedEndpointId === srv.id ? (
                            <span className="inline-flex shrink-0 items-center gap-0.5 font-sans text-[10.5px] font-medium text-emerald-500">
                              <Check className="h-3 w-3" />
                              已复制
                            </span>
                          ) : (
                            <Copy className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/addr:opacity-100" />
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Col 2: Resource bars or status */}
                    <div className="min-w-0">
                      {srv.protocol && srv.protocol !== "ssh" ? (
                        <span className="text-[12px] text-muted-foreground">
                          {srv.protocol.toUpperCase()} 协议暂不支持 SSH 指标采集
                        </span>
                      ) : state.kind === "need_password" ? (
                        <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                          <span className="truncate">
                            {state.reason ?? "需要登录密码以采集状态"}
                          </span>
                          <button
                            type="button"
                            onClick={() => onNeedPassword(srv)}
                            className="motion-press inline-flex h-7 shrink-0 items-center gap-1 rounded-[8px] bg-muted px-2.5 text-[11.5px] font-medium text-foreground hover:bg-foreground/10"
                          >
                            <KeyRound className="h-3 w-3 text-primary" />
                            <span>输入密码</span>
                          </button>
                        </div>
                      ) : state.kind === "error" && !stats ? (
                        <div className="flex items-center gap-2 text-[12px] text-destructive">
                          <span className="truncate" title={state.message}>
                            {state.message}
                          </span>
                          <button
                            type="button"
                            onClick={() => pollNowRef.current?.(srv.id)}
                            className="shrink-0 rounded-[8px] bg-destructive/15 px-2 py-0.5 text-[11.5px] font-medium text-destructive transition hover:bg-destructive/25"
                          >
                            重试
                          </button>
                        </div>
                      ) : stats ? (
                        <div className="grid grid-cols-3 gap-2.5">
                          <MiniBar
                            label="CPU"
                            percent={cpuVal}
                            valueText={
                              stats.cpuPercent !== null
                                ? `${Math.round(cpuVal)}%`
                                : "—"
                            }
                            subLabel={`${stats.cores}核`}
                            barColorClass={cpuBarColor}
                          />
                          <MiniBar
                            label="内存"
                            percent={memPct}
                            valueText={`${Math.round(memPct)}%`}
                            subLabel={formatUsedTotal(
                              stats.memUsed,
                              stats.memTotal
                            )}
                            barColorClass={memBarColor}
                          />
                          <MiniBar
                            label="磁盘"
                            percent={diskPct}
                            valueText={`${Math.round(diskPct)}%`}
                            subLabel={formatUsedTotal(
                              stats.diskUsed,
                              stats.diskTotal
                            )}
                            barColorClass={diskBarColor}
                          />
                        </div>
                      ) : (
                        <span className="text-[12px] text-muted-foreground">
                          正在采集系统指标…
                        </span>
                      )}
                    </div>

                    {/* Col 3: Network throughput */}
                    <div
                      className="flex items-center gap-3 font-mono text-[11px] tabular-nums lg:flex-col lg:items-start lg:gap-0.5"
                      title={
                        stats
                          ? `已运行 ${formatUptime(stats.uptimeSecs)} · 磁盘 I/O R ${formatRate(stats.diskReadRate)} / W ${formatRate(stats.diskWriteRate)}`
                          : undefined
                      }
                    >
                      {stats ? (
                        <>
                          <div className="flex items-center gap-1 text-card-foreground">
                            <span className="text-emerald-500">↓</span>
                            <span className="truncate">
                              {formatRate(stats.netRxRate)}
                            </span>
                          </div>
                          <div className="flex items-center gap-1 text-card-foreground">
                            <span className="text-primary">↑</span>
                            <span className="truncate">
                              {formatRate(stats.netTxRate)}
                            </span>
                          </div>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>

                    {/* Col 4: Latency */}
                    <div className="flex items-center">
                      {latency != null ? (
                        <span
                          title="权威网络延迟（ICMP / SSH 端到端往返）"
                          className={cn(
                            "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums",
                            latencyClass
                          )}
                        >
                          <Wifi className="h-3 w-3" />
                          <span>{Math.round(latency)} ms</span>
                        </span>
                      ) : (
                        <span className="text-[12px] text-muted-foreground">
                          —
                        </span>
                      )}
                    </div>

                    {/* Col 5: Actions */}
                    <div className="flex shrink-0 items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => onEditServer?.(srv)}
                        title="编辑服务器"
                        className="motion-press inline-flex h-9 w-9 items-center justify-center rounded-[10px] bg-muted text-foreground hover:bg-foreground/10"
                      >
                        <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                      <ServerMoreMenu
                        server={srv}
                        onOpenConcurrent={onOpenTerminal}
                        onDuplicate={(s) => onDuplicateServer?.(s)}
                        onDelete={(s) => onDeleteServer?.(s)}
                      />
                      <button
                        type="button"
                        onClick={() => onOpenTerminal(srv)}
                        className="motion-press inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-primary/10 px-3 text-[13px] font-semibold text-primary hover:bg-primary/18"
                      >
                        <TerminalIcon className="h-3.5 w-3.5" />
                        <span>连接</span>
                      </button>
                    </div>
                  </div>
                );
              })
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

function getStatusDot(kind: CardState["kind"]): string {
  switch (kind) {
    case "online":
      return "bg-emerald-500 motion-status-online";
    case "connecting":
      return "bg-amber-400 animate-pulse";
    case "need_password":
      return "bg-muted-foreground/50";
    case "error":
      return "bg-red-500";
  }
}

const RingChart = memo(function RingChart({
  percent,
  colorClass,
  centerText,
  label,
  subLabel,
}: {
  percent: number;
  colorClass: string;
  centerText: string;
  label: string;
  subLabel: string;
}) {
  const size = 46;
  const strokeWidth = 4.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percent));

  return (
    <div className="flex w-[54px] flex-col items-center text-center">
      <div className="relative flex h-[46px] w-[46px] items-center justify-center">
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            className="text-muted"
          />
          {clamped > 0 && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth={strokeWidth}
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - clamped / 100)}
              strokeLinecap="round"
              className={cn(
                "transition-[stroke-dashoffset,color] duration-500 [transition-timing-function:var(--ease-decelerate)]",
                colorClass
              )}
            />
          )}
        </svg>
        <span className="absolute font-mono text-[10.5px] font-bold tabular-nums text-card-foreground">
          {centerText}
        </span>
      </div>
      <span className="mt-0.5 text-[11px] font-medium leading-tight text-card-foreground">
        {label}
      </span>
      <span className="max-w-full truncate text-[9.5px] leading-tight tabular-nums text-muted-foreground">
        {subLabel}
      </span>
    </div>
  );
});

const MiniBar = memo(function MiniBar({
  label,
  percent,
  valueText,
  subLabel,
  barColorClass,
}: {
  label: string;
  percent: number;
  valueText: string;
  subLabel: string;
  barColorClass: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-1 text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-semibold tabular-nums text-card-foreground">
          {valueText}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width,background-color] duration-500 [transition-timing-function:var(--ease-decelerate)]",
            barColorClass
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <div className="mt-0.5 truncate text-[10px] tabular-nums text-muted-foreground">
        {subLabel}
      </div>
    </div>
  );
});

function formatUsedTotal(used: number, total: number): string {
  if (total <= 0) return formatBytes(used);
  const units = [
    { label: "T", size: 1024 ** 4 },
    { label: "G", size: 1024 ** 3 },
    { label: "M", size: 1024 ** 2 },
    { label: "K", size: 1024 },
  ];
  const unit = units.find((u) => total >= u.size) ?? { label: "B", size: 1 };
  const uVal = used / unit.size;
  const tVal = total / unit.size;
  const uStr = uVal < 10 ? uVal.toFixed(1) : Math.round(uVal).toString();
  const tStr =
    tVal >= 10 || Math.abs(tVal - Math.round(tVal)) < 0.05
      ? Math.round(tVal).toString()
      : tVal.toFixed(1);
  return `${uStr}/${tStr}${unit.label}`;
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
  if (days > 0) return `${days} 天 ${hours} 小时`;
  const mins = Math.floor((secs % 3600) / 60);
  if (hours > 0) return `${hours} 小时 ${mins} 分钟`;
  return `${mins} 分钟`;
}

function maskHost(host: string): string {
  const trimmed = host.trim();
  const ipv4 = trimmed.split(".");
  if (ipv4.length === 4 && ipv4.every((seg) => /^\d{1,3}$/.test(seg))) {
    return `${ipv4[0]}.•••.•••.${ipv4[3]}`;
  }
  if (trimmed.includes(":")) {
    return "••••:••••";
  }
  const dotIdx = trimmed.indexOf(".");
  if (dotIdx > 0) {
    return `•••${trimmed.slice(dotIdx)}`;
  }
  return "••••••";
}
