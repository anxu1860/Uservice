const CUSTOM_GROUPS_KEY = "serverhub.custom_groups.v1";
const RECENT_SERVERS_KEY = "serverhub.recent_servers.v1";

export function loadCustomGroups(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_GROUPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return Array.from(
      new Set(
        parsed
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
      )
    );
  } catch {
    return [];
  }
}

export function saveCustomGroups(groups: string[]): void {
  try {
    localStorage.setItem(CUSTOM_GROUPS_KEY, JSON.stringify(groups));
  } catch {
    // Ignore storage quota errors
  }
}

export function loadRecentServerIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_SERVERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

export function saveRecentServerIds(ids: string[]): void {
  try {
    localStorage.setItem(RECENT_SERVERS_KEY, JSON.stringify(ids));
  } catch {
    // Ignore storage quota errors
  }
}

export function pushRecentServerId(
  current: string[],
  serverId: string,
  limit = 15
): string[] {
  const next = [serverId, ...current.filter((id) => id !== serverId)].slice(0, limit);
  saveRecentServerIds(next);
  return next;
}
