import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  LayoutDashboard,
  Monitor,
  Moon,
  Pencil,
  Plus,
  Search,
  Settings,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import {
  loadCustomGroups,
  loadRecentServerIds,
  pushRecentServerId,
  saveCustomGroups,
} from "@/lib/groups";
import { applyAppearanceSettings, useSettings } from "@/lib/settings";
import { getSyncConfig, runSyncNow } from "@/lib/sync";
import { useTheme, type ThemeMode } from "@/lib/theme";
import { BrandLogo } from "./components/BrandLogo";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Dashboard } from "./components/Dashboard";
import { HostKeyModal } from "./components/HostKeyModal";
import { ImportSshConfigModal } from "./components/ImportSshConfigModal";
import { OsIcon } from "./components/OsIcon";
import { PromptSecretModal } from "./components/PromptSecretModal";
import { ProviderIcon } from "./components/ProviderIcon";
import { RdpView } from "./components/RdpView";
import { ServerFormModal } from "./components/ServerFormModal";
import { SettingsPage } from "./components/SettingsPage";
import { TerminalView } from "./components/TerminalView";
import { VncView } from "./components/VncView";
import type { CmdError, Credential, Server, TabStatus, TerminalTab } from "./types";

const LEGACY_STORAGE_KEY = "serverhub.servers.v1";

export function App() {
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  const { settings, updateSettings } = useSettings();
  const [servers, setServers] = useState<Server[]>([]);
  const [search, setSearch] = useState("");
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>("overview");
  const [formOpen, setFormOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<Server | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [pendingPassword, setPendingPassword] = useState<{
    tabId: string | null;
    server: Server;
  } | null>(null);
  const [pendingHostKeys, setPendingHostKeys] = useState<
    {
      tabId: string | null;
      hostPort: string;
      fingerprint: string;
    }[]
  >([]);
  const enqueueHostKey = useCallback(
    (item: { tabId: string | null; hostPort: string; fingerprint: string }) => {
      setPendingHostKeys((prev) =>
        prev.some((x) => x.hostPort === item.hostPort) ? prev : [...prev, item]
      );
    },
    []
  );
  const [acceptedHostKeys, setAcceptedHostKeys] = useState<
    Record<string, string>
  >({});
  const [dashboardPollTrigger, setDashboardPollTrigger] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<Server | null>(null);
  const [pendingDeleteGroup, setPendingDeleteGroup] = useState<string | null>(
    null
  );
  const [latency, setLatency] = useState<
    Record<string, number | "timeout" | "pending">
  >({});
  const [customGroups, setCustomGroups] = useState<string[]>(() =>
    loadCustomGroups()
  );
  const [recentServerIds, setRecentServerIds] = useState<string[]>(() =>
    loadRecentServerIds()
  );
  const [selectedGroup, setSelectedGroup] = useState<string>("__all__");
  const hasInitializedGroupRef = useRef(false);
  const handleSelectGroup = useCallback((group: string) => {
    hasInitializedGroupRef.current = true;
    setSelectedGroup(group);
  }, []);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [toastError, setToastError] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const showErrorToast = useCallback((message: string) => {
    setToastError(message);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastError(null);
      toastTimerRef.current = null;
    }, 4500);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const formatEndpoint = (srv: Server) =>
    `${srv.username ? `${srv.username}@` : ""}${srv.host}:${srv.port}`;

  const refreshServers = useCallback(async () => {
    try {
      const list = await invoke<Server[]>("servers_list");
      if (list.length === 0) {
        const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacyRaw) {
          let parsed: unknown = null;
          let parseOk = false;
          try {
            parsed = JSON.parse(legacyRaw);
            parseOk = true;
          } catch {
            // Malformed legacy storage can be safely removed
            localStorage.removeItem(LEGACY_STORAGE_KEY);
          }
          if (parseOk) {
            if (Array.isArray(parsed) && parsed.length > 0) {
              try {
                await invoke<number>("servers_import", { servers: parsed });
                localStorage.removeItem(LEGACY_STORAGE_KEY);
                const migrated = await invoke<Server[]>("servers_list");
                setServers(migrated);
                return;
              } catch (importErr) {
                // Keep legacy storage intact so a transient import error does not lose data
                console.error("迁移旧版服务器配置失败:", importErr);
              }
            } else {
              localStorage.removeItem(LEGACY_STORAGE_KEY);
            }
          }
        }
      }
      setServers(list);
    } catch (err) {
      console.error("加载服务器列表失败:", err);
    }
  }, []);

  useEffect(() => {
    void refreshServers();
  }, [refreshServers]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen("mcp:servers-changed", () => {
      void refreshServers();
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refreshServers]);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const statsSummaryRef = useRef<Record<string, string>>({});

  const handleServerStatsSummary = useCallback(
    (serverId: string, summary: string) => {
      statsSummaryRef.current[serverId] = summary;
    },
    []
  );

  const getServerStatsSummary = useCallback(
    (serverId: string) => statsSummaryRef.current[serverId],
    []
  );

  const pingTargetsKey = useMemo(
    () => servers.map((s) => `${s.id}:${s.host}:${s.port}`).join("|"),
    [servers]
  );

  useEffect(() => {
    let cancelled = false;
    let timerId: number | undefined;

    const doSilentSync = async () => {
      try {
        const res = await runSyncNow(settingsRef.current);
        if (cancelled) return;
        await refreshServers();
        if (res.pulled_app_settings) {
          updateSettings(res.pulled_app_settings);
        }
      } catch (err) {
        console.warn("后台自动同步失败:", err);
      }
    };

    const scheduleAutoSync = (allowStartupRun: boolean) => {
      if (timerId !== undefined) {
        window.clearInterval(timerId);
        timerId = undefined;
      }
      void getSyncConfig()
        .then(({ config }) => {
          if (cancelled || !config.enabled) return;
          if (allowStartupRun && config.sync_on_startup) {
            void doSilentSync();
          }
          if (config.auto_sync && config.auto_sync_interval_min > 0) {
            const ms = Math.max(5, config.auto_sync_interval_min) * 60_000;
            timerId = window.setInterval(() => {
              void doSilentSync();
            }, ms);
          }
        })
        .catch(() => {
          // Ignore when sync config is unavailable
        });
    };

    scheduleAutoSync(true);

    const handleSyncConfigChanged = () => {
      scheduleAutoSync(false);
    };
    window.addEventListener(
      "serverhub:sync-config-changed",
      handleSyncConfigChanged
    );

    return () => {
      cancelled = true;
      window.removeEventListener(
        "serverhub:sync-config-changed",
        handleSyncConfigChanged
      );
      if (timerId !== undefined) window.clearInterval(timerId);
    };
  }, [refreshServers, updateSettings]);

  // Sync open tabs with the latest server configuration after edits/syncs
  useEffect(() => {
    if (servers.length === 0) return;
    const byId = new Map(servers.map((s) => [s.id, s]));
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        const latest = byId.get(t.server.id);
        if (latest && latest !== t.server) {
          changed = true;
          return { ...t, server: latest };
        }
        return t;
      });
      return changed ? next : prev;
    });
  }, [servers]);

  useEffect(() => {
    const currentServers = serversRef.current;
    if (currentServers.length === 0 || settings.pingIntervalSec <= 0) return;
    let cancelled = false;
    let running = false;
    let flushTimer: number | null = null;

    const pingAll = async () => {
      if (running || cancelled) return;
      running = true;
      const targets = serversRef.current;
      try {
        setLatency((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const srv of targets) {
            if (next[srv.id] === undefined) {
              next[srv.id] = "pending";
              changed = true;
            }
          }
          return changed ? next : prev;
        });

        const CONCURRENCY = 8;
        let idx = 0;
        const pendingUpdates: Record<string, number | "timeout"> = {};

        const flush = () => {
          flushTimer = null;
          const keys = Object.keys(pendingUpdates);
          if (keys.length === 0 || cancelled) return;
          const batch = { ...pendingUpdates };
          for (const k of keys) delete pendingUpdates[k];
          setLatency((prev) => {
            let changed = false;
            for (const k of keys) {
              if (prev[k] !== batch[k]) {
                changed = true;
                break;
              }
            }
            return changed ? { ...prev, ...batch } : prev;
          });
        };

        const scheduleFlush = () => {
          if (flushTimer === null) {
            flushTimer = window.setTimeout(flush, 250);
          }
        };

        const worker = async () => {
          while (!cancelled) {
            const current = idx++;
            if (current >= targets.length) break;
            const srv = targets[current];
            try {
              const ms = await invoke<number>("ssh_ping", {
                host: srv.host,
                port: srv.port,
              });
              if (!cancelled) {
                pendingUpdates[srv.id] = ms;
                scheduleFlush();
              }
            } catch {
              if (!cancelled) {
                pendingUpdates[srv.id] = "timeout";
                scheduleFlush();
              }
            }
          }
        };

        await Promise.all(
          Array.from(
            { length: Math.min(CONCURRENCY, targets.length) },
            () => worker()
          )
        );
        if (flushTimer !== null) {
          window.clearTimeout(flushTimer);
          flushTimer = null;
        }
        flush();
      } finally {
        running = false;
      }
    };

    void pingAll();
    const timer = window.setInterval(
      () => void pingAll(),
      settings.pingIntervalSec * 1000
    );
    return () => {
      cancelled = true;
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      window.clearInterval(timer);
    };
  }, [pingTargetsKey, settings.pingIntervalSec]);

  const filteredServers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.host.toLowerCase().includes(q) ||
        (s.group ?? "").toLowerCase().includes(q)
    );
  }, [servers, search]);

  const allGroups = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const g of customGroups) {
      const trimmed = g.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        result.push(trimmed);
      }
    }
    for (const s of servers) {
      const trimmed = (s.group ?? "").trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        result.push(trimmed);
      }
    }
    return result;
  }, [customGroups, servers]);

  // Default to the first group instead of "__all__" when groups exist
  useEffect(() => {
    if (hasInitializedGroupRef.current) return;
    if (allGroups.length > 0) {
      hasInitializedGroupRef.current = true;
      setSelectedGroup(allGroups[0]);
    }
  }, [allGroups]);

  const handleCreateGroup = useCallback(() => {
    const name = newGroupName.trim();
    if (!name) {
      setCreatingGroup(false);
      return;
    }
    if (!allGroups.includes(name)) {
      const next = [...customGroups, name];
      setCustomGroups(next);
      saveCustomGroups(next);
    }
    setSelectedGroup(name);
    setNewGroupName("");
    setCreatingGroup(false);
  }, [newGroupName, allGroups, customGroups]);

  const handleDeleteGroup = useCallback(
    async (groupName: string) => {
      const next = customGroups.filter((g) => g !== groupName);
      setCustomGroups(next);
      saveCustomGroups(next);
      if (selectedGroup === groupName) {
        setSelectedGroup("__all__");
      }
      const affected = servers.filter(
        (s) => (s.group ?? "").trim() === groupName
      );
      if (affected.length > 0) {
        await Promise.all(
          affected.map((s) =>
            invoke("servers_upsert", {
              server: { ...s, group: undefined },
            }).catch(console.error)
          )
        );
        await refreshServers();
      }
    },
    [customGroups, selectedGroup, servers, refreshServers]
  );

  const groupedServers = useMemo(() => {
    if (selectedGroup === "__recent__") {
      const byId = new Map(filteredServers.map((s) => [s.id, s]));
      const recent = recentServerIds
        .map((id) => byId.get(id))
        .filter((s): s is Server => Boolean(s));
      return recent.length > 0
        ? ([["最近连接", recent]] as [string, Server[]][])
        : [];
    }
    if (selectedGroup === "__ungrouped__") {
      const items = filteredServers.filter((s) => !(s.group ?? "").trim());
      return items.length > 0 ? ([["未分组", items]] as [string, Server[]][]) : [];
    }
    if (selectedGroup !== "__all__") {
      const items = filteredServers.filter(
        (s) => (s.group ?? "").trim() === selectedGroup
      );
      return items.length > 0 ? ([[selectedGroup, items]] as [string, Server[]][]) : [];
    }
    const groups = new Map<string, Server[]>();
    for (const s of filteredServers) {
      const key = s.group || "未分组";
      const list = groups.get(key) ?? [];
      list.push(s);
      groups.set(key, list);
    }
    return Array.from(groups.entries());
  }, [filteredServers, selectedGroup, recentServerIds]);

  const openTab = useCallback(
    (server: Server, password?: string, passphrase?: string) => {
      setRecentServerIds((prev) => pushRecentServerId(prev, server.id));
      const tabId = crypto.randomUUID();
      const newTab: TerminalTab = {
        tabId,
        server,
        sessionId: null,
        status: "connecting",
        password,
        passphrase,
        connectNonce: 0,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(tabId);
    },
    []
  );

  const handleConnectClick = useCallback(
    (server: Server) => {
      openTab(server);
    },
    [openTab]
  );

  const handleOpenAddServer = useCallback(() => {
    setEditingServer(null);
    setFormOpen(true);
  }, []);

  const handleDashboardNeedPassword = useCallback((server: Server) => {
    setPendingPassword({ tabId: null, server });
  }, []);

  const handleEditServer = useCallback((srv: Server) => {
    setEditingServer(srv);
    setFormOpen(true);
  }, []);

  const handleDeleteServer = useCallback((srv: Server) => {
    setPendingDelete(srv);
  }, []);

  const handleReconnectTab = useCallback((tabId: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.tabId === tabId
          ? {
              ...t,
              status: "connecting",
              errorMessage: undefined,
              errorKind: undefined,
              connectNonce: t.connectNonce + 1,
            }
          : t
      )
    );
  }, []);

  const handleTabNeedPassword = useCallback((tabId: string, server: Server) => {
    setPendingPassword({ tabId, server });
  }, []);

  const handleTabHostKeyUnknown = useCallback(
    (tabId: string, hostPort: string, fingerprint: string) => {
      enqueueHostKey({ tabId, hostPort, fingerprint });
    },
    [enqueueHostKey]
  );

  const handleOpenSettings = useCallback(() => {
    setActiveTabId("settings");
  }, []);

  const handleDuplicateServer = useCallback(
    async (server: Server) => {
      const copy: Server = {
        ...server,
        id: crypto.randomUUID(),
        name: `${server.name} 副本`,
        updated_at: Math.floor(Date.now() / 1000),
      };
      try {
        await invoke("servers_upsert", { server: copy });
        const secret = await invoke<string | null>("secret_get", {
          id: server.id,
        }).catch(() => null);
        if (secret) {
          await invoke("secret_set", {
            serverId: copy.id,
            password: secret,
          }).catch(() => {});
        }
        await refreshServers();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showErrorToast(`创建服务器副本失败：${msg}`);
      }
    },
    [refreshServers, showErrorToast]
  );

  const handleServerLatency = useCallback((serverId: string, ms: number) => {
    setLatency((prev) =>
      prev[serverId] === ms ? prev : { ...prev, [serverId]: ms }
    );
  }, []);

  const handleDashboardHostKeyUnknown = useCallback(
    (hostPort: string, fingerprint: string) => {
      enqueueHostKey({ tabId: null, hostPort, fingerprint });
    },
    [enqueueHostKey]
  );

  const handleServerOsDetected = useCallback((serverId: string, os: string) => {
    const target = serversRef.current.find((s) => s.id === serverId);
    if (!target || target.os === os) return;
    const updated: Server = { ...target, os };
    setServers((prev) =>
      prev.map((s) => (s.id === serverId && s.os !== os ? updated : s))
    );
    void invoke("servers_upsert", { server: updated }).catch((err) => {
      console.error("保存服务器系统信息失败:", err);
    });
  }, []);

  const handleStatusChange = useCallback(
    (
      tabId: string,
      status: TabStatus,
      sessionId?: string | null,
      errorMessage?: string,
      errorKind?: CmdError["kind"]
    ) => {
      const clearSecrets =
        status === "connected" || status === "error" || status === "closed";
      setTabs((prev) =>
        prev.map((t) =>
          t.tabId === tabId
            ? {
                ...t,
                status,
                sessionId: sessionId !== undefined ? sessionId : t.sessionId,
                errorMessage,
                errorKind,
                password: clearSecrets ? undefined : t.password,
                passphrase: clearSecrets ? undefined : t.passphrase,
              }
            : t
        )
      );
    },
    []
  );

  const closeTab = useCallback((tabId: string) => {
    const prev = tabsRef.current;
    const idx = prev.findIndex((t) => t.tabId === tabId);
    if (idx === -1) return;
    const next = prev.filter((t) => t.tabId !== tabId);
    setTabs(next);
    if (activeTabIdRef.current === tabId) {
      const fallback = next[Math.min(idx, next.length - 1)];
      setActiveTabId(fallback ? fallback.tabId : "overview");
    }
  }, []);

  // Desktop global keyboard shortcuts:
  // - macOS: Cmd+K (search), Cmd+, (settings), Cmd+W (close active tab)
  // - Windows/Linux: Ctrl+Shift+K (or Ctrl+K outside terminal/inputs), Ctrl+, (settings), Ctrl+Shift+W (close tab)
  // Never hijack shortcuts while interacting with RDP/VNC remote canvases.
  useEffect(() => {
    const hasOpenModal =
      formOpen ||
      importOpen ||
      pendingHostKeys.length > 0 ||
      pendingPassword !== null ||
      pendingDelete !== null ||
      pendingDeleteGroup !== null;
    if (hasOpenModal) return;

    const isMac = document.documentElement.dataset.platform === "mac";

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.isComposing || e.keyCode === 229) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-remote-canvas="true"]')) {
        return;
      }

      const key = e.key.toLowerCase();
      if (isMac) {
        if (!e.metaKey || e.ctrlKey || e.shiftKey) return;
        if (key === "k") {
          e.preventDefault();
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        } else if (e.key === ",") {
          e.preventDefault();
          setActiveTabId("settings");
        } else if (
          key === "w" &&
          activeTabId !== "overview" &&
          activeTabId !== "settings"
        ) {
          e.preventDefault();
          closeTab(activeTabId);
        }
        return;
      }

      if (!e.ctrlKey || e.metaKey) return;
      if (e.key === "," && !e.shiftKey) {
        e.preventDefault();
        setActiveTabId("settings");
      } else if (key === "k") {
        const insideTerminalOrInput = Boolean(
          target?.closest(".xterm") ||
            target?.tagName === "INPUT" ||
            target?.tagName === "TEXTAREA" ||
            target?.isContentEditable
        );
        if (e.shiftKey || !insideTerminalOrInput) {
          e.preventDefault();
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        }
      } else if (
        key === "w" &&
        e.shiftKey &&
        activeTabId !== "overview" &&
        activeTabId !== "settings"
      ) {
        e.preventDefault();
        closeTab(activeTabId);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    formOpen,
    importOpen,
    pendingHostKeys.length,
    pendingPassword,
    pendingDelete,
    pendingDeleteGroup,
    activeTabId,
    closeTab,
  ]);

  useEffect(() => {
    applyAppearanceSettings(settings);
  }, [settings]);

  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-transparent">
      {settings.backgroundImage && (
        <div
          className="pointer-events-none absolute inset-0 z-0 bg-cover bg-center"
          style={{ backgroundImage: `url("${settings.backgroundImage}")` }}
        />
      )}
      {/* Left Vibrancy Sidebar */}
      <aside
        className={`sidebar relative z-10 flex h-full w-64 shrink-0 flex-col ${
          settings.backgroundImage ? "bg-background/60 backdrop-blur-xl" : ""
        }`}
      >
        {/* Top drag region leaving ~80px for macOS traffic lights */}
        <div
          data-tauri-drag-region
          className="mac-traffic-pad h-[38px] shrink-0"
        />

        {/* Brand Logo */}
        <div className="px-3 pt-0.5 pb-3.5">
          <div className="flex items-center justify-center">
            <BrandLogo className="h-[20px] w-auto select-none text-foreground transition-colors duration-150" />
          </div>
        </div>

        {/* Prominent Primary Action */}
        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={() => {
              setEditingServer(null);
              setFormOpen(true);
            }}
            title="添加服务器（支持多种格式与粘贴）"
            className="motion-press flex h-8 w-full items-center justify-center gap-1.5 rounded-[10px] bg-primary px-3 text-[12px] font-semibold text-primary-foreground shadow-sm hover:opacity-92"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>添加服务器</span>
          </button>
        </div>

        {/* Search */}
        <div className="px-3 pb-2">
          <div className="flex h-8 items-center gap-2 rounded-[10px] bg-muted px-2.5 text-[13px] ring-1 ring-transparent transition-all duration-150 focus-within:bg-background/80 focus-within:ring-primary/40">
            <Search className="h-3.5 w-3.5 shrink-0 opacity-55" />
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索主机或分组..."
              className="w-full bg-transparent outline-none placeholder:opacity-50"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="清空搜索"
                className="motion-pop rounded-full p-0.5 opacity-55 transition hover:bg-foreground/10 hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        {/* Group Filter Tabs: 最近 / 全部 / 自定义分组 */}
        <div className="px-3 pb-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => handleSelectGroup("__recent__")}
              className={`motion-press inline-flex h-[22px] items-center rounded-[7px] px-2 text-[11px] font-medium ${
                selectedGroup === "__recent__"
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "bg-muted/80 text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              最近
            </button>
            <button
              type="button"
              onClick={() => handleSelectGroup("__all__")}
              className={`motion-press inline-flex h-[22px] items-center rounded-[7px] px-2 text-[11px] font-medium ${
                selectedGroup === "__all__"
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "bg-muted/80 text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              全部
            </button>
            {allGroups.map((groupName) => {
              const active = selectedGroup === groupName;
              return (
                <div
                  key={groupName}
                  className="group/grp relative inline-flex items-center"
                >
                  <button
                    type="button"
                    onClick={() => handleSelectGroup(groupName)}
                    className={`motion-press inline-flex h-[22px] max-w-[110px] items-center truncate rounded-[7px] px-2 text-[11px] font-medium ${
                      active
                        ? "bg-primary text-primary-foreground shadow-xs"
                        : "bg-muted/80 text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                    title={groupName}
                  >
                    <span className="truncate">{groupName}</span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingDeleteGroup(groupName);
                    }}
                    title={`删除分组「${groupName}」`}
                    className="pointer-events-none absolute -top-1.5 -right-1.5 z-10 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground opacity-0 shadow-sm transition-[opacity,background-color,border-color,color] duration-150 [transition-timing-function:var(--ease-decelerate)] group-hover/grp:pointer-events-auto group-hover/grp:opacity-100 hover:border-destructive/40 hover:bg-destructive hover:text-destructive-foreground"
                  >
                    <X className="h-2 w-2" />
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => {
                setCreatingGroup((v) => !v);
                setNewGroupName("");
              }}
              title="新建自定义分组"
              className="motion-press inline-flex h-[22px] w-[22px] items-center justify-center rounded-[7px] bg-muted/80 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Plus
                className={`h-3 w-3 transition-transform duration-200 [transition-timing-function:var(--ease-apple)] ${
                  creatingGroup ? "rotate-45" : ""
                }`}
              />
            </button>
          </div>
          {creatingGroup && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleCreateGroup();
              }}
              className="motion-popover-down mt-1.5 flex items-center gap-1"
            >
              <input
                type="text"
                autoFocus
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setCreatingGroup(false);
                    setNewGroupName("");
                  }
                }}
                placeholder="分组名称，回车创建..."
                className="h-7 min-w-0 flex-1 rounded-[8px] bg-muted px-2 text-[11px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary/50"
              />
              <button
                type="submit"
                className="h-7 shrink-0 rounded-[8px] bg-primary px-2 text-[11px] font-medium text-primary-foreground transition hover:opacity-90"
              >
                确定
              </button>
            </form>
          )}
        </div>

        {/* Server List */}
        <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {groupedServers.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs opacity-60">
              {search.trim()
                ? "未找到匹配的服务器"
                : selectedGroup === "__recent__"
                  ? "暂无最近连接记录"
                  : selectedGroup === "__ungrouped__"
                    ? "暂无未分组服务器"
                    : selectedGroup !== "__all__"
                      ? `分组「${selectedGroup}」暂无服务器`
                      : "暂无服务器，点击上方「添加服务器」"}
            </div>
          ) : (
            groupedServers.map(([groupName, items]) => (
              <div key={groupName} className="mb-3">
                <div className="px-2 py-1 text-[11px] font-semibold tracking-wide uppercase opacity-50">
                  {groupName}
                </div>
                <div className="space-y-0.5">
                  {items.map((server) => {
                    const ping = latency[server.id];
                    return (
                      <div
                        key={server.id}
                        onClick={() => handleConnectClick(server)}
                        className="sidebar-item group relative flex w-full cursor-pointer items-center gap-2 px-2 py-2"
                      >
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center">
                          <ProviderIcon server={server} className="h-8 w-8" />
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span
                              className="truncate text-[13px] font-medium leading-[1.35]"
                              title={server.name}
                            >
                              {server.name}
                            </span>
                            {server.protocol && server.protocol !== "ssh" && (
                              <span className="shrink-0 rounded bg-primary/15 px-1 py-0.5 text-[9px] font-semibold tracking-wide uppercase text-primary">
                                {server.protocol}
                              </span>
                            )}
                          </div>
                          <div className="flex min-w-0 items-center justify-between gap-1.5">
                            <div
                              className="flex min-w-0 flex-1 items-center gap-1 truncate text-[11px] opacity-60"
                              title={
                                server.os
                                  ? `${server.os} · ${formatEndpoint(server)}`
                                  : formatEndpoint(server)
                              }
                            >
                              {settings.showSidebarOs ? (
                                <>
                                  <OsIcon os={server.os} className="h-3 w-3 shrink-0" />
                                  <span className="truncate">
                                    {server.os ?? formatEndpoint(server)}
                                  </span>
                                </>
                              ) : (
                                <span className="truncate">
                                  {formatEndpoint(server)}
                                </span>
                              )}
                            </div>
                            {settings.showSidebarLatency &&
                              (typeof ping === "number" ? (
                                <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] tabular-nums opacity-70 will-change-[opacity] transition-opacity duration-200 [transition-timing-function:var(--ease-decelerate)] group-hover:pointer-events-none group-hover:opacity-0">
                                  <span
                                    className={`h-1.5 w-1.5 rounded-full ${
                                      ping < 100
                                        ? "bg-emerald-500"
                                        : ping < 300
                                        ? "bg-amber-400"
                                        : "bg-red-500"
                                    }`}
                                  />
                                  {ping} ms
                                </span>
                              ) : ping === "timeout" ? (
                                <span className="shrink-0 text-[10px] text-red-500/80 will-change-[opacity] transition-opacity duration-200 [transition-timing-function:var(--ease-decelerate)] group-hover:pointer-events-none group-hover:opacity-0">
                                  超时
                                </span>
                              ) : ping === "pending" ? (
                                <span className="shrink-0 text-[10px] opacity-45 will-change-[opacity] transition-opacity duration-200 [transition-timing-function:var(--ease-decelerate)] group-hover:pointer-events-none group-hover:opacity-0">
                                  …
                                </span>
                              ) : null)}
                          </div>
                        </div>
                        <div className="pointer-events-none absolute right-1.5 top-1/2 flex -translate-y-1/2 shrink-0 items-center gap-0.5 rounded-[8px] bg-card/95 p-0.5 opacity-0 shadow-sm ring-1 ring-border/70 backdrop-blur-md will-change-[opacity] transition-opacity duration-150 [transition-timing-function:var(--ease-decelerate)] group-hover:pointer-events-auto group-hover:opacity-100">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingServer(server);
                              setFormOpen(true);
                            }}
                            title="编辑"
                            className="motion-press inline-flex h-6 w-6 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPendingDelete(server);
                            }}
                            title="删除"
                            className="motion-press inline-flex h-6 w-6 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        <div
          className="flex h-[54px] shrink-0 items-center justify-between gap-2 border-t px-3"
          style={{ borderColor: "var(--separator)" }}
        >
          <button
            type="button"
            data-active={activeTabId === "settings"}
            onClick={() => setActiveTabId("settings")}
            title="软件设置"
            className={`sidebar-item inline-flex h-[34px] items-center gap-2 px-2.5 text-[13px] font-medium leading-none ${
              activeTabId === "settings"
                ? "text-foreground opacity-100"
                : "text-foreground/75 hover:text-foreground"
            }`}
          >
            <Settings
              className={`h-4 w-4 shrink-0 transition-colors duration-150 ${
                activeTabId === "settings" ? "text-primary" : "opacity-80"
              }`}
            />
            <span>设置</span>
          </button>
          <div className="relative grid h-[34px] w-[108px] shrink-0 grid-cols-3 rounded-[10px] bg-muted p-[3px]">
            <div
              className="pointer-events-none absolute bottom-[3px] left-[3px] top-[3px] w-[calc((100%-6px)/3)] rounded-[7px] bg-background shadow-[0_2px_6px_rgb(0_0_0/.12),0_1px_1px_rgb(0_0_0/.04)] transition-transform duration-300 [transition-timing-function:var(--ease-apple)]"
              style={{
                transform: `translateX(${
                  (themeMode === "light" ? 0 : themeMode === "dark" ? 1 : 2) *
                  100
                }%)`,
              }}
            />
            {(
              [
                { id: "light", label: "浅色", Icon: Sun },
                { id: "dark", label: "深色", Icon: Moon },
                { id: "system", label: "跟随系统", Icon: Monitor },
              ] as { id: ThemeMode; label: string; Icon: typeof Sun }[]
            ).map(({ id, label, Icon }) => {
              const active = themeMode === id;
              return (
                <button
                  key={id}
                  type="button"
                  title={label}
                  onClick={() => setThemeMode(id)}
                  className={`relative z-10 grid place-items-center transition-opacity duration-150 ${
                    active ? "opacity-100" : "opacity-55 hover:opacity-85"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main
        className={`content relative z-10 flex min-w-0 flex-1 flex-col ${
          settings.backgroundImage ? "backdrop-blur-xl" : ""
        }`}
        style={
          settings.backgroundImage
            ? { background: "color-mix(in srgb, var(--content-bg) 72%, transparent)" }
            : undefined
        }
      >
        {/* Top Tab Bar + Drag Region */}
        <header
          data-tauri-drag-region
          className="win-caption-pad flex h-[38px] shrink-0 items-center gap-1 border-b px-3"
          style={{ borderColor: "var(--separator)" }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            <div
              onClick={() => setActiveTabId("overview")}
              className={`motion-press flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[13px] ${
                activeTabId === "overview"
                  ? "bg-muted font-semibold"
                  : "opacity-70 hover:bg-muted/50 hover:opacity-100"
              }`}
            >
              <LayoutDashboard className="h-3.5 w-3.5 text-primary" />
              <span>概览</span>
            </div>
            {activeTabId === "settings" && (
              <div
                onClick={() => setActiveTabId("settings")}
                className="motion-tab-enter flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-muted px-3 text-[13px] font-semibold transition"
              >
                <Settings className="h-3.5 w-3.5 text-primary" />
                <span>设置</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveTabId("overview");
                  }}
                  className="rounded-full p-0.5 opacity-60 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
            {tabs.map((tab) => {
              const isActive = tab.tabId === activeTabId;
              const dotColor =
                tab.status === "connected"
                  ? "bg-emerald-500 motion-status-online"
                  : tab.status === "connecting"
                    ? "bg-amber-400 animate-pulse"
                    : tab.status === "error"
                      ? "bg-red-500"
                      : "bg-zinc-400";
              return (
                <div
                  key={tab.tabId}
                  onClick={() => setActiveTabId(tab.tabId)}
                  className={`motion-tab-enter motion-press flex h-7 max-w-[180px] shrink-0 cursor-pointer items-center gap-2 rounded-full px-3 text-[13px] ${
                    isActive
                      ? "bg-muted font-semibold"
                      : "opacity-70 hover:bg-muted/50 hover:opacity-100"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`}
                  />
                  <span className="truncate">{tab.server.name}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.tabId);
                    }}
                    className="rounded-full p-0.5 opacity-60 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </header>

        {/* Dashboard + Terminal Area */}
        <div className="relative min-h-0 flex-1">
          <div
            className={
              activeTabId === "overview"
                ? "h-full w-full"
                : "hidden"
            }
          >
            <Dashboard
              servers={servers}
              groups={allGroups}
              selectedGroup={selectedGroup}
              onSelectGroup={handleSelectGroup}
              recentServerIds={recentServerIds}
              visible={activeTabId === "overview"}
              acceptedHostKeys={acceptedHostKeys}
              pollTrigger={dashboardPollTrigger}
              onOpenTerminal={handleConnectClick}
              onAddServer={handleOpenAddServer}
              onNeedPassword={handleDashboardNeedPassword}
              onServerOsDetected={handleServerOsDetected}
              onServerLatency={handleServerLatency}
              onServerStatsSummary={handleServerStatsSummary}
              onDuplicateServer={handleDuplicateServer}
              onEditServer={handleEditServer}
              onDeleteServer={handleDeleteServer}
              monitorIntervalSec={settings.monitorIntervalSec}
              hideIp={settings.hideDashboardIp}
              onHostKeyUnknown={handleDashboardHostKeyUnknown}
            />
          </div>
          {activeTabId === "settings" && (
            <div className="h-full w-full">
              <SettingsPage
                settings={settings}
                onUpdate={updateSettings}
                themeMode={themeMode}
                onThemeChange={setThemeMode}
                onSyncPulled={() => void refreshServers()}
              />
            </div>
          )}
          {tabs.map((tab) => {
            const proto = tab.server.protocol ?? "ssh";
            if (proto === "vnc") {
              return (
                <VncView
                  key={tab.tabId}
                  tab={tab}
                  active={tab.tabId === activeTabId}
                  onStatusChange={handleStatusChange}
                  onNeedPassword={handleTabNeedPassword}
                  onReconnect={handleReconnectTab}
                />
              );
            }
            if (proto === "rdp") {
              return (
                <RdpView
                  key={tab.tabId}
                  tab={tab}
                  active={tab.tabId === activeTabId}
                  onStatusChange={handleStatusChange}
                  onNeedPassword={handleTabNeedPassword}
                  onReconnect={handleReconnectTab}
                />
              );
            }
            return (
              <TerminalView
                key={tab.tabId}
                tab={tab}
                active={tab.tabId === activeTabId}
                settings={settings}
                getStatsSummary={getServerStatsSummary}
                onStatusChange={handleStatusChange}
                onHostKeyUnknown={handleTabHostKeyUnknown}
                onNeedPassword={handleTabNeedPassword}
                onReconnect={handleReconnectTab}
                onOpenSettings={handleOpenSettings}
              />
            );
          })}
        </div>
      </main>

      <ServerFormModal
        open={formOpen}
        initial={editingServer}
        availableServers={servers}
        defaultPort={settings.defaultSshPort}
        defaultKeyPath={settings.defaultKeyPath}
        defaultTimeoutSecs={settings.defaultTimeoutSecs}
        defaultKeepaliveSecs={settings.defaultKeepaliveSecs}
        defaultTermType={settings.defaultTermType}
        defaultAuthPriority={settings.defaultAuthPriority}
        availableGroups={allGroups}
        defaultGroup={
          selectedGroup !== "__all__" &&
          selectedGroup !== "__recent__" &&
          selectedGroup !== "__ungrouped__"
            ? selectedGroup
            : ""
        }
        onOpenImport={
          !editingServer
            ? () => {
                setFormOpen(false);
                setImportOpen(true);
              }
            : undefined
        }
        onBatchImported={() => {
          void refreshServers();
        }}
        onClose={() => {
          setFormOpen(false);
          setEditingServer(null);
        }}
        onSave={async (server, secret) => {
          try {
            await invoke("servers_upsert", { server });
            if (server.auth.type === "ask") {
              await invoke("secret_forget", { serverId: server.id }).catch(
                () => {}
              );
            } else if (secret) {
              await invoke("secret_set", {
                serverId: server.id,
                password: secret,
              });
            }
            if (server.group && !customGroups.includes(server.group)) {
              const next = [...customGroups, server.group];
              setCustomGroups(next);
              saveCustomGroups(next);
            }
            await refreshServers();
            setDashboardPollTrigger((n) => n + 1);
            return true;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            showErrorToast(`保存服务器失败：${msg}`);
            return false;
          }
        }}
      />

      <ImportSshConfigModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          void refreshServers();
        }}
      />

      <HostKeyModal
        info={pendingHostKeys[0] ?? null}
        pendingQueue={pendingHostKeys}
        remainingCount={Math.max(0, pendingHostKeys.length - 1)}
        onCancel={() => setPendingHostKeys((prev) => prev.slice(1))}
        onConfirm={(fingerprint) => {
          const item = pendingHostKeys[0];
          setPendingHostKeys((prev) => prev.slice(1));
          if (!item) return;
          setAcceptedHostKeys((prev) => ({
            ...prev,
            [item.hostPort]: fingerprint,
          }));
          if (item.tabId) {
            setTabs((prev) =>
              prev.map((t) =>
                t.tabId === item.tabId
                  ? {
                      ...t,
                      acceptHostKey: fingerprint,
                      status: "connecting",
                      errorMessage: undefined,
                      errorKind: undefined,
                      connectNonce: t.connectNonce + 1,
                    }
                  : t
              )
            );
          } else {
            setDashboardPollTrigger((n) => n + 1);
          }
        }}
        onConfirmAll={() => {
          const items = pendingHostKeys;
          setPendingHostKeys([]);
          if (items.length === 0) return;
          setAcceptedHostKeys((prev) => {
            const next = { ...prev };
            for (const it of items) {
              next[it.hostPort] = it.fingerprint;
            }
            return next;
          });
          const tabFingerprints = new Map<string, string>();
          for (const it of items) {
            if (it.tabId) {
              tabFingerprints.set(it.tabId, it.fingerprint);
            }
          }
          if (tabFingerprints.size > 0) {
            setTabs((prev) =>
              prev.map((t) => {
                const fp = tabFingerprints.get(t.tabId);
                if (!fp) return t;
                return {
                  ...t,
                  acceptHostKey: fp,
                  status: "connecting",
                  errorMessage: undefined,
                  errorKind: undefined,
                  connectNonce: t.connectNonce + 1,
                };
              })
            );
          }
          setDashboardPollTrigger((n) => n + 1);
        }}
      />

      <PromptSecretModal
        server={pendingPassword?.server ?? null}
        onCancel={() => setPendingPassword(null)}
        onConfirm={async (password) => {
          const pending = pendingPassword;
          setPendingPassword(null);
          if (!pending) return;
          if (pending.tabId) {
            setTabs((prev) =>
              prev.map((t) =>
                t.tabId === pending.tabId
                  ? {
                      ...t,
                      password,
                      passphrase: password,
                      status: "connecting",
                      errorMessage: undefined,
                      errorKind: undefined,
                      connectNonce: t.connectNonce + 1,
                    }
                  : t
              )
            );
          } else if (pending.server.auth.type === "ask") {
            // For "ask" (每次询问) mode, open a terminal tab with the one-time password without saving to vault
            openTab(pending.server, password, password);
          } else if (
            pending.server.auth.type === "credential" &&
            pending.server.auth.credential_id
          ) {
            const credentialId = pending.server.auth.credential_id;
            try {
              const credList = await invoke<Credential[]>("credentials_list");
              const targetCred = credList.find((c) => c.id === credentialId);
              if (!targetCred) {
                showErrorToast("关联的登录凭证不存在，请在编辑服务器中重新选择");
                return;
              }
              await invoke("credentials_upsert", {
                credential: {
                  ...targetCred,
                  updated_at: Math.floor(Date.now() / 1000),
                },
                secret: password,
              });
              setDashboardPollTrigger((n) => n + 1);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              showErrorToast(`更新登录凭证密码失败：${msg}`);
            }
          } else {
            try {
              await invoke("secret_set", {
                serverId: pending.server.id,
                password,
              });
              setDashboardPollTrigger((n) => n + 1);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              showErrorToast(`保存登录密码失败：${msg}`);
            }
          }
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onCancel={() => setPendingDelete(null)}
        panel={
          pendingDelete
            ? {
                title: "删除服务器",
                party: {
                  name: pendingDelete.name,
                  detail: formatEndpoint(pendingDelete),
                },
                hero: (
                  <div className="rounded-[14px] bg-destructive/10 px-3.5 py-3 text-[15px] leading-[21px] text-destructive">
                    将删除该服务器配置，并清除钥匙串中保存的密码与监控会话，无法撤销。
                  </div>
                ),
                swipe: {
                  label: "滑动以删除",
                  doneLabel: "已删除",
                  color: "var(--color-destructive)",
                  icon: <Trash2 className="h-6 w-6" />,
                  onConfirm: async () => {
                    const srv = pendingDelete;
                    await invoke("monitor_stop", { serverId: srv.id }).catch(
                      () => {}
                    );
                    await invoke("servers_delete", { id: srv.id });
                    await invoke("secret_forget", { serverId: srv.id }).catch(
                      () => {}
                    );
                    delete statsSummaryRef.current[srv.id];
                    const nextTabs = tabsRef.current.filter(
                      (t) => t.server.id !== srv.id
                    );
                    setTabs(nextTabs);
                    const curActive = activeTabIdRef.current;
                    if (
                      curActive !== "overview" &&
                      curActive !== "settings" &&
                      !nextTabs.some((t) => t.tabId === curActive)
                    ) {
                      setActiveTabId(
                        nextTabs.length > 0
                          ? nextTabs[nextTabs.length - 1].tabId
                          : "overview"
                      );
                    }
                  },
                    onDone: () =>
                      setTimeout(() => {
                        setPendingDelete(null);
                        void refreshServers();
                      }, 700),
                  },
                }
              : { title: "" }
          }
        />

      <ConfirmDialog
        open={pendingDeleteGroup !== null}
        onCancel={() => setPendingDeleteGroup(null)}
        panel={
          pendingDeleteGroup
            ? (() => {
                const affectedCount = servers.filter(
                  (s) => (s.group ?? "").trim() === pendingDeleteGroup
                ).length;
                return {
                  title: "删除分组",
                  party: {
                    name: pendingDeleteGroup,
                    detail:
                      affectedCount > 0
                        ? `当前包含 ${affectedCount} 台服务器`
                        : "当前分组下暂无服务器",
                  },
                  hero: (
                    <div className="rounded-[14px] bg-destructive/10 px-3.5 py-3 text-[15px] leading-[21px] text-destructive">
                      {affectedCount > 0
                        ? `删除该分组后，组内 ${affectedCount} 台服务器将自动移至「未分组」，服务器配置本身不会被删除。`
                        : "将删除该自定义分组，此操作无法撤销。"}
                    </div>
                  ),
                  swipe: {
                    label: "滑动以删除分组",
                    doneLabel: "已删除",
                    color: "var(--color-destructive)",
                    icon: <Trash2 className="h-6 w-6" />,
                    onConfirm: async () => {
                      await handleDeleteGroup(pendingDeleteGroup);
                    },
                    onDone: () =>
                      setTimeout(() => {
                        setPendingDeleteGroup(null);
                      }, 500),
                  },
                };
              })()
            : { title: "" }
        }
      />

      {toastError && (
        <div
          role="alert"
          className="motion-banner-enter fixed right-4 bottom-4 z-50 flex max-w-md items-center gap-2.5 rounded-[14px] border border-destructive/30 bg-card/95 px-3.5 py-2.5 text-[12.5px] text-destructive shadow-xl backdrop-blur-xl"
        >
          <span className="min-w-0 flex-1 break-words">{toastError}</span>
          <button
            type="button"
            onClick={() => setToastError(null)}
            aria-label="关闭提示"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-destructive/70 transition hover:bg-destructive/10 hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
