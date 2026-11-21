import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  FileInput,
  LayoutDashboard,
  Monitor,
  Moon,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { useTheme, type ThemeMode } from "@/lib/theme";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Dashboard } from "./components/Dashboard";
import { HostKeyModal } from "./components/HostKeyModal";
import { ImportSshConfigModal } from "./components/ImportSshConfigModal";
import { PromptSecretModal } from "./components/PromptSecretModal";
import { ProviderIcon } from "./components/ProviderIcon";
import { ServerFormModal } from "./components/ServerFormModal";
import { TerminalView } from "./components/TerminalView";
import type { CmdError, Server, TabStatus, TerminalTab } from "./types";

const LEGACY_STORAGE_KEY = "serverhub.servers.v1";

export function App() {
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
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
  const [pendingHostKey, setPendingHostKey] = useState<{
    tabId: string | null;
    hostPort: string;
    fingerprint: string;
  } | null>(null);
  const [acceptedHostKeys, setAcceptedHostKeys] = useState<
    Record<string, string>
  >({});
  const [dashboardPollTrigger, setDashboardPollTrigger] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<Server | null>(null);
  const [latency, setLatency] = useState<
    Record<string, number | "timeout" | "pending">
  >({});

  const refreshServers = useCallback(async () => {
    try {
      const list = await invoke<Server[]>("servers_list");
      if (list.length === 0) {
        const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacyRaw) {
          try {
            const parsed = JSON.parse(legacyRaw);
            if (Array.isArray(parsed) && parsed.length > 0) {
              await invoke<number>("servers_import", { servers: parsed });
              localStorage.removeItem(LEGACY_STORAGE_KEY);
              const migrated = await invoke<Server[]>("servers_list");
              setServers(migrated);
              return;
            }
          } catch {
            // Ignore malformed legacy storage
          }
          localStorage.removeItem(LEGACY_STORAGE_KEY);
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
    if (servers.length === 0) return;
    let cancelled = false;

    const pingAll = () => {
      for (const srv of servers) {
        setLatency((prev) =>
          prev[srv.id] === undefined ? { ...prev, [srv.id]: "pending" } : prev
        );
        invoke<number>("ssh_ping", { host: srv.host, port: srv.port })
          .then((ms) => {
            if (!cancelled) {
              setLatency((prev) => ({ ...prev, [srv.id]: ms }));
            }
          })
          .catch(() => {
            if (!cancelled) {
              setLatency((prev) => ({ ...prev, [srv.id]: "timeout" }));
            }
          });
      }
    };

    pingAll();
    const timer = window.setInterval(pingAll, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [servers]);

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

  const groupedServers = useMemo(() => {
    const groups = new Map<string, Server[]>();
    for (const s of filteredServers) {
      const key = s.group || "未分组";
      const list = groups.get(key) ?? [];
      list.push(s);
      groups.set(key, list);
    }
    return Array.from(groups.entries());
  }, [filteredServers]);

  const openTab = useCallback(
    (server: Server, password?: string, passphrase?: string) => {
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

  const handleConnectClick = (server: Server) => {
    openTab(server);
  };

  const handleStatusChange = useCallback(
    (
      tabId: string,
      status: TabStatus,
      sessionId?: string | null,
      errorMessage?: string,
      errorKind?: CmdError["kind"]
    ) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.tabId === tabId
            ? {
                ...t,
                status,
                sessionId: sessionId !== undefined ? sessionId : t.sessionId,
                errorMessage,
                errorKind,
                password: status === "connected" ? undefined : t.password,
                passphrase: status === "connected" ? undefined : t.passphrase,
              }
            : t
        )
      );
    },
    []
  );

  const closeTab = (tabId: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.tabId === tabId);
      const next = prev.filter((t) => t.tabId !== tabId);
      if (activeTabId === tabId) {
        const fallback = next[Math.min(idx, next.length - 1)];
        setActiveTabId(fallback ? fallback.tabId : "overview");
      }
      return next;
    });
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-transparent">
      {/* Left Vibrancy Sidebar */}
      <aside className="sidebar flex h-full w-64 shrink-0 flex-col">
        {/* Top drag region leaving ~80px for macOS traffic lights */}
        <div
          data-tauri-drag-region
          className="mac-traffic-pad flex h-[38px] shrink-0 items-center justify-end gap-1 pr-3 pl-3"
        >
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            title="导入 ~/.ssh/config"
            className="sidebar-item flex items-center gap-1 px-2 py-1 text-xs font-medium opacity-75 transition hover:opacity-100"
          >
            <FileInput className="h-3.5 w-3.5" />
            <span>导入</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setEditingServer(null);
              setFormOpen(true);
            }}
            title="添加服务器"
            className="sidebar-item flex items-center gap-1 px-2 py-1 text-xs font-medium opacity-80 transition hover:opacity-100"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>添加</span>
          </button>
        </div>

        {/* Overview Entry */}
        <div className="px-2 pb-2">
          <button
            type="button"
            data-active={activeTabId === "overview"}
            onClick={() => setActiveTabId("overview")}
            className="sidebar-item flex w-full items-center gap-2 px-2.5 py-1.5 text-[13px] font-medium transition"
          >
            <LayoutDashboard className="h-3.5 w-3.5 text-primary" />
            <span>概览</span>
          </button>
        </div>

        {/* Search */}
        <div className="px-3 pb-2">
          <div className="flex h-8 items-center gap-2 rounded-[10px] bg-muted px-2.5 text-[13px]">
            <Search className="h-3.5 w-3.5 opacity-55" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索主机或分组..."
              className="w-full bg-transparent outline-none placeholder:opacity-50"
            />
          </div>
        </div>

        {/* Server List */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {groupedServers.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs opacity-60">
              暂无服务器，点击右上角「添加」
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
                        className="sidebar-item group flex cursor-pointer items-center justify-between gap-1.5 px-2.5 py-2 transition"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <ProviderIcon server={server} />
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-medium">
                              {server.name}
                            </div>
                            <div className="truncate font-mono text-[11px] opacity-60">
                              {server.username}@{server.host}:{server.port}
                            </div>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {typeof ping === "number" ? (
                            <span className="inline-flex items-center gap-1 font-mono text-[10px] opacity-70">
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
                            <span className="text-[10px] text-red-500/80">
                              超时
                            </span>
                          ) : ping === "pending" ? (
                            <span className="text-[10px] opacity-45">…</span>
                          ) : null}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingServer(server);
                              setFormOpen(true);
                            }}
                            title="编辑"
                            className="rounded p-1 opacity-0 transition group-hover:opacity-60 hover:!opacity-100"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPendingDelete(server);
                            }}
                            title="删除"
                            className="rounded p-1 opacity-0 transition group-hover:opacity-60 hover:!opacity-100 hover:text-destructive"
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
          className="flex items-center justify-between gap-2 border-t px-3 py-2 text-[11px]"
          style={{ borderColor: "var(--separator)" }}
        >
          <div className="flex min-w-0 items-center gap-1.5 opacity-60">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            <span className="truncate">TOFU 已启用</span>
          </div>
          <div className="relative grid h-7 w-[96px] shrink-0 grid-cols-3 rounded-[9px] bg-muted p-[2px]">
            <div
              className="absolute bottom-[2px] left-[2px] top-[2px] w-[calc((100%-4px)/3)] rounded-[7px] bg-background shadow-[0_3px_8px_rgb(0_0_0/.12),0_3px_1px_rgb(0_0_0/.04)] transition-transform duration-300 [transition-timing-function:cubic-bezier(.2,.9,.25,1)]"
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
                  className={`relative z-10 grid place-items-center transition ${
                    active ? "opacity-100" : "opacity-55 hover:opacity-85"
                  }`}
                >
                  <Icon className="h-3 w-3" />
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="content flex min-w-0 flex-1 flex-col">
        {/* Top Tab Bar + Drag Region */}
        <header
          data-tauri-drag-region
          className="flex h-[38px] shrink-0 items-center gap-1 border-b px-3"
          style={{ borderColor: "var(--separator)" }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            <div
              onClick={() => setActiveTabId("overview")}
              className={`flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[13px] transition ${
                activeTabId === "overview"
                  ? "bg-muted font-semibold"
                  : "opacity-70 hover:opacity-100"
              }`}
            >
              <LayoutDashboard className="h-3.5 w-3.5 text-primary" />
              <span>概览</span>
            </div>
            {tabs.map((tab) => {
              const isActive = tab.tabId === activeTabId;
              const dotColor =
                tab.status === "connected"
                  ? "bg-emerald-500"
                  : tab.status === "connecting"
                    ? "bg-amber-400 animate-pulse"
                    : tab.status === "error"
                      ? "bg-red-500"
                      : "bg-zinc-400";
              return (
                <div
                  key={tab.tabId}
                  onClick={() => setActiveTabId(tab.tabId)}
                  className={`flex h-7 max-w-[180px] shrink-0 cursor-pointer items-center gap-2 rounded-full px-3 text-[13px] transition ${
                    isActive
                      ? "bg-muted font-semibold"
                      : "opacity-70 hover:opacity-100"
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
                    className="rounded p-0.5 opacity-60 hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
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
              activeTabId === "overview" ? "h-full w-full" : "hidden"
            }
          >
            <Dashboard
              servers={servers}
              visible={activeTabId === "overview"}
              acceptedHostKeys={acceptedHostKeys}
              pollTrigger={dashboardPollTrigger}
              onOpenTerminal={handleConnectClick}
              onAddServer={() => {
                setEditingServer(null);
                setFormOpen(true);
              }}
              onNeedPassword={(server) => {
                setPendingPassword({ tabId: null, server });
              }}
              onHostKeyUnknown={(hostPort, fingerprint) => {
                setPendingHostKey((prev) =>
                  prev ?? { tabId: null, hostPort, fingerprint }
                );
              }}
            />
          </div>
          {tabs.map((tab) => (
            <TerminalView
              key={`${tab.tabId}-${tab.connectNonce}`}
              tab={tab}
              active={tab.tabId === activeTabId}
              onStatusChange={handleStatusChange}
              onHostKeyUnknown={(tabId, hostPort, fingerprint) => {
                setPendingHostKey({ tabId, hostPort, fingerprint });
              }}
              onNeedPassword={(tabId, server) => {
                setPendingPassword({ tabId, server });
              }}
              onReconnect={(tabId) => {
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
              }}
            />
          ))}
        </div>
      </main>

      <ServerFormModal
        open={formOpen}
        initial={editingServer}
        onClose={() => {
          setFormOpen(false);
          setEditingServer(null);
        }}
        onSave={async (server, secret) => {
          await invoke("servers_upsert", { server }).catch(console.error);
          if (secret) {
            await invoke("secret_set", {
              serverId: server.id,
              password: secret,
            }).catch(console.error);
          }
          await refreshServers();
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
        info={pendingHostKey}
        onCancel={() => setPendingHostKey(null)}
        onConfirm={(fingerprint) => {
          const item = pendingHostKey;
          setPendingHostKey(null);
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
                      status: "connecting",
                      errorMessage: undefined,
                      errorKind: undefined,
                      connectNonce: t.connectNonce + 1,
                    }
                  : t
              )
            );
          } else {
            await invoke("secret_set", {
              serverId: pending.server.id,
              password,
            }).catch(console.error);
            setDashboardPollTrigger((n) => n + 1);
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
                  detail: `${pendingDelete.username}@${pendingDelete.host}:${pendingDelete.port}`,
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
    </div>
  );
}

export default App;
