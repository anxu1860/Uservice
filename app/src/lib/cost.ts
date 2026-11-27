import type { BillingCycle, Server, ServerCost } from "../types";

export const BILLING_CYCLE_OPTIONS: {
  id: BillingCycle;
  label: string;
  shortLabel: string;
  days: number;
  perYear: number;
}[] = [
  { id: "monthly", label: "月付", shortLabel: "月", days: 30, perYear: 12 },
  { id: "quarterly", label: "季付", shortLabel: "季", days: 90, perYear: 4 },
  { id: "semiannual", label: "半年付", shortLabel: "半年", days: 180, perYear: 2 },
  { id: "annual", label: "年付", shortLabel: "年", days: 365, perYear: 1 },
];

export const CURRENCY_OPTIONS: {
  code: string;
  symbol: string;
  label: string;
}[] = [
  { code: "CNY", symbol: "¥", label: "CNY (¥)" },
  { code: "USD", symbol: "$", label: "USD ($)" },
  { code: "EUR", symbol: "€", label: "EUR (€)" },
];

const CURRENCY_ORDER = new Map(CURRENCY_OPTIONS.map((c, idx) => [c.code, idx]));

function normalizeCurrency(currency?: string): string {
  const norm = (currency ?? "").trim().toUpperCase();
  return norm || "CNY";
}

export function getBillingCycleMeta(cycle: BillingCycle) {
  return (
    BILLING_CYCLE_OPTIONS.find((item) => item.id === cycle) ??
    BILLING_CYCLE_OPTIONS[0]
  );
}

export function getCurrencySymbol(currency: string): string {
  const norm = normalizeCurrency(currency);
  return (
    CURRENCY_OPTIONS.find((item) => item.code === norm)?.symbol ??
    `${norm} `
  );
}

/** Calculate annualized cost in the server's configured currency using exact billing cycle counts. */
export function calcAnnualCost(cost: ServerCost): number {
  if (!Number.isFinite(cost.amount) || cost.amount <= 0) return 0;
  const { perYear } = getBillingCycleMeta(cost.cycle);
  return cost.amount * perYear;
}

/** Calculate daily cost in the server's configured currency (consistent with annualized cost / 365). */
export function calcDailyCost(cost: ServerCost): number {
  return calcAnnualCost(cost) / 365;
}

/** Format a monetary value with currency symbol. */
export function formatMoney(amount: number, currency: string): string {
  const symbol = getCurrencySymbol(currency);
  if (!Number.isFinite(amount) || amount <= 0) return `${symbol}0.00`;
  const decimals = amount < 0.01 ? 3 : 2;
  return `${symbol}${amount.toFixed(decimals)}`;
}

/** Format the configured cycle amount concisely, e.g. "¥50/月". */
export function formatCycleCost(cost: ServerCost): string {
  const { shortLabel } = getBillingCycleMeta(cost.cycle);
  const symbol = getCurrencySymbol(cost.currency);
  if (!Number.isFinite(cost.amount) || cost.amount <= 0) {
    return `${symbol}0/${shortLabel}`;
  }
  const formatted = Number.isInteger(cost.amount)
    ? String(cost.amount)
    : cost.amount.toFixed(2);
  return `${symbol}${formatted}/${shortLabel}`;
}

export interface CurrencyCostTotal {
  currency: string;
  daily: number;
  monthly: number;
  annual: number;
}

export interface OverallCostSummary {
  configuredCount: number;
  totals: CurrencyCostTotal[];
}

/** Aggregate daily, monthly (annual/12), and annual costs across servers grouped by currency. */
export function summarizeOverallCost(servers: Server[]): OverallCostSummary {
  const byCurrency = new Map<string, number>();
  let configuredCount = 0;

  for (const srv of servers) {
    if (!srv.cost || !Number.isFinite(srv.cost.amount) || srv.cost.amount <= 0) {
      continue;
    }
    configuredCount++;
    const currency = normalizeCurrency(srv.cost.currency);
    const annual = calcAnnualCost(srv.cost);
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + annual);
  }

  const totals: CurrencyCostTotal[] = Array.from(byCurrency.entries())
    .sort(([a], [b]) => {
      const ia = CURRENCY_ORDER.get(a) ?? Number.MAX_SAFE_INTEGER;
      const ib = CURRENCY_ORDER.get(b) ?? Number.MAX_SAFE_INTEGER;
      return ia !== ib ? ia - ib : a.localeCompare(b);
    })
    .map(([currency, annual]) => ({
      currency,
      daily: annual / 365,
      monthly: annual / 12,
      annual,
    }));

  return { configuredCount, totals };
}

const APPROX_CNY_RATE: Record<string, number> = {
  CNY: 1,
  USD: 7.2,
  EUR: 7.8,
};

function formatFunCount(value: number): string {
  if (value >= 10) return String(Math.round(value));
  return value.toFixed(1).replace(/\.0$/, "");
}

/** Convert monthly cost totals into a lighthearted real-life comparison with emoji. */
export function getCostFunComparison(totals: CurrencyCostTotal[]): string | null {
  if (totals.length === 0) return null;
  let monthlyCny = 0;
  let hasKnownCurrency = false;
  for (const item of totals) {
    const rate = APPROX_CNY_RATE[normalizeCurrency(item.currency)];
    if (rate === undefined) continue;
    hasKnownCurrency = true;
    monthlyCny += item.monthly * rate;
  }
  if (!hasKnownCurrency || !Number.isFinite(monthlyCny) || monthlyCny <= 0) {
    return null;
  }

  if (monthlyCny < 15) return "🍬 每月不到一杯奶茶钱";
  if (monthlyCny < 45) return `🧋 每月 ≈ ${formatFunCount(monthlyCny / 18)} 杯奶茶`;
  if (monthlyCny < 100) return `☕️ 每月 ≈ ${formatFunCount(monthlyCny / 15)} 杯咖啡`;
  if (monthlyCny < 600) return `🍲 每月 ≈ ${formatFunCount(monthlyCny / 120)} 顿火锅`;
  if (monthlyCny < 2000) return `🎮 每年 ≈ ${formatFunCount((monthlyCny * 12) / 300)} 个 3A 大作`;
  return `📱 每年 ≈ ${formatFunCount((monthlyCny * 12) / 6000)} 台旗舰手机`;
}

export type ExpirationLevel = "expired" | "urgent" | "soon" | "ok";

export interface ExpirationInfo {
  dateStr: string;
  daysLeft: number;
  level: ExpirationLevel;
  label: string;
}

/** Calculate remaining calendar days until server expiration (`YYYY-MM-DD`). */
export function getExpirationInfo(expiresAt?: string): ExpirationInfo | null {
  const raw = expiresAt?.trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const target = new Date(year, month, day);
  if (
    Number.isNaN(target.getTime()) ||
    target.getFullYear() !== year ||
    target.getMonth() !== month ||
    target.getDate() !== day
  ) {
    return null;
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysLeft = Math.round((target.getTime() - today.getTime()) / 86_400_000);

  let level: ExpirationLevel = "ok";
  let label = `剩余 ${daysLeft} 天`;
  if (daysLeft < 0) {
    level = "expired";
    label = `已过期 ${Math.abs(daysLeft)} 天`;
  } else if (daysLeft === 0) {
    level = "urgent";
    label = "今天到期";
  } else if (daysLeft <= 7) {
    level = "urgent";
    label = `剩 ${daysLeft} 天`;
  } else if (daysLeft <= 30) {
    level = "soon";
    label = `剩余 ${daysLeft} 天`;
  }

  return { dateStr: raw, daysLeft, level, label };
}
