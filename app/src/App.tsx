import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Plus,
  Search,
  Server as ServerIcon,
  ShieldCheck,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from "lucide-react";
import { AddServerModal } from "./components/AddServerModal";
import { PromptSecretModal } from "./components/PromptSecretModal";
import { TerminalView } from "./components/TerminalView";
import type { Server, TabStatus, TerminalTab } from "./types";

const STORAGE_KEY = "serverhub.servers.v1";

function loadServers(): Server[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function App() {
  const [servers, setServers] = useState<Server[]>(loadServers);
  const [search, setSearch] = useState("");
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingPasswordServer, setPendingPasswordServer] =
    useState<Server | null>(null);
  const [latency, setLatency] = useState<
    Record<string, number | "timeout" | "pending">
  >({});

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
    } catch {
      // Ignore storage quota errors
    }
  }, [servers]);

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
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(tabId);
    },
    []
  );

  const handleConnectClick = async (server: Server) => {
    const secret = await invoke<string | null>("secret_get", {
      id: server.id,
    }).catch(() => null);
    if (server.auth.type === "password") {
      if (secret !== null && secret !== "") {
        openTab(server, secret);
      } else {
        setPendingPasswordServer(server);
      }
    } else {
      openTab(server, undefined, secret ?? undefined);
    }
  };

  const handleStatusChange = useCallback(
    (
      tabId: string,
      status: TabStatus,
      sessionId?: string | null,
      errorMessage?: string
    ) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.tabId === tabId
            ? {
                ...t,
                status,
                sessionId: sessionId !== undefined ? sessionId : t.sessionId,
                errorMessage,
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
        setActiveTabId(fallback ? fallback.tabId : null);
      }
      return next;
    });
  };

  const deleteServer = (id: string) => {
    setServers((prev) => prev.filter((s) => s.id !== id));
    invoke("secret_delete", { id }).catch(() => {});
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-transparent">
      {/* Left Vibrancy Sidebar */}
      <aside className="sidebar flex h-full w-64 shrink-0 flex-col">
        {/* Top drag region leaving ~80px for macOS traffic lights */}
        <div
          data-tauri-drag-region
          className="mac-traffic-pad flex h-[38px] shrink-0 items-center justify-end pr-3 pl-3"
        >
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            title="添加服务器"
            className="sidebar-item flex items-center gap-1 px-2 py-1 text-xs font-medium opacity-80 transition hover:opacity-100"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>添加</span>
          </button>
        </div>

        {/* Search */}
        <div className="px-3 pb-2">
          <div
            className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs"
            style={{
              borderColor: "var(--separator)",
              background: "var(--hover)",
            }}
          >
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
                          <ServerIcon className="h-4 w-4 shrink-0 text-blue-500" />
                          <div className="min-w-0">
                            <div className="truncate text-xs font-medium">
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
                              deleteServer(server.id);
                            }}
                            title="删除"
                            className="rounded p-1 opacity-0 transition group-hover:opacity-60 hover:!opacity-100 hover:text-red-500"
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
          className="flex items-center gap-1.5 border-t px-3 py-2 text-[11px] opacity-60"
          style={{ borderColor: "var(--separator)" }}
        >
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
          <span>TOFU 主机指纹校验已启用</span>
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
          {tabs.length === 0 ? (
            <span
              data-tauri-drag-region
              className="text-xs font-medium opacity-55"
            >
              ServerHub
            </span>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
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
                    className={`flex max-w-[180px] shrink-0 cursor-pointer items-center gap-2 rounded-md px-2.5 py-1 text-xs transition ${
                      isActive ? "font-medium shadow-xs" : "opacity-70 hover:opacity-100"
                    }`}
                    style={
                      isActive ? { background: "var(--selected)" } : undefined
                    }
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} />
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
          )}
        </header>

        {/* Terminal / Empty State Area */}
        <div className="relative min-h-0 flex-1">
          {tabs.length === 0 ? (
            <div className="flex h-full items-center justify-center p-8">
              <div className="card max-w-md p-7 text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-500/15 text-blue-500">
                  <TerminalIcon className="h-6 w-6" />
                </div>
                <h1 className="mb-2 text-lg font-semibold">欢迎使用 ServerHub</h1>
                <p className="mb-5 text-xs leading-relaxed opacity-70">
                  添加你的第一台 Linux 服务器，或在左侧边栏点击已有服务器即可开启交互式
                  SSH 终端。
                </p>
                <button
                  type="button"
                  onClick={() => setAddOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500 px-4 py-2 text-xs font-medium text-white shadow-sm transition hover:bg-blue-600"
                >
                  <Plus className="h-4 w-4" />
                  <span>添加服务器</span>
                </button>
              </div>
            </div>
          ) : (
            tabs.map((tab) => (
              <TerminalView
                key={tab.tabId}
                tab={tab}
                active={tab.tabId === activeTabId}
                onStatusChange={handleStatusChange}
              />
            ))
          )}
        </div>
      </main>

      <AddServerModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdd={async (server, secret) => {
          setServers((prev) => [server, ...prev]);
          if (secret) {
            await invoke("secret_save", { id: server.id, secret }).catch(
              console.error
            );
          }
        }}
      />

      <PromptSecretModal
        server={pendingPasswordServer}
        onCancel={() => setPendingPasswordServer(null)}
        onConfirm={(password) => {
          const srv = pendingPasswordServer;
          setPendingPasswordServer(null);
          if (srv) {
            invoke("secret_save", { id: srv.id, secret: password }).catch(
              console.error
            );
            openTab(srv, password);
          }
        }}
      />
    </div>
  );
}

export default App;
