use serde::Serialize;
use thiserror::Error;

pub const PROBE_CMD: &str = "head -1 /proc/stat; echo __SH__; cat /proc/meminfo; echo __SH__; cat /proc/loadavg; echo __SH__; cat /proc/uptime; echo __SH__; df -kP /; echo __SH__; cat /proc/net/dev; echo __SH__; nproc; echo __SH__; hostname; echo __SH__; uname -sr";

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
    pub latency_ms: Option<f64>,
}

impl RawSnapshot {
    pub fn parse(output: &str) -> Result<Self, MonitorError> {
        let sections: Vec<&str> = output.split("__SH__").map(str::trim).collect();
        if sections.len() < 9 {
            return Err(MonitorError::Parse(format!(
                "expected 9 sections, got {}",
                sections.len()
            )));
        }

        let (cpu_total, cpu_idle) = parse_proc_stat(sections[0])?;
        let (mem_total_kb, mem_available_kb, swap_total_kb, swap_free_kb) =
            parse_meminfo(sections[1])?;
        let (load1, load5, load15) = parse_loadavg(sections[2])?;
        let uptime_secs = parse_uptime(sections[3])?;
        let (disk_total, disk_used) = parse_df(sections[4])?;
        let (net_rx_bytes, net_tx_bytes) = parse_net_dev(sections[5])?;
        let cores = sections[6]
            .trim()
            .parse::<u32>()
            .map_err(|e| MonitorError::Parse(format!("nproc: {e}")))?;
        let hostname = sections[7].lines().next().unwrap_or("").trim().to_string();
        let os = sections[8].lines().next().unwrap_or("").trim().to_string();

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
        let cpu_percent = prev.and_then(|p| {
            let d_total = cur.cpu_total.checked_sub(p.cpu_total)?;
            let d_idle = cur.cpu_idle.checked_sub(p.cpu_idle)?;
            if d_total == 0 || d_idle > d_total {
                return None;
            }
            let busy = (d_total - d_idle) as f64;
            Some(((busy / d_total as f64) * 100.0).clamp(0.0, 100.0))
        });

        let (net_rx_rate, net_tx_rate) = if dt_secs > 0.0 {
            if let Some(p) = prev {
                let rx = cur
                    .net_rx_bytes
                    .checked_sub(p.net_rx_bytes)
                    .map(|d| d as f64 / dt_secs);
                let tx = cur
                    .net_tx_bytes
                    .checked_sub(p.net_tx_bytes)
                    .map(|d| d as f64 / dt_secs);
                (rx, tx)
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };

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
    let total: u64 = cols.iter().sum();
    let idle = cols[3].saturating_add(*cols.get(4).unwrap_or(&0));
    Ok((total, idle))
}

fn parse_meminfo(section: &str) -> Result<(u64, u64, u64, u64), MonitorError> {
    let mut mem_total = None;
    let mut mem_available = None;
    let mut mem_free = None;
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
            "SwapTotal:" => swap_total = val,
            "SwapFree:" => swap_free = val,
            _ => {}
        }
    }

    let total = mem_total.ok_or_else(|| MonitorError::Parse("missing MemTotal".into()))?;
    let avail = mem_available
        .or(mem_free)
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
        .map_err(|e| MonitorError::Parse(format!("load1: {e}")))?;
    let l5 = parts[1]
        .parse::<f64>()
        .map_err(|e| MonitorError::Parse(format!("load5: {e}")))?;
    let l15 = parts[2]
        .parse::<f64>()
        .map_err(|e| MonitorError::Parse(format!("load15: {e}")))?;
    Ok((l1, l5, l15))
}

fn parse_uptime(section: &str) -> Result<u64, MonitorError> {
    let first = section
        .split_whitespace()
        .next()
        .ok_or_else(|| MonitorError::Parse("empty /proc/uptime".into()))?;
    let secs = first
        .parse::<f64>()
        .map_err(|e| MonitorError::Parse(format!("uptime: {e}")))?;
    Ok(secs.max(0.0) as u64)
}

fn parse_df(section: &str) -> Result<(u64, u64), MonitorError> {
    let data_line = section
        .lines()
        .skip(1)
        .find(|l| !l.trim().is_empty())
        .ok_or_else(|| MonitorError::Parse("missing df output line".into()))?;
    let cols: Vec<&str> = data_line.split_whitespace().collect();
    if cols.len() < 3 {
        return Err(MonitorError::Parse("too few columns in df output".into()));
    }
    let total_kb = cols[1]
        .parse::<u64>()
        .map_err(|e| MonitorError::Parse(format!("df total: {e}")))?;
    let used_kb = cols[2]
        .parse::<u64>()
        .map_err(|e| MonitorError::Parse(format!("df used: {e}")))?;
    Ok((total_kb.saturating_mul(1024), used_kb.saturating_mul(1024)))
}

fn parse_net_dev(section: &str) -> Result<(u64, u64), MonitorError> {
    let mut rx_sum = 0u64;
    let mut tx_sum = 0u64;
    for line in section.lines().skip(2) {
        let Some((iface, rest)) = line.split_once(':') else {
            continue;
        };
        if iface.trim() == "lo" {
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
}
