import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Circle,
  HelpCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { Server } from "../types";

export type Availability = "up" | "degraded" | "down" | "unknown";

export interface AvailabilityIncident {
  id: string;
  serverId: string;
  serverName: string;
  at: number;
  status: Availability;
  desc: string;
}

export interface ServerStatusRow {
  server: Server;
  current: Availability;
  history: Availability[];
  lastIncidentAt?: number;
}

interface ServerStatusBlockProps {
  rows: ServerStatusRow[];
  incidents: AvailabilityIncident[];
}

const STATUS_LABEL: Record<Availability, string> = {
  up: "正常",
  degraded: "降级",
  down: "故障",
  unknown: "未知",
};

function StatusIcon({ status }: { status: Availability }) {
  switch (status) {
    case "up":
      return <CheckCircle className="h-4 w-4 shrink-0 text-green-500" />;
    case "degraded":
      return <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />;
    case "down":
      return <Circle className="h-4 w-4 shrink-0 text-red-500" />;
    case "unknown":
      return (
        <HelpCircle className="text-muted-foreground h-4 w-4 shrink-0" />
      );
  }
}

function UptimeBar({ history }: { history: Availability[] }) {
  const total = 30;
  const trimmed = history.slice(-total);
  const padCount = Math.max(0, total - trimmed.length);

  return (
    <div className="mt-1 flex gap-0.5 overflow-hidden">
      {Array.from({ length: padCount }).map((_, i) => (
        <div
          key={`pad-${i}`}
          className="h-6 w-1.5 shrink-0 rounded-sm bg-muted"
          title="未探测"
        />
      ))}
      {trimmed.map((st, i) => {
        const cls =
          st === "up"
            ? "bg-green-400"
            : st === "degraded"
              ? "bg-amber-400"
              : st === "down"
                ? "bg-red-400"
                : "bg-muted-foreground/30";
        return (
          <div
            key={`sample-${i}`}
            className={`h-6 w-1.5 shrink-0 rounded-sm ${cls}`}
            title={STATUS_LABEL[st]}
          />
        );
      })}
    </div>
  );
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day} ${formatTime(ms)}`;
}

function calcAvailability(history: Availability[]): string {
  const known = history.filter((s) => s !== "unknown");
  if (known.length === 0) return "—";
  const ok = known.filter((s) => s === "up" || s === "degraded").length;
  return `${((ok / known.length) * 100).toFixed(2)}%`;
}

export function ServerStatusBlock({
  rows,
  incidents,
}: ServerStatusBlockProps) {
  const [showIncidents, setShowIncidents] = useState(false);

  const upCount = rows.filter((r) => r.current === "up").length;
  const degradedCount = rows.filter((r) => r.current === "degraded").length;
  const downCount = rows.filter((r) => r.current === "down").length;

  const allKnown = rows.flatMap((r) =>
    r.history.filter((s) => s !== "unknown")
  );
  const allOk = allKnown.filter((s) => s === "up" || s === "degraded").length;
  const totalRate =
    allKnown.length > 0
      ? `${((allOk / allKnown.length) * 100).toFixed(2)}%`
      : "—";

  return (
    <Card className="rounded-[22px] border-0 bg-card shadow-[0_0_0_0.5px_var(--color-border),0_8px_24px_rgb(0_0_0/0.04)]">
      <CardContent className="flex flex-col gap-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="text-[17px] font-semibold text-card-foreground">
                批量可用性
              </span>
              <span className="rounded-full bg-muted px-2.5 py-0.5 font-mono text-[13px] font-medium text-foreground">
                可用率 {totalRate}
              </span>
            </div>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              最近 30 次探测 · 每 3 秒一次
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <span className="text-emerald-500">正常 {upCount}</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-amber-500">降级 {degradedCount}</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-red-500">故障 {downCount}</span>
            </div>

            <Button
              size="sm"
              variant="secondary"
              className="rounded-[10px]"
              onClick={() => setShowIncidents((v) => !v)}
              aria-label={showIncidents ? "收起故障记录" : "展开故障记录"}
            >
              {showIncidents ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
              <span className="text-[13px]">
                {showIncidents ? "收起" : `故障记录 (${incidents.length})`}
              </span>
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-2">
          {rows.map((row) => (
            <div key={row.server.id} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-3 text-[15px]">
                <StatusIcon status={row.current} />
                <span className="font-semibold text-card-foreground">
                  {row.server.name}
                </span>
                <span className="text-[13px] text-muted-foreground">
                  {STATUS_LABEL[row.current]}
                </span>
                <span className="font-mono text-[13px] text-muted-foreground">
                  {calcAvailability(row.history)}
                </span>
                {row.lastIncidentAt && (
                  <span className="ml-auto font-mono text-[13px] text-muted-foreground">
                    最近故障: {formatTime(row.lastIncidentAt)}
                  </span>
                )}
              </div>
              <UptimeBar history={row.history} />
            </div>
          ))}
        </div>

        {showIncidents && (
          <div className="mt-1 flex flex-col gap-2 rounded-[14px] bg-muted p-4">
            <span className="mb-1 text-[15px] font-semibold text-card-foreground">
              故障记录
            </span>
            {incidents.length === 0 ? (
              <span className="text-[13px] text-muted-foreground">
                暂无故障记录
              </span>
            ) : (
              incidents.map((inc) => (
                <div
                  key={inc.id}
                  className="flex flex-col gap-1 border-t-[0.5px] border-border pt-2 first:border-t-0 first:pt-0"
                >
                  <div className="flex items-center gap-2 text-[13px] font-medium text-card-foreground">
                    <span>
                      {inc.serverName} - {formatDateTime(inc.at)}
                    </span>
                    <span
                      className={
                        inc.status === "up"
                          ? "text-emerald-500"
                          : inc.status === "degraded"
                            ? "text-amber-500"
                            : "text-red-500"
                      }
                    >
                      [{STATUS_LABEL[inc.status]}]
                    </span>
                  </div>
                  <span className="text-[13px] text-muted-foreground">
                    {inc.desc}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
