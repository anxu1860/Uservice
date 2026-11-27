import { memo, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Server } from "../types";

export interface RegionInfo {
  flag: string;
  label: string;
}

export const REGION_PRESETS: string[] = [
  "中国大陆",
  "中国香港",
  "中国台湾",
  "中国澳门",
  "日本",
  "新加坡",
  "韩国",
  "美国",
  "德国",
  "英国",
  "法国",
  "荷兰",
  "加拿大",
  "澳大利亚",
  "印度",
  "俄罗斯",
  "马来西亚",
  "泰国",
  "越南",
  "瑞士",
  "芬兰",
];

const REGION_RULES: { pattern: RegExp; flag: string; label: string }[] = [
  // 中国及港澳台地区（台湾统一使用中国国旗 🇨🇳）
  {
    pattern: /台湾|台北|高雄|台中|taiwan|taipei|\btw\b|\btpe\b|ap-taipei/i,
    flag: "🇨🇳",
    label: "中国台湾",
  },
  {
    pattern: /香港|hong\s*kong|\bhk\b|\bhkg\b|cn-hongkong|ap-hongkong/i,
    flag: "🇨🇳",
    label: "香港",
  },
  {
    pattern: /澳门|macau|macao|\bmo\b|\bmfm\b/i,
    flag: "🇨🇳",
    label: "澳门",
  },
  {
    pattern:
      /中国|北京|上海|广州|深圳|杭州|成都|南京|武汉|重庆|苏州|青岛|天津|西安|贵阳|乌兰察布|张家口|河源|china|beijing|shanghai|guangzhou|shenzhen|hangzhou|chengdu|\bcn\b|\bpek\b|\bsha\b|\bcan\b|\bszx\b|cn-(north|east|south|southwest|northwest)/i,
    flag: "🇨🇳",
    label: "中国",
  },
  // 亚太
  {
    pattern: /日本|东京|大阪|japan|tokyo|osaka|\bjp\b|\bnrt\b|\bkix\b|ap-northeast-1/i,
    flag: "🇯🇵",
    label: "日本",
  },
  {
    pattern: /新加坡|狮城|singapore|\bsg\b|\bsin\b|ap-southeast-1/i,
    flag: "🇸🇬",
    label: "新加坡",
  },
  {
    pattern: /韩国|首尔|釜山|korea|seoul|\bkr\b|\bicn\b|ap-northeast-2/i,
    flag: "🇰🇷",
    label: "韩国",
  },
  {
    pattern: /印度|孟买|新德里|班加罗尔|india|mumbai|delhi|\bin\b|\bbom\b/i,
    flag: "🇮🇳",
    label: "印度",
  },
  {
    pattern: /马来西亚|吉隆坡|malaysia|kuala|\bmy\b|\bkul\b/i,
    flag: "🇲🇾",
    label: "马来西亚",
  },
  {
    pattern: /泰国|曼谷|thailand|bangkok|\bth\b|\bbkk\b/i,
    flag: "🇹🇭",
    label: "泰国",
  },
  {
    pattern: /越南|河内|胡志明|vietnam|hanoi|saigon|\bvn\b|\bsgn\b/i,
    flag: "🇻🇳",
    label: "越南",
  },
  {
    pattern: /印尼|雅加达|indonesia|jakarta|\bid\b|\bcgk\b/i,
    flag: "🇮🇩",
    label: "印尼",
  },
  {
    pattern: /菲律宾|马尼拉|philippines|manila|\bph\b|\bmnl\b/i,
    flag: "🇵🇭",
    label: "菲律宾",
  },
  {
    pattern: /澳大利亚|澳洲|悉尼|墨尔本|australia|sydney|melbourne|\bau\b|\bsyd\b/i,
    flag: "🇦🇺",
    label: "澳大利亚",
  },
  // 美洲
  {
    pattern:
      /美国|美西|美东|洛杉矶|圣何塞|硅谷|纽约|西雅图|芝加哥|达拉斯|弗吉尼亚|俄勒冈|凤凰城|迈阿密|usa|\bus\b|united\s*states|los\s*angeles|san\s*jose|silicon\s*valley|new\s*york|seattle|dallas|\blax\b|\bsjc\b|\bnyc\b|\bsea\b|\bdfw\b|\biad\b|us-(west|east|central)/i,
    flag: "🇺🇸",
    label: "美国",
  },
  {
    pattern: /加拿大|多伦多|温哥华|蒙特利尔|canada|toronto|vancouver|montreal|\bca\b|\byyz\b|\byvr\b/i,
    flag: "🇨🇦",
    label: "加拿大",
  },
  {
    pattern: /巴西|圣保罗|brazil|sao\s*paulo|\bbr\b|\bgru\b/i,
    flag: "🇧🇷",
    label: "巴西",
  },
  // 欧洲与中东
  {
    pattern: /德国|法兰克福|柏林|纽伦堡|慕尼黑|germany|frankfurt|berlin|munich|\bde\b|\bfra\b|eu-central-1/i,
    flag: "🇩🇪",
    label: "德国",
  },
  {
    pattern: /英国|伦敦|uk|britain|england|london|\bgb\b|\blhr\b/i,
    flag: "🇬🇧",
    label: "英国",
  },
  {
    pattern: /法国|巴黎|斯特拉斯堡|france|paris|\bfr\b|\bcdg\b/i,
    flag: "🇫🇷",
    label: "法国",
  },
  {
    pattern: /荷兰|阿姆斯特丹|netherlands|holland|amsterdam|\bnl\b|\bams\b/i,
    flag: "🇳🇱",
    label: "荷兰",
  },
  {
    pattern: /瑞士|苏黎世|switzerland|zurich|\bch\b|\bzrh\b/i,
    flag: "🇨🇭",
    label: "瑞士",
  },
  {
    pattern: /芬兰|赫尔辛基|finland|helsinki|\bfi\b|\bhel\b/i,
    flag: "🇫🇮",
    label: "芬兰",
  },
  {
    pattern: /俄罗斯|莫斯科|圣彼得堡|russia|moscow|\bru\b|\bsvo\b/i,
    flag: "🇷🇺",
    label: "俄罗斯",
  },
  {
    pattern: /土耳其|伊斯坦布尔|turkey|istanbul|\btr\b|\bist\b/i,
    flag: "🇹🇷",
    label: "土耳其",
  },
  {
    pattern: /阿联酋|迪拜|uae|dubai|\bae\b|\bdxb\b/i,
    flag: "🇦🇪",
    label: "阿联酋",
  },
];

const CN_CITIES: [RegExp, string][] = [
  [/西安|xi'?an|\bxiy\b/i, "西安"],
  [/北京|beijing|\bpek\b/i, "北京"],
  [/上海|shanghai|\bsha\b|\bpvg\b/i, "上海"],
  [/广州|guangzhou|\bcan\b/i, "广州"],
  [/深圳|shenzhen|\bszx\b/i, "深圳"],
  [/杭州|hangzhou|\bhgh\b/i, "杭州"],
  [/成都|chengdu|\bctu\b/i, "成都"],
  [/南京|nanjing|\bnkg\b/i, "南京"],
  [/武汉|wuhan|\bwuh\b/i, "武汉"],
  [/重庆|chongqing|\bckg\b/i, "重庆"],
  [/苏州|suzhou/i, "苏州"],
  [/青岛|qingdao/i, "青岛"],
  [/天津|tianjin/i, "天津"],
  [/贵阳|guiyang/i, "贵阳"],
  [/乌兰察布/i, "乌兰察布"],
  [/张家口/i, "张家口"],
  [/河源/i, "河源"],
  [/长沙|changsha/i, "长沙"],
  [/郑州|zhengzhou/i, "郑州"],
  [/宁波|ningbo/i, "宁波"],
  [/厦门|xiamen/i, "厦门"],
  [/福州|fuzhou/i, "福州"],
  [/合肥|hefei/i, "合肥"],
  [/济南|jinan/i, "济南"],
  [/沈阳|shenyang/i, "沈阳"],
  [/大连|dalian/i, "大连"],
  [/哈尔滨|harbin/i, "哈尔滨"],
  [/长春|changchun/i, "长春"],
  [/昆明|kunming/i, "昆明"],
  [/南宁|nanning/i, "南宁"],
  [/海口|haikou/i, "海口"],
  [/兰州|lanzhou/i, "兰州"],
  [/太原|taiyuan/i, "太原"],
  [/石家庄|shijiazhuang/i, "石家庄"],
  [/呼和浩特|hohhot/i, "呼和浩特"],
  [/乌鲁木齐|urumqi/i, "乌鲁木齐"],
  [/银川|yinchuan/i, "银川"],
  [/西宁|xining/i, "西宁"],
  [/拉萨|lhasa/i, "拉萨"],
];

function matchFlag(text: string): { flag: string; defaultLabel: string } | null {
  for (const [pattern, city] of CN_CITIES) {
    if (pattern.test(text)) {
      return { flag: "🇨🇳", defaultLabel: `中国·${city}` };
    }
  }
  for (const rule of REGION_RULES) {
    if (rule.pattern.test(text)) {
      return { flag: rule.flag, defaultLabel: rule.label };
    }
  }
  return null;
}

export function detectRegion(server: Server): RegionInfo | null {
  const explicit = server.region?.trim();
  if (explicit && explicit.toLowerCase() !== "auto") {
    const matched = matchFlag(explicit);
    return {
      flag: matched ? matched.flag : "🌐",
      label: explicit,
    };
  }

  const haystacks = [
    server.name,
    server.group ?? "",
    ...(server.tags ?? []),
    server.host,
  ];
  for (const text of haystacks) {
    if (!text) continue;
    const matched = matchFlag(text);
    if (matched) {
      return { flag: matched.flag, label: matched.defaultLabel };
    }
  }
  return null;
}

interface GeoLookupResult {
  country_code: string;
  label: string;
}

const MAX_GEO_CACHE = 512;
const geoClientCache = new Map<string, RegionInfo | null>();
const geoInflight = new Map<string, Promise<RegionInfo | null>>();

function normalizeGeoKey(host: string): string {
  return host.trim().toLowerCase();
}

function setGeoCacheEntry(key: string, info: RegionInfo | null) {
  if (geoClientCache.size >= MAX_GEO_CACHE && !geoClientCache.has(key)) {
    const oldest = geoClientCache.keys().next().value;
    if (oldest !== undefined) geoClientCache.delete(oldest);
  }
  geoClientCache.set(key, info);
}

function fetchGeoRegion(rawHost: string): Promise<RegionInfo | null> {
  const key = normalizeGeoKey(rawHost);
  if (!key) return Promise.resolve(null);
  const existing = geoInflight.get(key);
  if (existing) return existing;
  const p = invoke<GeoLookupResult | null>("geo_lookup", { host: key })
    .then((res) => {
      const info = res
        ? {
            flag: countryCodeToFlag(res.country_code),
            label: res.label,
          }
        : null;
      setGeoCacheEntry(key, info);
      return info;
    })
    .catch(() => {
      // Do not permanently cache transient network/IPC errors
      return null;
    })
    .finally(() => {
      geoInflight.delete(key);
    });
  geoInflight.set(key, p);
  return p;
}

function countryCodeToFlag(cc: string): string {
  const upper = cc.trim().toUpperCase();
  if (upper === "LOCAL") return "🏠";
  // 台湾统一使用中国国旗
  const normalized = upper === "TW" || upper === "HK" || upper === "MO" ? "CN" : upper;
  if (!/^[A-Z]{2}$/.test(normalized)) return "🌐";
  const codePoints = [...normalized].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65);
  return String.fromCodePoint(...codePoints);
}

export const RegionBadge = memo(function RegionBadge({ server }: { server: Server }) {
  const staticRegion = detectRegion(server);
  const hostKey = normalizeGeoKey(server.host);
  const [geoRegion, setGeoRegion] = useState<RegionInfo | null>(() => {
    if (staticRegion || !hostKey) return null;
    return geoClientCache.get(hostKey) ?? null;
  });

  useEffect(() => {
    if (staticRegion) return;
    if (!hostKey) {
      setGeoRegion(null);
      return;
    }
    if (geoClientCache.has(hostKey)) {
      setGeoRegion(geoClientCache.get(hostKey) ?? null);
      return;
    }

    setGeoRegion(null);
    let cancelled = false;
    void fetchGeoRegion(hostKey).then((info) => {
      if (!cancelled) {
        setGeoRegion(info);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [staticRegion, hostKey]);

  const region = staticRegion ?? geoRegion;
  if (!region) return null;

  return (
    <span
      title={`地域：${region.label}`}
      className="inline-flex shrink-0 items-center gap-1 rounded-[6px] bg-muted/80 px-1.5 py-0.5 text-[11px] font-medium leading-none text-muted-foreground"
    >
      <span aria-hidden="true" className="text-[12px] leading-none">
        {region.flag}
      </span>
      <span>{region.label}</span>
    </span>
  );
});
