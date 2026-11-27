use serde::Serialize;
use thiserror::Error;

pub const PROBE_CMD: &str = "sh -c 'LC_ALL=C; export LC_ALL; echo __SH_B__; head -1 /proc/stat 2>/dev/null; echo __SH__; cat /proc/meminfo 2>/dev/null; echo __SH__; cat /proc/loadavg 2>/dev/null; echo __SH__; cat /proc/uptime 2>/dev/null; echo __SH__; (df -kP / 2>/dev/null || df -k / 2>/dev/null); echo __SH__; cat /proc/net/dev 2>/dev/null; echo __SH__; (nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 1); echo __SH__; (hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null || uname -n 2>/dev/null); echo __SH__; uname -sr 2>/dev/null; echo __SH__; cat /proc/diskstats 2>/dev/null || true; echo __SH__; cat /etc/os-release 2>/dev/null || true; echo __SH_E__'";

#[derive(Debug, Error)]
pub enum MonitorError {
    #[error("invalid probe output: {0}")]
    Parse(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawSnapshot {
    pub cpu_total: u64,
    pub cpu_idle: u64,
    pub mem_total_kb: u64,
    pub mem_available_kb: u64,
    pub swap_total_kb: u64,
    pub swap_free_kb: u64,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub uptime_secs: u64,
    pub disk_total: u64,
    pub disk_used: u64,
    pub net_rx_bytes: u64,
    pub net_tx_bytes: u64,
    pub disk_read_bytes: u64,
    pub disk_write_bytes: u64,
    pub cores: u32,
    pub hostname: String,
    pub os: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerStats {
    pub hostname: String,
    pub os: String,
    pub uptime_secs: u64,
    pub cpu_percent: Option<f64>,
    pub cores: u32,
    pub mem_total: u64,
    pub mem_used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub disk_total: u64,
    pub disk_used: u64,
    pub net_rx_rate: Option<f64>,
    pub net_tx_rate: Option<f64>,
    pub disk_read_rate: Option<f64>,
    pub disk_write_rate: Option<f64>,
    pub latency_ms: Option<f64>,
}

impl RawSnapshot {
    pub fn parse(output: &str) -> Result<Self, MonitorError> {
        let body = match output.find("__SH_B__") {
            Some(start) => {
                let rest = &output[start + "__SH_B__".len()..];
                match rest.rfind("__SH_E__") {
                    Some(end) => &rest[..end],
                    None => {
                        return Err(MonitorError::Parse(
                            "采集输出被截断（缺少结束标记 __SH_E__）".into(),
                        ));
                    }
                }
            }
            None => match output.rfind("__SH_E__") {
                Some(end) => &output[..end],
                None => output,
            },
        };

        let sections: Vec<&str> = body.split("__SH__").map(str::trim).collect();
        if sections.len() < 9 {
            return Err(MonitorError::Parse(format!(
                "采集输出不完整（期望至少 9 段，实际 {} 段）",
                sections.len()
            )));
        }

        let (cpu_total, cpu_idle) = parse_proc_stat(sections[0]).map_err(|_| {
            MonitorError::Parse("不支持的系统（非 Linux 或无法读取 /proc/stat）".into())
        })?;
        let (mem_total_kb, mem_available_kb, swap_total_kb, swap_free_kb) =
            parse_meminfo(sections[1])?;
        let (load1, load5, load15) = parse_loadavg(sections[2]).unwrap_or((0.0, 0.0, 0.0));
        let uptime_secs = parse_uptime(sections[3]).unwrap_or(0);
        let (disk_total, disk_used) = parse_df(sections[4]).unwrap_or((0, 0));
        let (net_rx_bytes, net_tx_bytes) = parse_net_dev(sections[5]).unwrap_or((0, 0));
        let (disk_read_bytes, disk_write_bytes) = sections
            .get(9)
            .map(|s| parse_diskstats(s))
            .unwrap_or((0, 0));
        let cores = sections[6]
            .lines()
            .find_map(|l| l.trim().parse::<u32>().ok())
            .filter(|&c| c > 0)
            .unwrap_or(1);
        let hostname = sections[7].lines().next().unwrap_or("").trim().to_string();
        let os_release = sections.get(10).and_then(|s| parse_os_release(s));
        let os = os_release
            .unwrap_or_else(|| sections[8].lines().next().unwrap_or("").trim().to_string());

        Ok(Self {
            cpu_total,
            cpu_idle,
            mem_total_kb,
            mem_available_kb,
            swap_total_kb,
            swap_free_kb,
            load1,
            load5,
            load15,
            uptime_secs,
            disk_total,
            disk_used,
            net_rx_bytes,
            net_tx_bytes,
            disk_read_bytes,
            disk_write_bytes,
            cores,
            hostname,
            os,
        })
    }
}

impl ServerStats {
    pub fn compute(
        prev: Option<&RawSnapshot>,
        cur: &RawSnapshot,
        dt_secs: f64,
        latency_ms: Option<f64>,
    ) -> Self {
        // Invalidate previous snapshot if the server rebooted or hostname changed.
        let valid_prev = prev.filter(|p| {
            cur.uptime_secs >= p.uptime_secs
                && (p.hostname.is_empty() || cur.hostname.is_empty() || cur.hostname == p.hostname)
        });

        let cpu_percent = valid_prev.and_then(|p| {
            let d_total = cur.cpu_total.checked_sub(p.cpu_total)?;
            let d_idle = cur.cpu_idle.checked_sub(p.cpu_idle)?;
            if d_total == 0 || d_idle > d_total {
                return None;
            }
            let busy = (d_total - d_idle) as f64;
            let pct = (busy / d_total as f64) * 100.0;
            if pct.is_finite() {
                Some(pct.clamp(0.0, 100.0))
            } else {
                None
            }
        });

        let valid_dt = dt_secs.is_finite() && dt_secs > 1e-6;
        let (net_rx_rate, net_tx_rate, disk_read_rate, disk_write_rate) = if valid_dt {
            if let Some(p) = valid_prev {
                let rx = cur
                    .net_rx_bytes
                    .checked_sub(p.net_rx_bytes)
                    .map(|d| d as f64 / dt_secs)
                    .filter(|r| r.is_finite());
                let tx = cur
                    .net_tx_bytes
                    .checked_sub(p.net_tx_bytes)
                    .map(|d| d as f64 / dt_secs)
                    .filter(|r| r.is_finite());
                let dr = cur
                    .disk_read_bytes
                    .checked_sub(p.disk_read_bytes)
                    .map(|d| d as f64 / dt_secs)
                    .filter(|r| r.is_finite());
                let dw = cur
                    .disk_write_bytes
                    .checked_sub(p.disk_write_bytes)
                    .map(|d| d as f64 / dt_secs)
                    .filter(|r| r.is_finite());
                (rx, tx, dr, dw)
            } else {
                (None, None, None, None)
            }
        } else {
            (None, None, None, None)
        };

        let latency_ms = latency_ms.filter(|ms| ms.is_finite() && *ms >= 0.0);

        let mem_total = cur.mem_total_kb.saturating_mul(1024);
        let mem_avail = cur.mem_available_kb.saturating_mul(1024);
        let mem_used = mem_total.saturating_sub(mem_avail);

        let swap_total = cur.swap_total_kb.saturating_mul(1024);
        let swap_free = cur.swap_free_kb.saturating_mul(1024);
        let swap_used = swap_total.saturating_sub(swap_free);

        Self {
            hostname: cur.hostname.clone(),
            os: cur.os.clone(),
            uptime_secs: cur.uptime_secs,
            cpu_percent,
            cores: cur.cores,
            mem_total,
            mem_used,
            swap_total,
            swap_used,
            load1: cur.load1,
            load5: cur.load5,
            load15: cur.load15,
            disk_total: cur.disk_total,
            disk_used: cur.disk_used,
            net_rx_rate,
            net_tx_rate,
            disk_read_rate,
            disk_write_rate,
            latency_ms,
        }
    }
}

fn parse_proc_stat(section: &str) -> Result<(u64, u64), MonitorError> {
    let line = section
        .lines()
        .find(|l| l.starts_with("cpu "))
        .ok_or_else(|| MonitorError::Parse("missing cpu line in /proc/stat".into()))?;
    let cols: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|s| s.parse::<u64>().ok())
        .collect();
    if cols.len() < 4 {
        return Err(MonitorError::Parse("too few columns in /proc/stat".into()));
    }
    // Linux /proc/stat columns 8 and 9 (guest, guest_nice) are already accounted for in user/nice.
    let total: u64 = cols.iter().take(8).copied().fold(0u64, u64::saturating_add);
    let idle = cols[3].saturating_add(*cols.get(4).unwrap_or(&0));
    Ok((total, idle))
}

fn parse_meminfo(section: &str) -> Result<(u64, u64, u64, u64), MonitorError> {
    let mut mem_total = None;
    let mut mem_available = None;
    let mut mem_free = None;
    let mut buffers = 0u64;
    let mut cached = 0u64;
    let mut swap_total = 0u64;
    let mut swap_free = 0u64;

    for line in section.lines() {
        let mut parts = line.split_whitespace();
        let Some(key) = parts.next() else {
            continue;
        };
        let Some(val) = parts.next().and_then(|v| v.parse::<u64>().ok()) else {
            continue;
        };
        match key {
            "MemTotal:" => mem_total = Some(val),
            "MemAvailable:" => mem_available = Some(val),
            "MemFree:" => mem_free = Some(val),
            "Buffers:" => buffers = val,
            "Cached:" => cached = val,
            "SwapTotal:" => swap_total = val,
            "SwapFree:" => swap_free = val,
            _ => {}
        }
    }

    let total = mem_total.ok_or_else(|| MonitorError::Parse("missing MemTotal".into()))?;
    let avail = mem_available
        .or_else(|| mem_free.map(|f| f.saturating_add(buffers).saturating_add(cached).min(total)))
        .ok_or_else(|| MonitorError::Parse("missing MemAvailable/MemFree".into()))?;
    Ok((total, avail, swap_total, swap_free))
}

fn parse_loadavg(section: &str) -> Result<(f64, f64, f64), MonitorError> {
    let parts: Vec<&str> = section.split_whitespace().collect();
    if parts.len() < 3 {
        return Err(MonitorError::Parse("invalid /proc/loadavg".into()));
    }
    let l1 = parts[0]
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite() && *v >= 0.0)
        .ok_or_else(|| MonitorError::Parse("invalid load1".into()))?;
    let l5 = parts[1]
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite() && *v >= 0.0)
        .ok_or_else(|| MonitorError::Parse("invalid load5".into()))?;
    let l15 = parts[2]
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite() && *v >= 0.0)
        .ok_or_else(|| MonitorError::Parse("invalid load15".into()))?;
    Ok((l1, l5, l15))
}

fn parse_uptime(section: &str) -> Result<u64, MonitorError> {
    let first = section
        .split_whitespace()
        .next()
        .ok_or_else(|| MonitorError::Parse("empty /proc/uptime".into()))?;
    let secs = first
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite() && *v >= 0.0)
        .ok_or_else(|| MonitorError::Parse("invalid uptime".into()))?;
    Ok(secs as u64)
}

fn parse_df(section: &str) -> Result<(u64, u64), MonitorError> {
    // Handle both single-line POSIX `df -kP` and wrapped 2-line LVM/BusyBox `df -k` output
    let tokens: Vec<&str> = section
        .lines()
        .skip(1)
        .flat_map(str::split_whitespace)
        .collect();
    if tokens.len() < 3 {
        return Err(MonitorError::Parse("too few columns in df output".into()));
    }
    let total_kb = tokens[1]
        .parse::<u64>()
        .map_err(|e| MonitorError::Parse(format!("df total: {e}")))?;
    let used_kb = tokens[2]
        .parse::<u64>()
        .map_err(|e| MonitorError::Parse(format!("df used: {e}")))?;
    Ok((total_kb.saturating_mul(1024), used_kb.saturating_mul(1024)))
}

fn is_virtual_net_iface(name: &str) -> bool {
    name == "lo"
        || name.starts_with("docker")
        || name.starts_with("veth")
        || name.starts_with("br-")
        || name.starts_with("virbr")
        || name.starts_with("cni")
        || name.starts_with("flannel")
        || name.starts_with("cali")
        || name.starts_with("tun")
        || name.starts_with("tap")
}

fn parse_net_dev(section: &str) -> Result<(u64, u64), MonitorError> {
    let mut rx_sum = 0u64;
    let mut tx_sum = 0u64;
    for line in section.lines().skip(2) {
        let Some((iface, rest)) = line.split_once(':') else {
            continue;
        };
        if is_virtual_net_iface(iface.trim()) {
            continue;
        }
        let cols: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|s| s.parse::<u64>().ok())
            .collect();
        if cols.len() >= 9 {
            rx_sum = rx_sum.saturating_add(cols[0]);
            tx_sum = tx_sum.saturating_add(cols[8]);
        }
    }
    Ok((rx_sum, tx_sum))
}

fn is_whole_disk_device(name: &str) -> bool {
    if name.starts_with("loop")
        || name.starts_with("ram")
        || name.starts_with("sr")
        || name.starts_with("zram")
        || name.starts_with("dm-")
    {
        return false;
    }
    if name.starts_with("nvme") || name.starts_with("mmcblk") {
        // Exclude multipath controller namespaces (e.g. nvme0c0n1) to avoid double counting.
        if let Some(after_nvme) = name.strip_prefix("nvme")
            && after_nvme.contains('c')
        {
            return false;
        }
        // e.g. nvme0n1 (whole) vs nvme0n1p1 (partition)
        if let Some((_, tail)) = name.rsplit_once('p')
            && !tail.is_empty()
            && tail.chars().all(|c| c.is_ascii_digit())
        {
            return false;
        }
        return true;
    }
    // sd*, vd*, hd*, xvd*: whole disk has no trailing digit
    !name.chars().last().is_some_and(|c| c.is_ascii_digit())
}

fn parse_diskstats(section: &str) -> (u64, u64) {
    let mut whole_read = 0u64;
    let mut whole_write = 0u64;
    let mut whole_matched = false;
    let mut fallback_read = 0u64;
    let mut fallback_write = 0u64;

    for line in section.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 10 {
            continue;
        }
        let name = cols[2];
        let Ok(sectors_read) = cols[5].parse::<u64>() else {
            continue;
        };
        let Ok(sectors_written) = cols[9].parse::<u64>() else {
            continue;
        };
        let r_bytes = sectors_read.saturating_mul(512);
        let w_bytes = sectors_written.saturating_mul(512);

        if is_whole_disk_device(name) {
            whole_matched = true;
            whole_read = whole_read.saturating_add(r_bytes);
            whole_write = whole_write.saturating_add(w_bytes);
        } else if !name.starts_with("loop") && !name.starts_with("ram") {
            fallback_read = fallback_read.saturating_add(r_bytes);
            fallback_write = fallback_write.saturating_add(w_bytes);
        }
    }

    if whole_matched {
        (whole_read, whole_write)
    } else {
        (fallback_read, fallback_write)
    }
}

fn unquote_os_value(val: &str) -> String {
    let trimmed = val.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        trimmed[1..trimmed.len() - 1].trim().to_string()
    } else {
        trimmed.to_string()
    }
}

fn parse_os_release(section: &str) -> Option<String> {
    let mut pretty_name: Option<String> = None;
    let mut name: Option<String> = None;
    let mut version_id: Option<String> = None;

    for line in section.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("PRETTY_NAME=") {
            let v = unquote_os_value(rest);
            if !v.is_empty() {
                pretty_name = Some(v);
            }
        } else if let Some(rest) = line.strip_prefix("NAME=") {
            let v = unquote_os_value(rest);
            if !v.is_empty() {
                name = Some(v);
            }
        } else if let Some(rest) = line.strip_prefix("VERSION_ID=") {
            let v = unquote_os_value(rest);
            if !v.is_empty() {
                version_id = Some(v);
            }
        }
    }

    if let Some(pretty) = pretty_name {
        return Some(pretty);
    }
    match (name, version_id) {
        (Some(n), Some(v)) => Some(format!("{n} {v}")),
        (Some(n), None) => Some(n),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(cpu_user: u64, cpu_idle: u64, rx: u64, tx: u64) -> String {
        format!(
            "\
cpu  {cpu_user} 0 100 {cpu_idle} 50 0 0 0 0 0
__SH__
MemTotal:       16384000 kB
MemFree:         2048000 kB
MemAvailable:   10240000 kB
SwapTotal:       2097152 kB
SwapFree:        1048576 kB
__SH__
0.42 0.31 0.25 1/256 12345
__SH__
86400.55 123456.78
__SH__
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        104857600  41943040  62914560      40% /
__SH__
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000000 1000 0 0 0 0 0 0 1000000 1000 0 0 0 0 0 0
  eth0: {rx} 5000 0 0 0 0 0 0 {tx} 4000 0 0 0 0 0 0
__SH__
4
__SH__
prod-web-01
__SH__
Linux 6.8.0-45-generic
"
        )
    }

    #[test]
    fn parse_and_compute_stats() {
        let s1 = RawSnapshot::parse(&fixture(1000, 8850, 1_000_000, 500_000)).expect("parse s1");
        assert_eq!(s1.cores, 4);
        assert_eq!(s1.hostname, "prod-web-01");
        assert_eq!(s1.os, "Linux 6.8.0-45-generic");
        assert_eq!(s1.uptime_secs, 86400);
        assert_eq!(s1.net_rx_bytes, 1_000_000);
        assert_eq!(s1.net_tx_bytes, 500_000);

        let first = ServerStats::compute(None, &s1, 0.0, Some(18.5));
        assert_eq!(first.cpu_percent, None);
        assert_eq!(first.net_rx_rate, None);
        assert_eq!(first.net_tx_rate, None);
        assert_eq!(first.latency_ms, Some(18.5));

        let s2 = RawSnapshot::parse(&fixture(1500, 9350, 1_300_000, 650_000)).expect("parse s2");
        let second = ServerStats::compute(Some(&s1), &s2, 3.0, Some(19.0));
        // d_total = (1500+100+9350+50) - (1000+100+8850+50) = 11000 - 10000 = 1000
        // d_idle = 9400 - 8900 = 500 -> 50%
        let cpu = second.cpu_percent.expect("cpu percent");
        assert!((cpu - 50.0).abs() < 1e-6);
        assert!((second.net_rx_rate.expect("rx") - 100_000.0).abs() < 1e-6);
        assert!((second.net_tx_rate.expect("tx") - 50_000.0).abs() < 1e-6);
    }

    #[test]
    fn parse_diskstats_calculates_io_rates() {
        let d1 = "\
   8       0 sda 100 0 2000 10 50 0 1000 5 0 10 15
   8       1 sda1 100 0 2000 10 50 0 1000 5 0 10 15
   7       0 loop0 10 0 100 1 0 0 0 0 0 1 1";
        let d2 = "\
   8       0 sda 110 0 2600 12 60 0 1300 7 0 12 19
   8       1 sda1 110 0 2600 12 60 0 1300 7 0 12 19
   7       0 loop0 10 0 100 1 0 0 0 0 0 1 1";

        let s1_raw = format!("{}\n__SH__\n{}", fixture(1000, 8850, 0, 0), d1);
        let s2_raw = format!("{}\n__SH__\n{}", fixture(1100, 8950, 0, 0), d2);
        let s1 = RawSnapshot::parse(&s1_raw).expect("parse s1");
        let s2 = RawSnapshot::parse(&s2_raw).expect("parse s2");
        let stats = ServerStats::compute(Some(&s1), &s2, 2.0, None);

        // delta read = 600 sectors * 512 = 307200 bytes over 2s = 153600 B/s
        // delta write = 300 sectors * 512 = 153600 bytes over 2s = 76800 B/s
        assert!((stats.disk_read_rate.expect("dr") - 153_600.0).abs() < 1e-6);
        assert!((stats.disk_write_rate.expect("dw") - 76_800.0).abs() < 1e-6);
    }

    #[test]
    fn parse_os_release_prefers_pretty_name() {
        let os_rel = "\
NAME=\"Ubuntu\"
VERSION_ID=\"24.04\"
PRETTY_NAME=\"Ubuntu 24.04.1 LTS\"";
        let raw = format!(
            "{}\n__SH__\n\n__SH__\n{}",
            fixture(1000, 8850, 0, 0),
            os_rel
        );
        let snap = RawSnapshot::parse(&raw).expect("parse with os-release");
        assert_eq!(snap.os, "Ubuntu 24.04.1 LTS");
    }

    #[test]
    fn parse_handles_motd_markers_and_wrapped_df() {
        let raw = "\
Welcome to Ubuntu! Last login: Mon Nov 1 00:00:00 2026
__SH_B__
cpu  1000 0 100 8850 50 0 0 0 0 0
__SH__
MemTotal:        8000000 kB
MemFree:         1000000 kB
Buffers:          500000 kB
Cached:          2500000 kB
__SH__
0.50 0.40 0.30 1/120 999
__SH__
3600.0 7200.0
__SH__
Filesystem           1K-blocks      Used Available Use% Mounted on
/dev/mapper/ubuntu--vg-ubuntu--lv
                     104857600  41943040  62914560  40% /
__SH__
Inter-| Receive | Transmit
 face | bytes
  eth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0
__SH__

__SH__
lvm-node
__SH__
Linux 5.15.0
__SH__
__SH__
__SH_E__
logout noise";

        let snap = RawSnapshot::parse(raw).expect("parse with markers and wrapped df");
        assert_eq!(snap.cores, 1);
        assert_eq!(snap.hostname, "lvm-node");
        assert_eq!(snap.mem_available_kb, 4_000_000);
        assert_eq!(snap.disk_total, 104_857_600 * 1024);
        assert_eq!(snap.disk_used, 41_943_040 * 1024);
    }
}
