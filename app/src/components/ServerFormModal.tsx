import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Eye,
  EyeOff,
  FileInput,
  KeyRound,
  Loader2,
  Network,
  Pencil,
  Plus,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { CLOUD_PROVIDERS } from "./ProviderIcon";
import { REGION_PRESETS } from "./RegionBadge";
import {
  BILLING_CYCLE_OPTIONS,
  CURRENCY_OPTIONS,
  calcDailyCost,
  formatMoney,
} from "../lib/cost";
import { candidateToServer, parseServerText } from "../lib/importParser";
import {
  AUTH_STAGE_META,
  DEFAULT_AUTH_PRIORITY,
  TERMINAL_TYPE_OPTIONS,
  buildSshAuthPayload,
  parseCmdError,
  sanitizeAuthPriority,
  type AuthMethod,
  type AuthStage,
  type BillingCycle,
  type Credential,
  type CredentialKind,
  type Protocol,
  type Server,
  type ServerCost,
} from "../types";

export type AuthTabType =
  | "password"
  | "key"
  | "credential"
  | "keyboard_interactive"
  | "ask";

const AUTH_TAB_OPTIONS: { id: AuthTabType; label: string }[] = [
  { id: "password", label: "密码认证" },
  { id: "key", label: "SSH 私钥" },
  { id: "credential", label: "登录凭证" },
  { id: "keyboard_interactive", label: "交互认证" },
  { id: "ask", label: "每次询问" },
];

interface ServerFormModalProps {
  open: boolean;
  initial?: Server | null;
  availableServers?: Server[];
  defaultPort?: number;
  defaultKeyPath?: string;
  defaultTimeoutSecs?: number;
  defaultKeepaliveSecs?: number;
  defaultTermType?: string;
  defaultAuthPriority?: AuthStage[];
  availableGroups?: string[];
  defaultGroup?: string;
  onOpenImport?: () => void;
  onBatchImported?: () => void;
  onClose: () => void;
  onSave: (server: Server, secret: string) => Promise<boolean | void> | boolean | void;
}

type TestResult =
  | { ok: true; ms: number }
  | {
      ok: false;
      error: string;
      unknownHostKey?: { hostPort: string; fingerprint: string };
    }
  | null;

export function ServerFormModal({
  open,
  initial,
  availableServers = [],
  defaultPort = 22,
  defaultKeyPath = "~/.ssh/id_ed25519",
  defaultTimeoutSecs = 10,
  defaultKeepaliveSecs = 20,
  defaultTermType = "xterm-256color",
  defaultAuthPriority = DEFAULT_AUTH_PRIORITY,
  availableGroups = [],
  defaultGroup = "",
  onOpenImport,
  onBatchImported,
  onClose,
  onSave,
}: ServerFormModalProps) {
  const [pasteText, setPasteText] = useState("");
  const [batchImporting, setBatchImporting] = useState(false);
  const [protocol, setProtocol] = useState<Protocol>("ssh");
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("root");
  const [domain, setDomain] = useState("");
  const [group, setGroup] = useState("");
  const [provider, setProvider] = useState("auto");
  const [region, setRegion] = useState("");

  // Auth states
  const [authType, setAuthType] = useState<AuthTabType>("key");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [keyPath, setKeyPath] = useState("~/.ssh/id_ed25519");
  const [askKeyPath, setAskKeyPath] = useState("");

  // Reusable Credentials states
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [selectedCredentialId, setSelectedCredentialId] = useState("");
  const [credEditorOpen, setCredEditorOpen] = useState(false);
  const [editingCredId, setEditingCredId] = useState<string | null>(null);
  const [credName, setCredName] = useState("");
  const [credUsername, setCredUsername] = useState("");
  const [credKind, setCredKind] = useState<CredentialKind>("password");
  const [credKeyPath, setCredKeyPath] = useState("~/.ssh/id_ed25519");
  const [credSecret, setCredSecret] = useState("");
  const [savingCred, setSavingCred] = useState(false);
  const [confirmDeleteCredId, setConfirmDeleteCredId] = useState<string | null>(null);

  // Auth Priority & SSH Connection Options
  const [authPriority, setAuthPriority] = useState<AuthStage[]>([
    ...DEFAULT_AUTH_PRIORITY,
  ]);
  const [timeoutSecs, setTimeoutSecs] = useState("10");
  const [keepaliveSecs, setKeepaliveSecs] = useState("20");
  const [termType, setTermType] = useState("xterm-256color");
  const [jumpHosts, setJumpHosts] = useState<string[]>([]);

  // Cost & Expiration
  const [costCycle, setCostCycle] = useState<BillingCycle>("monthly");
  const [costCurrency, setCostCurrency] = useState("CNY");
  const [costAmount, setCostAmount] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadCredentials = useCallback(async () => {
    try {
      const list = await invoke<Credential[]>("credentials_list");
      setCredentials(list);
      return list;
    } catch {
      setCredentials([]);
      return [];
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void loadCredentials().then((list) => {
      if (cancelled) return;
      if (initial?.auth.type === "credential") {
        setSelectedCredentialId(initial.auth.credential_id);
        setCredEditorOpen(list.length === 0);
      } else if (list.length > 0) {
        setSelectedCredentialId(list[0].id);
        setCredEditorOpen(false);
      } else {
        setSelectedCredentialId("");
        setCredEditorOpen(true);
      }
    });

    if (initial) {
      const proto = initial.protocol ?? "ssh";
      setProtocol(proto);
      setName(initial.name);
      setHost(initial.host);
      setPort(String(initial.port));
      setUsername(initial.username);
      setDomain(initial.domain ?? "");
      setGroup(initial.group ?? "");
      setProvider(initial.provider ?? "auto");
      setRegion(initial.region ?? "");

      if (proto !== "ssh") {
        setAuthType("password");
        setKeyPath(defaultKeyPath);
        setAskKeyPath("");
      } else {
        switch (initial.auth.type) {
          case "password":
            setAuthType("password");
            setKeyPath(defaultKeyPath);
            setAskKeyPath("");
            break;
          case "key":
            setAuthType("key");
            setKeyPath(initial.auth.path);
            setAskKeyPath("");
            break;
          case "credential":
            setAuthType("credential");
            setSelectedCredentialId(initial.auth.credential_id);
            setKeyPath(defaultKeyPath);
            setAskKeyPath("");
            break;
          case "keyboard_interactive":
            setAuthType("keyboard_interactive");
            setKeyPath(defaultKeyPath);
            setAskKeyPath("");
            break;
          case "ask":
            setAuthType("ask");
            setKeyPath(defaultKeyPath);
            setAskKeyPath(initial.auth.key_path ?? "");
            break;
        }
      }

      setAuthPriority(
        initial.auth_priority && initial.auth_priority.length > 0
          ? sanitizeAuthPriority(initial.auth_priority)
          : sanitizeAuthPriority(defaultAuthPriority)
      );
      setTimeoutSecs(String(initial.timeout_secs ?? defaultTimeoutSecs));
      setKeepaliveSecs(String(initial.keepalive_secs ?? defaultKeepaliveSecs));
      setTermType(initial.term_type || defaultTermType || "xterm-256color");
      setJumpHosts(initial.jump_hosts ?? []);

      if (initial.cost && initial.cost.amount > 0) {
        setCostCycle(initial.cost.cycle);
        setCostCurrency(initial.cost.currency || "CNY");
        setCostAmount(String(initial.cost.amount));
      } else {
        setCostCycle("monthly");
        setCostCurrency("CNY");
        setCostAmount("");
      }
      setExpiresAt(initial.expires_at ?? "");
    } else {
      setProtocol("ssh");
      setName("");
      setHost("");
      setPort(String(defaultPort));
      setUsername("root");
      setDomain("");
      setGroup(defaultGroup);
      setProvider("auto");
      setRegion("");
      setAuthType("key");
      setKeyPath(defaultKeyPath);
      setAskKeyPath("");
      setAuthPriority(sanitizeAuthPriority(defaultAuthPriority));
      setTimeoutSecs(String(defaultTimeoutSecs));
      setKeepaliveSecs(String(defaultKeepaliveSecs));
      setTermType(defaultTermType || "xterm-256color");
      setJumpHosts([]);
      setCostCycle("monthly");
      setCostCurrency("CNY");
      setCostAmount("");
      setExpiresAt("");
    }
    setEditingCredId(null);
    setCredName("");
    setCredUsername("");
    setCredKind("password");
    setCredKeyPath(defaultKeyPath);
    setCredSecret("");
    setPassword("");
    setShowPassword(false);
    setTestResult(null);
    setFormError(null);
    setSaving(false);
    setPasteText("");
    setBatchImporting(false);
    setConfirmDeleteCredId(null);
    return () => {
      cancelled = true;
    };
  }, [
    open,
    initial,
    defaultPort,
    defaultKeyPath,
    defaultTimeoutSecs,
    defaultKeepaliveSecs,
    defaultTermType,
    defaultAuthPriority,
    defaultGroup,
    loadCredentials,
  ]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving && !batchImporting) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, saving, batchImporting, onClose]);

  const parsedCandidates = useMemo(
    () => (pasteText.trim() ? parseServerText(pasteText) : []),
    [pasteText]
  );

  const sshServerMap = useMemo(() => {
    const map = new Map<string, Server>();
    for (const s of availableServers) {
      if ((s.protocol ?? "ssh") === "ssh") {
        map.set(s.id, s);
      }
    }
    return map;
  }, [availableServers]);

  const selectableJumpServers = useMemo(() => {
    const selfId = initial?.id;
    return availableServers.filter(
      (s) =>
        (s.protocol ?? "ssh") === "ssh" &&
        s.id !== selfId &&
        !jumpHosts.includes(s.id)
    );
  }, [availableServers, initial?.id, jumpHosts]);

  if (!open) return null;

  const promoteStage = (stage: AuthStage) => {
    setAuthPriority((prev) => [
      stage,
      ...prev.filter((item) => item !== stage),
    ]);
  };

  const handleAuthTabChange = (next: AuthTabType) => {
    setAuthType(next);
    setTestResult(null);
    if (
      next === "password" ||
      next === "key" ||
      next === "credential" ||
      next === "keyboard_interactive"
    ) {
      promoteStage(next);
    } else if (next === "ask") {
      promoteStage(askKeyPath.trim() ? "key" : "password");
    }
  };

  const movePriorityStage = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= authPriority.length) return;
    setAuthPriority((prev) => {
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
  };

  const moveJumpHost = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= jumpHosts.length) return;
    setJumpHosts((prev) => {
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
  };

  const removeJumpHost = (id: string) => {
    setJumpHosts((prev) => prev.filter((item) => item !== id));
  };

  const openNewCredentialEditor = () => {
    setEditingCredId(null);
    setCredName("");
    setCredUsername(username.trim() || "root");
    setCredKind("password");
    setCredKeyPath(defaultKeyPath);
    setCredSecret("");
    setCredEditorOpen(true);
  };

  const openEditCredentialEditor = (cred: Credential) => {
    setEditingCredId(cred.id);
    setCredName(cred.name);
    setCredUsername(cred.username ?? "");
    setCredKind(cred.kind);
    setCredKeyPath(cred.key_path || defaultKeyPath);
    setCredSecret("");
    setCredEditorOpen(true);
  };

  const saveCredentialInline = async (): Promise<string | null> => {
    const trimmedName =
      credName.trim() ||
      `${credUsername.trim() || username.trim() || "root"}@${host.trim() || "通用凭证"}`;
    setSavingCred(true);
    try {
      const cred: Credential = {
        id: editingCredId ?? crypto.randomUUID(),
        name: trimmedName,
        username: credUsername.trim() || undefined,
        kind: credKind,
        key_path:
          credKind === "key"
            ? credKeyPath.trim() || defaultKeyPath
            : undefined,
        updated_at: Math.floor(Date.now() / 1000),
      };
      const saved = await invoke<Credential>("credentials_upsert", {
        credential: cred,
        secret: credSecret || null,
      });
      await loadCredentials();
      setSelectedCredentialId(saved.id);
      if (saved.username && (!username.trim() || username === "root")) {
        setUsername(saved.username);
      }
      setCredEditorOpen(false);
      setEditingCredId(null);
      setCredSecret("");
      setFormError(null);
      return saved.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFormError(`保存登录凭证失败：${msg}`);
      return null;
    } finally {
      setSavingCred(false);
    }
  };

  const handleDeleteCredential = async (id: string) => {
    if (confirmDeleteCredId !== id) {
      setConfirmDeleteCredId(id);
      return;
    }
    setConfirmDeleteCredId(null);
    setFormError(null);
    try {
      await invoke("credentials_delete", { id });
      const list = await loadCredentials();
      if (selectedCredentialId === id) {
        setSelectedCredentialId(list[0]?.id ?? "");
      }
      if (list.length === 0) {
        openNewCredentialEditor();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFormError(`删除登录凭证失败：${msg}`);
    }
  };

  const handlePasteChange = (raw: string) => {
    setPasteText(raw);
    const list = parseServerText(raw);
    if (list.length > 0) {
      const first = list[0];
      if (first.protocol) handleProtocolChange(first.protocol);
      if (first.name) setName(first.name);
      if (first.host) setHost(first.host);
      if (first.port) setPort(String(first.port));
      if (first.username) setUsername(first.username);
      if (first.password) {
        handleAuthTabChange("password");
        setPassword(first.password);
      }
    }
  };

  const handleBatchImport = async () => {
    if (parsedCandidates.length === 0 || batchImporting) return;
    setBatchImporting(true);
    try {
      const servers: Server[] = [];
      const secrets: Record<string, string> = {};
      for (const c of parsedCandidates) {
        const base = candidateToServer(c);
        const srv = group.trim() ? { ...base, group: group.trim() } : base;
        servers.push(srv);
        if (c.password) {
          secrets[srv.id] = c.password;
        }
      }
      await invoke<number>("servers_import", {
        servers,
        secrets: Object.keys(secrets).length > 0 ? secrets : null,
      });
      onBatchImported?.();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFormError(`批量导入失败：${msg}`);
    } finally {
      setBatchImporting(false);
    }
  };

  const defaultPortFor = (p: Protocol) =>
    p === "vnc" ? 5900 : p === "rdp" ? 3389 : defaultPort;

  const handleProtocolChange = (next: Protocol) => {
    if (next === protocol) return;
    setProtocol(next);
    setTestResult(null);
    if (!initial) {
      setPort(String(defaultPortFor(next)));
      if (next === "vnc") {
        setUsername("");
      } else if (next === "rdp") {
        setUsername((u) => (u === "" || u === "root" ? "Administrator" : u));
      } else {
        setUsername((u) => (u === "" || u === "Administrator" ? "root" : u));
      }
    }
    if (next !== "ssh") {
      setAuthType("password");
    }
  };

  const parsedPort = Number.parseInt(port, 10);
  const effectivePort =
    Number.isFinite(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
      ? parsedPort
      : defaultPortFor(protocol);

  const parsedTimeout = Number.parseInt(timeoutSecs, 10);
  const effectiveTimeout =
    Number.isFinite(parsedTimeout) && parsedTimeout >= 1 && parsedTimeout <= 300
      ? parsedTimeout
      : defaultTimeoutSecs;

  const parsedKeepalive = Number.parseInt(keepaliveSecs, 10);
  const effectiveKeepalive =
    Number.isFinite(parsedKeepalive) &&
    parsedKeepalive >= 0 &&
    parsedKeepalive <= 3600
      ? parsedKeepalive
      : defaultKeepaliveSecs;

  const resolveCurrentAuthMethod = async (): Promise<AuthMethod | null> => {
    if (protocol !== "ssh") {
      return { type: "password" };
    }
    switch (authType) {
      case "password":
        return { type: "password" };
      case "key":
        return { type: "key", path: keyPath.trim() || defaultKeyPath };
      case "credential": {
        let cid = selectedCredentialId;
        if (credEditorOpen || !cid) {
          const savedId = await saveCredentialInline();
          if (!savedId) return null;
          cid = savedId;
        } else if (!credentials.some((c) => c.id === cid)) {
          setFormError("原关联的登录凭证已被删除，请重新选择或新建凭证");
          return null;
        }
        return { type: "credential", credential_id: cid };
      }
      case "keyboard_interactive":
        return { type: "keyboard_interactive" };
      case "ask":
        return {
          type: "ask",
          key_path: askKeyPath.trim() || undefined,
        };
    }
  };

  const handleTest = async (acceptHostKey?: string) => {
    if (!host.trim() || !username.trim() || testing) return;
    setTesting(true);
    setTestResult(null);
    setFormError(null);
    try {
      const authMethod = await resolveCurrentAuthMethod();
      if (!authMethod) {
        setTestResult({ ok: false, error: "请先选择或创建有效的登录凭证" });
        setTesting(false);
        return;
      }
      const authPayload = buildSshAuthPayload(authMethod, {
        password: password || undefined,
        passphrase: password || undefined,
      });
      const ms = await invoke<number>("ssh_test", {
        cfg: {
          server_id: initial?.id ?? null,
          host: host.trim(),
          port: effectivePort,
          username: username.trim(),
          auth: authPayload,
          auth_priority: authPriority,
          timeout_secs: effectiveTimeout,
          keepalive_secs: effectiveKeepalive,
          jump_hosts: jumpHosts,
          term_type: termType.trim() || "xterm-256color",
          accept_host_key: acceptHostKey ?? null,
        },
      });
      setTestResult({ ok: true, ms });
    } catch (err) {
      const parsed = parseCmdError(err);
      if (parsed.kind === "host_key_unknown" && parsed.fingerprint) {
        const hostPort = parsed.host || `${host.trim()}:${effectivePort}`;
        setTestResult({
          ok: false,
          error:
            parsed.message ||
            `首次连接主机 ${hostPort}，需信任指纹：${parsed.fingerprint}`,
          unknownHostKey: {
            hostPort,
            fingerprint: parsed.fingerprint,
          },
        });
        return;
      }
      setTestResult({ ok: false, error: parsed.message });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (!host.trim()) return;
    if (protocol !== "vnc" && !username.trim()) return;

    setSaving(true);
    setFormError(null);
    try {
      const authMethod = await resolveCurrentAuthMethod();
      if (!authMethod) return;

      const effectiveUser = username.trim();
      const fallbackName = effectiveUser
        ? `${effectiveUser}@${host.trim()}`
        : `${protocol.toUpperCase()} ${host.trim()}`;

      const parsedCostAmount = Number.parseFloat(costAmount);
      const parsedCost: ServerCost | undefined =
        Number.isFinite(parsedCostAmount) && parsedCostAmount > 0
          ? {
              amount: parsedCostAmount,
              cycle: costCycle,
              currency: costCurrency,
            }
          : undefined;

      const server: Server = {
        id: initial?.id ?? crypto.randomUUID(),
        name: name.trim() || fallbackName,
        protocol,
        host: host.trim(),
        port: effectivePort,
        username: effectiveUser,
        domain: protocol === "rdp" ? domain.trim() || undefined : undefined,
        auth: authMethod,
        auth_priority: protocol === "ssh" ? authPriority : undefined,
        timeout_secs: protocol === "ssh" ? effectiveTimeout : undefined,
        keepalive_secs: protocol === "ssh" ? effectiveKeepalive : undefined,
        jump_hosts: protocol === "ssh" ? jumpHosts : undefined,
        term_type:
          protocol === "ssh"
            ? termType.trim() || "xterm-256color"
            : undefined,
        group: group.trim() || undefined,
        provider: provider === "auto" ? undefined : provider,
        region: region.trim() || undefined,
        os: initial?.os,
        tags: initial?.tags ?? [],
        cost: parsedCost,
        expires_at: expiresAt.trim() || undefined,
        updated_at: Math.floor(Date.now() / 1000),
      };

      // Never persist secret when auth mode is "ask" (每次询问) or "credential" (already stored under cred:<id>)
      const secretToSave =
        authMethod.type === "ask" || authMethod.type === "credential"
          ? ""
          : password;

      const savedOk = await onSave(server, secretToSave);
      if (savedOk === false) {
        return;
      }
      setPassword("");
      setShowPassword(false);
      setTestResult(null);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const authIndex = Math.max(
    0,
    AUTH_TAB_OPTIONS.findIndex((item) => item.id === authType)
  );
  const protocolIndex = protocol === "ssh" ? 0 : protocol === "vnc" ? 1 : 2;
  const costCycleIndex = Math.max(
    0,
    BILLING_CYCLE_OPTIONS.findIndex((item) => item.id === costCycle)
  );
  const previewCostAmount = Number.parseFloat(costAmount);
  const previewDailyCost =
    Number.isFinite(previewCostAmount) && previewCostAmount > 0
      ? calcDailyCost({
          amount: previewCostAmount,
          cycle: costCycle,
          currency: costCurrency,
        })
      : null;

  const selectedCredential = credentials.find(
    (c) => c.id === selectedCredentialId
  );
  const isMissingCredential =
    Boolean(selectedCredentialId) && !selectedCredential;

  return (
    <div className="motion-backdrop fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="motion-modal max-h-[88vh] w-full max-w-[840px] overflow-y-auto rounded-[24px] bg-card px-6 py-5 shadow-[0_0_0_1px_var(--color-border),0_24px_60px_rgb(0_0_0/.12)]">
        <div className="mb-3.5 flex items-center justify-between">
          <h2 className="text-[17px] font-semibold tracking-tight text-card-foreground">
            {initial ? "编辑服务器" : "添加服务器"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="motion-press grid h-[28px] w-[28px] place-items-center rounded-full bg-muted text-muted-foreground hover:opacity-80"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3.5">
          {!initial && (
            <div className="rounded-[14px] border border-border/80 bg-muted/45 px-3 py-2.5">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
                  <ClipboardPaste className="h-3.5 w-3.5 text-primary" />
                  <span>智能粘贴识别</span>
                  <span className="text-[11px] font-normal text-muted-foreground">
                    SSH 命令 / 键值对 / URI / JSON
                  </span>
                </div>
                {onOpenImport && (
                  <button
                    type="button"
                    onClick={onOpenImport}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                  >
                    <FileInput className="h-3 w-3" />
                    <span>~/.ssh/config</span>
                  </button>
                )}
              </div>
              <textarea
                rows={2}
                value={pasteText}
                onChange={(e) => handlePasteChange(e.target.value)}
                placeholder="粘贴连接信息自动填充：如 ssh root@1.2.3.4 -p 22、ssh://root:pwd@ip:22、名称/地址/端口/用户/密码 或 JSON"
                className="w-full resize-none rounded-[10px] bg-background/80 px-2.5 py-1.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:ring-1 focus:ring-primary/50"
              />
              {parsedCandidates.length > 0 && (
                <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px]">
                  <span className="flex items-center gap-1 truncate text-emerald-600 dark:text-emerald-400">
                    <Sparkles className="h-3 w-3 shrink-0" />
                    <span className="truncate">
                      已识别 {parsedCandidates.length} 台：{parsedCandidates[0].username}@
                      {parsedCandidates[0].host}:{parsedCandidates[0].port}
                    </span>
                  </span>
                  {parsedCandidates.length > 1 && (
                    <button
                      type="button"
                      disabled={batchImporting}
                      onClick={() => void handleBatchImport()}
                      className="motion-press shrink-0 rounded-[8px] bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      {batchImporting
                        ? "导入中..."
                        : `一键批量导入 ${parsedCandidates.length} 台`}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Two-Column Desktop Layout */}
          <div className="grid grid-cols-1 gap-x-5 gap-y-3 md:grid-cols-2">
            {/* Left Column: Connection, Jump Chain & Terminal Parameters */}
            <div className="space-y-2.5">
              <div>
                <label className="mb-1 block text-[11.5px] font-medium text-muted-foreground">
                  连接协议
                </label>
                <div className="relative grid h-8 grid-cols-3 rounded-[9px] bg-muted p-[2px]">
                  <div
                    className="pointer-events-none absolute bottom-[2px] left-[2px] top-[2px] w-[calc((100%-4px)/3)] rounded-[7px] bg-background shadow-[0_2px_6px_rgb(0_0_0/.10)] transition-transform duration-300 [transition-timing-function:var(--ease-apple)]"
                    style={{ transform: `translateX(${protocolIndex * 100}%)` }}
                  />
                  {(["ssh", "vnc", "rdp"] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => handleProtocolChange(p)}
                      className={`relative z-10 text-[12.5px] tracking-wide uppercase text-foreground ${
                        protocol === p ? "font-semibold" : "font-medium opacity-75"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1 block text-[11.5px] font-medium text-muted-foreground">
                  显示名称
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：生产 Web-01"
                  className="h-9 w-full rounded-[10px] bg-muted px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className="mb-1 block text-[11.5px] font-medium text-muted-foreground">
                    主机 / IP *
                  </label>
                  <input
                    type="text"
                    required
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="192.168.1.10"
                    className="h-9 w-full rounded-[10px] bg-muted px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11.5px] font-medium text-muted-foreground">
                    端口
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    className="h-9 w-full rounded-[10px] bg-muted px-3 text-[13px] tabular-nums text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[11.5px] font-medium text-muted-foreground">
                    {protocol === "vnc" ? "用户名（可选）" : "用户名 *"}
                  </label>
                  <input
                    type="text"
                    required={protocol !== "vnc"}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={protocol === "vnc" ? "通常留空" : ""}
                    className="h-9 w-full rounded-[10px] bg-muted px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11.5px] font-medium text-muted-foreground">
                    分组
                  </label>
                  <input
                    type="text"
                    value={group}
                    onChange={(e) => setGroup(e.target.value)}
                    placeholder="例如：Production"
                    className="h-9 w-full rounded-[10px] bg-muted px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
                  />
                </div>
              </div>

              {protocol === "rdp" && (
                <div>
                  <label className="mb-1 block text-[11.5px] font-medium text-muted-foreground">
                    域（可选）
                  </label>
                  <input
                    type="text"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder="例如：CORP"
                    className="h-9 w-full rounded-[10px] bg-muted px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
                  />
                </div>
              )}

              {availableGroups.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {availableGroups.map((g) => {
                    const active = group.trim() === g;
                    return (
                      <button
                        key={g}
                        type="button"
                        onClick={() => setGroup(active ? "" : g)}
                        className={`rounded-[6px] px-2 py-0.5 text-[11px] font-medium transition-colors duration-150 ${
                          active
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {g}
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[11.5px] font-medium text-muted-foreground">
                    云厂商 / 图标
                  </label>
                  <select
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    className="h-9 w-full rounded-[10px] bg-muted px-2.5 text-[13px] text-foreground outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    {CLOUD_PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[11.5px] font-medium text-muted-foreground">
                    地域 / 国家（留空自动）
                  </label>
                  <input
                    type="text"
                    list="server-region-presets"
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    placeholder="例如：中国台湾 / 日本"
                    className="h-9 w-full rounded-[10px] bg-muted px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
                  />
                  <datalist id="server-region-presets">
                    {REGION_PRESETS.map((r) => (
                      <option key={r} value={r} />
                    ))}
                  </datalist>
                </div>
              </div>

              {/* SSH Connection Parameters: 超时时间 / 心跳时间 / 终端类型 / 跳板机链路 */}
              {protocol === "ssh" && (
                <div className="space-y-2.5 rounded-[14px] bg-muted/45 p-3">
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                        超时时间 (秒)
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={300}
                        value={timeoutSecs}
                        onChange={(e) => setTimeoutSecs(e.target.value)}
                        placeholder="10"
                        className="h-8 w-full rounded-[8px] bg-muted px-2.5 text-[12px] tabular-nums text-foreground outline-none focus:ring-2 focus:ring-primary/40"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                        心跳时间 (秒)
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={3600}
                        value={keepaliveSecs}
                        onChange={(e) => setKeepaliveSecs(e.target.value)}
                        placeholder="20 (0=关闭)"
                        title="SSH Keepalive 发送间隔，设为 0 关闭心跳"
                        className="h-8 w-full rounded-[8px] bg-muted px-2.5 text-[12px] tabular-nums text-foreground outline-none focus:ring-2 focus:ring-primary/40"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                        终端类型
                      </label>
                      <select
                        value={termType}
                        onChange={(e) => setTermType(e.target.value)}
                        className="h-8 w-full rounded-[8px] bg-muted px-2 font-mono text-[11.5px] text-foreground outline-none focus:ring-2 focus:ring-primary/40"
                      >
                        {TERMINAL_TYPE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.value}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Jump Host Chain (跳板机链路) */}
                  <div className="border-t border-border/50 pt-2">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="flex items-center gap-1 text-[11.5px] font-medium text-muted-foreground">
                        <Network className="h-3.5 w-3.5 text-primary" />
                        <span>跳板机链路 (ProxyJump)</span>
                      </span>
                      {jumpHosts.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setJumpHosts([])}
                          className="text-[11px] text-muted-foreground hover:text-destructive"
                        >
                          清空链路
                        </button>
                      )}
                    </div>

                    {jumpHosts.length > 0 && (
                      <div className="mb-2 space-y-1">
                        {jumpHosts.map((hopId, idx) => {
                          const hopSrv = sshServerMap.get(hopId);
                          return (
                            <div
                              key={hopId}
                              className="flex items-center justify-between gap-2 rounded-[8px] bg-background/85 px-2.5 py-1.5 text-[11.5px] shadow-2xs ring-1 ring-border/60"
                            >
                              <div className="flex min-w-0 items-center gap-1.5">
                                <span className="inline-flex h-4 shrink-0 items-center rounded bg-primary/15 px-1.5 font-mono text-[10px] font-semibold text-primary">
                                  跳板 #{idx + 1}
                                </span>
                                <span className="truncate font-medium text-foreground">
                                  {hopSrv ? hopSrv.name : `未知节点 (${hopId.slice(0, 8)})`}
                                </span>
                                {hopSrv && (
                                  <span className="truncate font-mono text-[10.5px] text-muted-foreground">
                                    {hopSrv.username}@{hopSrv.host}:{hopSrv.port}
                                  </span>
                                )}
                              </div>
                              <div className="flex shrink-0 items-center gap-0.5">
                                <button
                                  type="button"
                                  disabled={idx === 0}
                                  onClick={() => moveJumpHost(idx, -1)}
                                  title="前移跳板顺序"
                                  className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-25"
                                >
                                  <ChevronUp className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  disabled={idx === jumpHosts.length - 1}
                                  onClick={() => moveJumpHost(idx, 1)}
                                  title="后移跳板顺序"
                                  className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-25"
                                >
                                  <ChevronDown className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => removeJumpHost(hopId)}
                                  title="移除该跳板机"
                                  className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                        <div className="px-1 text-[10.5px] text-muted-foreground">
                          链路顺序：本机 →{" "}
                          {jumpHosts
                            .map(
                              (id, i) =>
                                sshServerMap.get(id)?.name ?? `跳板${i + 1}`
                            )
                            .join(" → ")}{" "}
                          → {name.trim() || host.trim() || "目标主机"}
                        </div>
                      </div>
                    )}

                    <select
                      value=""
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val && !jumpHosts.includes(val)) {
                          setJumpHosts((prev) => [...prev, val]);
                        }
                      }}
                      className="h-8 w-full rounded-[8px] bg-muted px-2.5 text-[12px] text-foreground outline-none focus:ring-2 focus:ring-primary/40"
                    >
                      <option value="">
                        {selectableJumpServers.length > 0
                          ? "+ 添加跳板机节点（支持多级串联）..."
                          : jumpHosts.length > 0
                            ? "已添加所有可用 SSH 节点"
                            : "暂无其他 SSH 服务器可作为跳板机"}
                      </option>
                      {selectableJumpServers.map((srv) => (
                        <option key={srv.id} value={srv.id}>
                          {srv.name} ({srv.username}@{srv.host}:{srv.port})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>

            {/* Right Column: Auth Method, Auth Priority & Cost/Expiration */}
            <div className="space-y-2.5">
              {protocol === "ssh" && (
                <div>
                  <label className="mb-1 block text-[11.5px] font-medium text-muted-foreground">
                    认证方式
                  </label>
                  <div className="relative grid h-8 grid-cols-5 rounded-[9px] bg-muted p-[2px]">
                    <div
                      className="pointer-events-none absolute bottom-[2px] left-[2px] top-[2px] w-[calc((100%-4px)/5)] rounded-[7px] bg-background shadow-[0_2px_6px_rgb(0_0_0/.10)] transition-transform duration-300 [transition-timing-function:var(--ease-apple)]"
                      style={{ transform: `translateX(${authIndex * 100}%)` }}
                    />
                    {AUTH_TAB_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => handleAuthTabChange(opt.id)}
                        className={`relative z-10 truncate px-1 text-[11.5px] text-foreground ${
                          authType === opt.id
                            ? "font-semibold"
                            : "font-medium opacity-75"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Auth Mode Specific Fields */}
              {(protocol !== "ssh" || authType === "password") && (
                <div>
                  <label className="mb-1 block text-[11.5px] font-medium text-muted-foreground">
                    密码{initial ? "（留空保持不变）" : "（可选，也可连接时输入）"}
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="输入登录密码"
                      className="h-9 w-full rounded-[10px] bg-muted py-1.5 pr-9 pl-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute inset-y-0 right-2.5 flex items-center text-muted-foreground hover:text-foreground"
                      tabIndex={-1}
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>
              )}

              {protocol === "ssh" && authType === "key" && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-[11.5px] font-medium text-muted-foreground">
                      私钥路径
                    </label>
                    <input
                      type="text"
                      value={keyPath}
                      onChange={(e) => setKeyPath(e.target.value)}
                      placeholder="~/.ssh/id_ed25519"
                      className="h-9 w-full rounded-[10px] bg-muted px-3 font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11.5px] font-medium text-muted-foreground">
                      私钥口令（可选）
                    </label>
                    <div className="relative">
                      <input
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="有口令请填写"
                        className="h-9 w-full rounded-[10px] bg-muted py-1.5 pr-8 pl-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
                        tabIndex={-1}
                      >
                        {showPassword ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {protocol === "ssh" && authType === "credential" && (
                <div className="space-y-2 rounded-[12px] border border-border/70 bg-muted/40 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-foreground">
                      <KeyRound className="h-3.5 w-3.5 text-primary" />
                      <span>选择或管理登录凭证</span>
                    </span>
                    {(!credEditorOpen || credentials.length > 0) && (
                      <button
                        type="button"
                        onClick={() => {
                          if (credEditorOpen) {
                            setCredEditorOpen(false);
                          } else {
                            openNewCredentialEditor();
                          }
                        }}
                        className="inline-flex items-center gap-1 rounded-[6px] bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/20"
                      >
                        <Plus className="h-3 w-3" />
                        <span>{credEditorOpen ? "返回选择" : "新建凭证"}</span>
                      </button>
                    )}
                  </div>

                  {!credEditorOpen && credentials.length > 0 ? (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <select
                          value={selectedCredentialId}
                          onChange={(e) => {
                            const nextId = e.target.value;
                            setSelectedCredentialId(nextId);
                            setConfirmDeleteCredId(null);
                            setFormError(null);
                            const found = credentials.find((c) => c.id === nextId);
                            if (found?.username) {
                              setUsername(found.username);
                            }
                          }}
                          className={`h-8 min-w-0 flex-1 rounded-[8px] bg-background px-2.5 text-[12.5px] text-foreground outline-none ring-1 focus:ring-2 focus:ring-primary/40 ${
                            isMissingCredential
                              ? "ring-amber-500/70"
                              : "ring-border/70"
                          }`}
                        >
                          {isMissingCredential && (
                            <option value={selectedCredentialId} disabled>
                              ⚠ 原关联凭证已删除，请重新选择
                            </option>
                          )}
                          {credentials.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name} (
                              {c.kind === "key"
                                ? `私钥: ${c.key_path || "~/.ssh/id_ed25519"}`
                                : "密码凭证"}
                              {c.username ? ` · 用户: ${c.username}` : ""})
                            </option>
                          ))}
                        </select>
                        {selectedCredential && (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                openEditCredentialEditor(selectedCredential)
                              }
                              title="编辑该登录凭证"
                              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-background text-muted-foreground ring-1 ring-border/70 hover:text-foreground"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                void handleDeleteCredential(selectedCredential.id)
                              }
                              onBlur={() => setConfirmDeleteCredId(null)}
                              title={
                                confirmDeleteCredId === selectedCredential.id
                                  ? "再次点击确认删除该登录凭证"
                                  : "删除该登录凭证"
                              }
                              className={`inline-flex h-8 shrink-0 items-center justify-center rounded-[8px] ring-1 transition ${
                                confirmDeleteCredId === selectedCredential.id
                                  ? "bg-destructive px-2 text-[11px] font-medium text-destructive-foreground ring-destructive"
                                  : "w-8 bg-background text-muted-foreground ring-border/70 hover:text-destructive"
                              }`}
                            >
                              {confirmDeleteCredId === selectedCredential.id ? (
                                <span>确认删?</span>
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </>
                        )}
                      </div>
                      {selectedCredential && (
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          <span>
                            类型：
                            {selectedCredential.kind === "key"
                              ? `SSH 私钥 (${selectedCredential.key_path || "~/.ssh/id_ed25519"})`
                              : "密码凭证"}
                          </span>
                          {selectedCredential.username && (
                            <span>· 默认账号：{selectedCredential.username}</span>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2 rounded-[10px] bg-background/85 p-2.5 ring-1 ring-border/60">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="mb-0.5 block text-[11px] text-muted-foreground">
                            凭证名称 *
                          </label>
                          <input
                            type="text"
                            value={credName}
                            onChange={(e) => setCredName(e.target.value)}
                            placeholder="例如：生产统一凭证"
                            className="h-8 w-full rounded-[8px] bg-muted px-2.5 text-[12px] text-foreground outline-none focus:ring-1 focus:ring-primary/50"
                          />
                        </div>
                        <div>
                          <label className="mb-0.5 block text-[11px] text-muted-foreground">
                            默认用户名（可选）
                          </label>
                          <input
                            type="text"
                            value={credUsername}
                            onChange={(e) => setCredUsername(e.target.value)}
                            placeholder="例如：root / deploy"
                            className="h-8 w-full rounded-[8px] bg-muted px-2.5 text-[12px] text-foreground outline-none focus:ring-1 focus:ring-primary/50"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <label className="mb-0.5 block text-[11px] text-muted-foreground">
                            凭证类型
                          </label>
                          <select
                            value={credKind}
                            onChange={(e) =>
                              setCredKind(e.target.value as CredentialKind)
                            }
                            className="h-8 w-full rounded-[8px] bg-muted px-2 text-[12px] text-foreground outline-none focus:ring-1 focus:ring-primary/50"
                          >
                            <option value="password">密码</option>
                            <option value="key">SSH 私钥</option>
                          </select>
                        </div>
                        {credKind === "key" ? (
                          <>
                            <div>
                              <label className="mb-0.5 block text-[11px] text-muted-foreground">
                                私钥路径
                              </label>
                              <input
                                type="text"
                                value={credKeyPath}
                                onChange={(e) => setCredKeyPath(e.target.value)}
                                placeholder="~/.ssh/id_ed25519"
                                className="h-8 w-full rounded-[8px] bg-muted px-2 font-mono text-[11.5px] text-foreground outline-none focus:ring-1 focus:ring-primary/50"
                              />
                            </div>
                            <div>
                              <label className="mb-0.5 block text-[11px] text-muted-foreground">
                                私钥口令（可选）
                              </label>
                              <input
                                type="password"
                                value={credSecret}
                                onChange={(e) => setCredSecret(e.target.value)}
                                placeholder="无口令留空"
                                className="h-8 w-full rounded-[8px] bg-muted px-2 text-[12px] text-foreground outline-none focus:ring-1 focus:ring-primary/50"
                              />
                            </div>
                          </>
                        ) : (
                          <div className="col-span-2">
                            <label className="mb-0.5 block text-[11px] text-muted-foreground">
                              凭证密码{editingCredId ? "（留空保持不变）" : ""}
                            </label>
                            <input
                              type="password"
                              value={credSecret}
                              onChange={(e) => setCredSecret(e.target.value)}
                              placeholder="输入凭证密码（加密保存在密钥库）"
                              className="h-8 w-full rounded-[8px] bg-muted px-2.5 text-[12px] text-foreground outline-none focus:ring-1 focus:ring-primary/50"
                            />
                          </div>
                        )}
                      </div>
                      <div className="flex justify-end gap-1.5 pt-0.5">
                        {credentials.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setCredEditorOpen(false)}
                            className="h-7 rounded-[7px] bg-muted px-2.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                          >
                            取消
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={savingCred}
                          onClick={() => void saveCredentialInline()}
                          className="inline-flex h-7 items-center gap-1 rounded-[7px] bg-primary px-3 text-[11px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
                        >
                          <Check className="h-3 w-3" />
                          <span>{editingCredId ? "更新凭证" : "保存并选用"}</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {protocol === "ssh" && authType === "keyboard_interactive" && (
                <div className="space-y-2 rounded-[12px] border border-border/70 bg-muted/40 p-2.5">
                  <div className="text-[11.5px] leading-relaxed text-muted-foreground">
                    使用 SSH <span className="font-mono">keyboard-interactive</span>{" "}
                    挑战应答协议（适用于 PAM 认证、一次性动态口令 2FA/OTP 或堡垒机交互登录）。
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                      预设交互密码 / 应答（可选，留空则在连接时弹窗询问）
                    </label>
                    <div className="relative">
                      <input
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder={
                          initial
                            ? "留空保持原配置或连接时交互输入"
                            : "可选填预设应答密码，或留空在连接时输入 OTP"
                        }
                        className="h-8 w-full rounded-[8px] bg-background py-1 pr-8 pl-2.5 text-[12.5px] text-foreground outline-none ring-1 ring-border/70 focus:ring-2 focus:ring-primary/40"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
                        tabIndex={-1}
                      >
                        {showPassword ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {protocol === "ssh" && authType === "ask" && (
                <div className="space-y-2 rounded-[12px] border border-amber-500/30 bg-amber-500/8 p-2.5">
                  <div className="flex items-start gap-2 text-[11.5px] leading-relaxed text-amber-700 dark:text-amber-300">
                    <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      每次建立连接时均弹窗询问登录密码或私钥口令，秘密仅在当次连接内存中使用，绝不写入本地密钥库。
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                        关联私钥路径（可选，留空则询问密码）
                      </label>
                      <input
                        type="text"
                        value={askKeyPath}
                        onChange={(e) => setAskKeyPath(e.target.value)}
                        placeholder="留空=询问密码，或 ~/.ssh/id_ed25519"
                        className="h-8 w-full rounded-[8px] bg-background px-2.5 font-mono text-[11.5px] text-foreground outline-none ring-1 ring-border/70 focus:ring-2 focus:ring-primary/40"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                        测试用临时密码（不保存）
                      </label>
                      <input
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="仅用于点击下方「测试连接」"
                        className="h-8 w-full rounded-[8px] bg-background px-2.5 text-[12px] text-foreground outline-none ring-1 ring-border/70 focus:ring-2 focus:ring-primary/40"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Auth Priority (认证方式优先级) */}
              {protocol === "ssh" && (
                <div className="space-y-1.5 rounded-[14px] bg-muted/45 p-3">
                  <div className="flex items-center justify-between">
                    <label className="text-[11.5px] font-medium text-muted-foreground">
                      认证方式优先级（按顺序尝试握手）
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        setAuthPriority([...DEFAULT_AUTH_PRIORITY])
                      }
                      title="恢复默认认证优先级"
                      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      <RotateCcw className="h-2.5 w-2.5" />
                      <span>默认顺序</span>
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {authPriority.map((stage, idx) => {
                      const meta = AUTH_STAGE_META[stage];
                      const isPrimary = idx === 0;
                      return (
                        <div
                          key={stage}
                          className={`flex items-center justify-between gap-1.5 rounded-[9px] px-2.5 py-1.5 text-[11.5px] transition ${
                            isPrimary
                              ? "bg-primary/12 text-foreground ring-1 ring-primary/35"
                              : "bg-background/80 text-foreground/85 ring-1 ring-border/60"
                          }`}
                        >
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span
                              className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-semibold ${
                                isPrimary
                                  ? "bg-primary text-primary-foreground"
                                  : "bg-muted text-muted-foreground"
                              }`}
                            >
                              {idx + 1}
                            </span>
                            <span
                              className="truncate font-medium"
                              title={meta.desc}
                            >
                              {meta.label}
                            </span>
                          </div>
                          <div className="flex shrink-0 items-center gap-0.5">
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => movePriorityStage(idx, -1)}
                              title="提高优先级"
                              className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-25"
                            >
                              <ArrowUp className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              disabled={idx === authPriority.length - 1}
                              onClick={() => movePriorityStage(idx, 1)}
                              title="降低优先级"
                              className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-25"
                            >
                              <ArrowDown className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Server Cost & Expiration */}
              <div className="space-y-2 rounded-[14px] bg-muted/45 p-3">
                <div className="flex items-center justify-between">
                  <label className="text-[12px] font-medium text-muted-foreground">
                    服务器成本（可选）
                  </label>
                  {previewDailyCost !== null && (
                    <span className="text-[11.5px] font-medium tabular-nums text-primary">
                      {formatMoney(previewDailyCost, costCurrency)}/天
                    </span>
                  )}
                </div>
                <div className="relative grid h-8 grid-cols-4 rounded-[8px] bg-muted p-[2px]">
                  <div
                    className="pointer-events-none absolute bottom-[2px] left-[2px] top-[2px] w-[calc((100%-4px)/4)] rounded-[6px] bg-background shadow-[0_2px_6px_rgb(0_0_0/.10)] transition-transform duration-300 [transition-timing-function:var(--ease-apple)]"
                    style={{ transform: `translateX(${costCycleIndex * 100}%)` }}
                  />
                  {BILLING_CYCLE_OPTIONS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setCostCycle(item.id)}
                      className={`relative z-10 text-[11.5px] text-foreground ${
                        costCycle === item.id ? "font-semibold" : "font-medium opacity-75"
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <select
                    value={costCurrency}
                    onChange={(e) => setCostCurrency(e.target.value)}
                    aria-label="货币单位"
                    className="h-9 rounded-[10px] bg-muted px-2 text-[12.5px] text-foreground outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    {CURRENCY_OPTIONS.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={costAmount}
                    onChange={(e) => setCostAmount(e.target.value)}
                    placeholder="输入费用（留空不计）"
                    className="col-span-2 h-9 rounded-[10px] bg-muted px-3 text-[12.5px] tabular-nums text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
                  />
                </div>
                {previewDailyCost !== null && (
                  <p className="text-[11px] tabular-nums text-muted-foreground">
                    折合月均 {formatMoney(previewDailyCost * 30, costCurrency)} · 年均{" "}
                    {formatMoney(previewDailyCost * 365, costCurrency)}
                  </p>
                )}
                <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-2">
                  <label className="shrink-0 text-[11.5px] font-medium text-muted-foreground">
                    到期时间（可选）
                  </label>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="date"
                      value={expiresAt}
                      onChange={(e) => setExpiresAt(e.target.value)}
                      className="h-8 rounded-[8px] bg-muted px-2 text-[11.5px] tabular-nums text-foreground outline-none focus:ring-2 focus:ring-primary/40"
                    />
                    {expiresAt && (
                      <button
                        type="button"
                        onClick={() => setExpiresAt("")}
                        className="rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
                      >
                        清除
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {formError && (
            <div className="motion-banner-enter rounded-[10px] bg-destructive/10 px-3.5 py-2 text-[12.5px] text-destructive">
              ✗ {formError}
            </div>
          )}

          {testResult && (
            <div
              className={`motion-banner-enter rounded-[10px] px-3.5 py-2 text-[12.5px] ${
                testResult.ok
                  ? "bg-emerald-500/10 text-emerald-500"
                  : "motion-shake bg-destructive/10 text-destructive"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {testResult.ok
                    ? `✓ 连接成功 · ${testResult.ms} ms`
                    : `✗ ${testResult.error}`}
                </span>
                {!testResult.ok && testResult.unknownHostKey && (
                  <button
                    type="button"
                    disabled={testing}
                    onClick={() =>
                      void handleTest(testResult.unknownHostKey?.fingerprint)
                    }
                    className="rounded-lg bg-primary px-2.5 py-1 text-[11.5px] font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
                  >
                    信任此主机指纹并重试测试
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
            <div className="flex min-w-0 items-center gap-2.5">
              {protocol === "ssh" && (
                <button
                  type="button"
                  onClick={() => void handleTest()}
                  disabled={testing || !host.trim() || !username.trim()}
                  className="motion-press inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] bg-muted px-3.5 text-[12.5px] font-semibold text-foreground hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {testing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  <span>{testing ? "测试中…" : "测试连接"}</span>
                </button>
              )}
              <p
                className="truncate text-[11px] text-muted-foreground"
                title="密码/私钥口令使用 AES-256-GCM 加密存储于本地密钥库，不会以明文写入磁盘；「每次询问」模式完全不落盘。"
              >
                {authType === "ask"
                  ? "当前为「每次询问」模式，密码/口令绝不落盘存储"
                  : "密码/私钥口令与登录凭证加密存储于密钥库，不落盘明文"}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                disabled={saving || batchImporting}
                onClick={onClose}
                className="motion-press h-9 rounded-[10px] bg-muted px-4 text-[12.5px] font-semibold text-foreground hover:bg-muted/80 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={saving || batchImporting}
                className="motion-press h-9 rounded-[10px] bg-primary px-5 text-[12.5px] font-semibold text-primary-foreground hover:opacity-92 disabled:opacity-50"
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
