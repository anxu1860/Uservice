use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;

use crate::{AuthMethod, Server};

#[derive(Default)]
struct HostBlock {
    patterns: Vec<String>,
    hostname: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
    connect_timeout: Option<u64>,
    server_alive_interval: Option<u64>,
    /// `None` = unset in this block; `Some(vec![])` = explicitly `ProxyJump none`.
    proxy_jump: Option<Vec<String>>,
}

fn current_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn split_kv(line: &str) -> Option<(&str, &str)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    if let Some(eq_idx) = trimmed.find('=') {
        let before = trimmed[..eq_idx].trim();
        let after = trimmed[eq_idx + 1..].trim();
        // Only treat '=' as separator if the key has no whitespace and value is non-empty
        if !before.is_empty() && !after.is_empty() && !before.contains(char::is_whitespace) {
            return Some((before, after));
        }
    }
    let mut parts = trimmed.splitn(2, char::is_whitespace);
    let key = parts.next()?.trim();
    let val = parts.next()?.trim();
    if key.is_empty() || val.is_empty() {
        return None;
    }
    Some((key, val))
}

fn unquote(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    }
}

/// Quote-aware tokenization for `Host` pattern lists (e.g. `Host "my box" web-1 !bastion`).
fn tokenize_patterns(val: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    for ch in val.chars() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
            }
            c if c.is_whitespace() && !in_quotes => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// OpenSSH single-pattern wildcard match (`*` matches 0+ chars, `?` matches 1 char).
fn wildcard_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let mut star_idx: Option<usize> = None;
    let mut match_idx = 0usize;

    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star_idx = Some(pi);
            match_idx = ti;
            pi += 1;
        } else if let Some(s) = star_idx {
            pi = s + 1;
            match_idx += 1;
            ti = match_idx;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Evaluates an OpenSSH `Host` pattern list against a concrete alias:
/// any matching `!pattern` rejects the block; otherwise at least one positive pattern must match.
fn host_block_matches(patterns: &[String], alias: &str) -> bool {
    let mut positive = false;
    for pat in patterns {
        if let Some(neg) = pat.strip_prefix('!') {
            if !neg.is_empty() && wildcard_match(neg, alias) {
                return false;
            }
        } else if wildcard_match(pat, alias) {
            positive = true;
        }
    }
    positive
}

fn expand_ssh_tokens(input: &str, alias: &str, hostname: &str, user: &str, port: u16) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '%'
            && let Some(&next) = chars.peek()
        {
            match next {
                '%' => {
                    chars.next();
                    out.push('%');
                    continue;
                }
                'h' => {
                    chars.next();
                    out.push_str(hostname);
                    continue;
                }
                'n' => {
                    chars.next();
                    out.push_str(alias);
                    continue;
                }
                'r' => {
                    chars.next();
                    out.push_str(user);
                    continue;
                }
                'p' => {
                    chars.next();
                    out.push_str(&port.to_string());
                    continue;
                }
                _ => {}
            }
        }
        out.push(ch);
    }
    out
}

fn extract_proxy_jump_host(hop: &str) -> &str {
    let stripped = hop.strip_prefix("ssh://").unwrap_or(hop);
    let without_user = match stripped.rsplit_once('@') {
        Some((_, host_part)) => host_part,
        None => stripped,
    };
    if let Some(rest) = without_user.strip_prefix('[')
        && let Some((ipv6, _)) = rest.split_once(']')
    {
        return ipv6;
    }
    // Only strip `:port` when there is a single colon (not bare IPv6 like `2001:db8::1`).
    if let Some((host, port)) = without_user.rsplit_once(':')
        && !host.is_empty()
        && !host.contains(':')
        && !port.is_empty()
        && port.chars().all(|c| c.is_ascii_digit())
    {
        return host;
    }
    without_user
}

fn apply_directive(block: &mut HostBlock, lower: &str, val: &str) {
    match lower {
        "hostname" => {
            if block.hostname.is_none() {
                let cleaned = unquote(val);
                if !cleaned.is_empty() {
                    block.hostname = Some(cleaned);
                }
            }
        }
        "user" => {
            if block.user.is_none() {
                let cleaned = unquote(val);
                if !cleaned.is_empty() {
                    block.user = Some(cleaned);
                }
            }
        }
        "port" => {
            if block.port.is_none()
                && let Ok(p) = unquote(val).parse::<u16>()
                && p > 0
            {
                block.port = Some(p);
            }
        }
        "identityfile" => {
            if block.identity_file.is_none() {
                let cleaned = unquote(val);
                if !cleaned.is_empty() {
                    block.identity_file = Some(cleaned);
                }
            }
        }
        "connecttimeout" => {
            if block.connect_timeout.is_none()
                && let Ok(t) = unquote(val).parse::<u64>()
                && t > 0
            {
                block.connect_timeout = Some(t);
            }
        }
        "serveraliveinterval" => {
            if block.server_alive_interval.is_none()
                && let Ok(t) = unquote(val).parse::<u64>()
            {
                block.server_alive_interval = Some(t);
            }
        }
        "proxyjump" if block.proxy_jump.is_none() => {
            let cleaned = unquote(val);
            if cleaned.eq_ignore_ascii_case("none") {
                block.proxy_jump = Some(Vec::new());
            } else {
                let hops: Vec<String> = cleaned
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if !hops.is_empty() {
                    block.proxy_jump = Some(hops);
                }
            }
        }
        _ => {}
    }
}

/// Parse `~/.ssh/config` content into `Server` entries following OpenSSH first-match-wins semantics.
pub fn parse(text: &str, default_user: &str) -> Vec<Server> {
    let mut blocks: Vec<HostBlock> = Vec::new();
    // Implicit top-level block applies to all hosts (equivalent to `Host *` at top of file).
    let mut current: Option<HostBlock> = Some(HostBlock {
        patterns: vec!["*".to_string()],
        ..Default::default()
    });
    let mut in_match = false;
    let now = current_timestamp();

    for raw_line in text.lines() {
        let Some((key, val)) = split_kv(raw_line) else {
            continue;
        };

        let lower = key.to_ascii_lowercase();
        match lower.as_str() {
            "host" => {
                if let Some(b) = current.take() {
                    blocks.push(b);
                }
                in_match = false;
                let patterns = tokenize_patterns(val);
                current = Some(HostBlock {
                    patterns,
                    ..Default::default()
                });
            }
            "match" => {
                if let Some(b) = current.take() {
                    blocks.push(b);
                }
                in_match = true;
            }
            "include" => {
                // Ignored for pure string parsing
            }
            _ if in_match => {}
            _ => {
                if let Some(b) = current.as_mut() {
                    apply_directive(b, &lower, val);
                }
            }
        }
    }

    if let Some(b) = current.take() {
        blocks.push(b);
    }

    // Collect concrete (non-wildcard, non-negated) aliases in first-seen order without duplicates.
    let mut concrete_aliases: Vec<String> = Vec::new();
    let mut seen_aliases: HashSet<String> = HashSet::new();
    for b in &blocks {
        for pat in &b.patterns {
            if pat.starts_with('!') || pat.contains('*') || pat.contains('?') {
                continue;
            }
            if seen_aliases.insert(pat.clone()) {
                concrete_aliases.push(pat.clone());
            }
        }
    }

    let mut raw_out: Vec<(Server, Vec<String>)> = Vec::with_capacity(concrete_aliases.len());
    for alias in concrete_aliases {
        let mut hostname: Option<String> = None;
        let mut user: Option<String> = None;
        let mut port: Option<u16> = None;
        let mut identity_file: Option<String> = None;
        let mut connect_timeout: Option<u64> = None;
        let mut server_alive_interval: Option<u64> = None;
        let mut proxy_jump: Option<Vec<String>> = None;

        for b in &blocks {
            if !host_block_matches(&b.patterns, &alias) {
                continue;
            }
            if hostname.is_none() {
                hostname = b.hostname.clone();
            }
            if user.is_none() {
                user = b.user.clone();
            }
            if port.is_none() {
                port = b.port;
            }
            if identity_file.is_none() {
                identity_file = b.identity_file.clone();
            }
            if connect_timeout.is_none() {
                connect_timeout = b.connect_timeout;
            }
            if server_alive_interval.is_none() {
                server_alive_interval = b.server_alive_interval;
            }
            if proxy_jump.is_none() {
                proxy_jump = b.proxy_jump.clone();
            }
        }

        let username = user.unwrap_or_else(|| default_user.to_string());
        let port = port.unwrap_or(22);
        let raw_host = hostname.unwrap_or_else(|| alias.clone());
        let host = expand_ssh_tokens(&raw_host, &alias, &alias, &username, port);
        let raw_key = identity_file.unwrap_or_else(|| "~/.ssh/id_ed25519".to_string());
        let key_path = expand_ssh_tokens(&raw_key, &alias, &host, &username, port);

        raw_out.push((
            Server {
                id: Uuid::new_v4(),
                name: alias,
                protocol: crate::Protocol::Ssh,
                host,
                port,
                username,
                domain: None,
                auth: AuthMethod::Key { path: key_path },
                auth_priority: Vec::new(),
                timeout_secs: connect_timeout,
                keepalive_secs: server_alive_interval,
                jump_hosts: Vec::new(),
                term_type: None,
                group: Some("SSH Config".to_string()),
                provider: None,
                region: None,
                os: None,
                tags: Vec::new(),
                cost: None,
                expires_at: None,
                updated_at: now,
            },
            proxy_jump.unwrap_or_default(),
        ));
    }

    let name_to_id: HashMap<String, Uuid> = raw_out
        .iter()
        .map(|(srv, _)| (srv.name.clone(), srv.id))
        .collect();

    raw_out
        .into_iter()
        .map(|(mut srv, jumps)| {
            for hop in jumps {
                let resolved_id = name_to_id
                    .get(&hop)
                    .or_else(|| name_to_id.get(extract_proxy_jump_host(&hop)))
                    .copied();
                if let Some(hop_id) = resolved_id
                    && hop_id != srv.id
                    && !srv.jump_hosts.contains(&hop_id)
                {
                    srv.jump_hosts.push(hop_id);
                }
            }
            srv
        })
        .collect()
}

fn expand_include_pattern(pattern: &str, base_dir: &Path) -> Vec<PathBuf> {
    let raw = unquote(pattern);
    if raw.is_empty() {
        return Vec::new();
    }
    let resolved = if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            PathBuf::from(home).join(rest)
        } else {
            PathBuf::from(&raw)
        }
    } else {
        let p = PathBuf::from(&raw);
        if p.is_absolute() { p } else { base_dir.join(p) }
    };

    let file_name = resolved.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if file_name.contains('*') || file_name.contains('?') {
        let Some(parent) = resolved.parent() else {
            return Vec::new();
        };
        let Ok(entries) = std::fs::read_dir(parent) else {
            return Vec::new();
        };
        let mut matched: Vec<PathBuf> = entries
            .flatten()
            .filter_map(|e| {
                let p = e.path();
                if !p.is_file() {
                    return None;
                }
                let name = e.file_name();
                let name_str = name.to_str()?;
                if wildcard_match(file_name, name_str) {
                    Some(p)
                } else {
                    None
                }
            })
            .collect();
        matched.sort();
        matched
    } else if resolved.is_file() {
        vec![resolved]
    } else {
        Vec::new()
    }
}

fn read_with_includes(
    path: &Path,
    base_dir: &Path,
    visited: &mut HashSet<PathBuf>,
    depth: usize,
    file_budget: &mut usize,
    out: &mut String,
) -> std::io::Result<()> {
    const MAX_INCLUDE_DEPTH: usize = 8;
    if depth > MAX_INCLUDE_DEPTH || *file_budget == 0 {
        return Ok(());
    }
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if !visited.insert(canonical.clone()) {
        return Ok(());
    }
    *file_budget -= 1;
    let content = std::fs::read_to_string(path)?;
    for line in content.lines() {
        if let Some((key, val)) = split_kv(line)
            && key.eq_ignore_ascii_case("include")
        {
            for pat in tokenize_patterns(val) {
                for target in expand_include_pattern(&pat, base_dir) {
                    let _ =
                        read_with_includes(&target, base_dir, visited, depth + 1, file_budget, out);
                }
            }
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    visited.remove(&canonical);
    Ok(())
}

/// Read an OpenSSH config file from disk, recursively expanding `Include` directives
/// (with glob matching and cycle protection), and parse all discovered `Server` entries.
pub fn parse_file(path: &Path, default_user: &str) -> std::io::Result<Vec<Server>> {
    let base_dir = path.parent().unwrap_or_else(|| Path::new("."));
    let mut expanded = String::new();
    let mut visited = HashSet::new();
    let mut file_budget = 64usize;
    read_with_includes(
        path,
        base_dir,
        &mut visited,
        0,
        &mut file_budget,
        &mut expanded,
    )?;
    Ok(parse(&expanded, default_user))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ssh_config_cases() {
        let cfg = r#"
# Global defaults should be skipped
Host *
    ServerAliveInterval 60

Host web-1 web-2 *.internal
    HostName 192.168.10.10
    User=deploy
    Port = 2222
    IdentityFile ~/.ssh/prod_key

Match host *.example.com
    User ignored

Host db-box
    # No HostName, no Port, no IdentityFile -> defaults
"#;
        let servers = parse(cfg, "ubuntu");
        assert_eq!(servers.len(), 3);

        assert_eq!(servers[0].name, "web-1");
        assert_eq!(servers[0].host, "192.168.10.10");
        assert_eq!(servers[0].username, "deploy");
        assert_eq!(servers[0].port, 2222);
        assert_eq!(
            servers[0].auth,
            AuthMethod::Key {
                path: "~/.ssh/prod_key".to_string()
            }
        );
        assert_eq!(servers[0].group.as_deref(), Some("SSH Config"));

        assert_eq!(servers[1].name, "web-2");
        assert_eq!(servers[1].host, "192.168.10.10");

        assert_eq!(servers[2].name, "db-box");
        assert_eq!(servers[2].host, "db-box");
        assert_eq!(servers[2].username, "ubuntu");
        assert_eq!(servers[2].port, 22);
        assert_eq!(
            servers[2].auth,
            AuthMethod::Key {
                path: "~/.ssh/id_ed25519".to_string()
            }
        );
    }

    #[test]
    fn parse_ssh_config_proxy_jump_and_timeouts() {
        let cfg = r#"
Host bastion
    HostName 203.0.113.1
    User jumpuser

Host app-internal
    HostName 10.0.1.25
    User app
    ConnectTimeout 15
    ServerAliveInterval 25
    ProxyJump bastion
"#;
        let servers = parse(cfg, "root");
        assert_eq!(servers.len(), 2);
        let bastion_id = servers[0].id;
        assert_eq!(servers[1].name, "app-internal");
        assert_eq!(servers[1].timeout_secs, Some(15));
        assert_eq!(servers[1].keepalive_secs, Some(25));
        assert_eq!(servers[1].jump_hosts, vec![bastion_id]);
    }

    #[test]
    fn parse_wildcards_negation_dedup_proxyjump_none_and_tokens() {
        let cfg = r#"
ServerAliveInterval 30

Host bastion
    HostName 203.0.113.1
    User ops

Host direct-box
    HostName 198.51.100.10
    ProxyJump none

Host app.prod.internal
    HostName %h.example.com

Host app.prod.internal
    Port 2200

Host *.prod.internal
    User produser
    IdentityFile ~/.ssh/%r_key#1

Host * !bastion
    ProxyJump bastion
"#;
        let servers = parse(cfg, "root");
        assert_eq!(servers.len(), 3);

        let bastion = servers.iter().find(|s| s.name == "bastion").unwrap();
        assert!(
            bastion.jump_hosts.is_empty(),
            "negated !bastion must not get ProxyJump"
        );
        assert_eq!(bastion.keepalive_secs, Some(30));

        let direct = servers.iter().find(|s| s.name == "direct-box").unwrap();
        assert!(
            direct.jump_hosts.is_empty(),
            "ProxyJump none must override wildcard ProxyJump"
        );

        let app = servers
            .iter()
            .find(|s| s.name == "app.prod.internal")
            .unwrap();
        assert_eq!(app.host, "app.prod.internal.example.com");
        assert_eq!(app.port, 2200);
        assert_eq!(app.username, "produser");
        assert_eq!(
            app.auth,
            AuthMethod::Key {
                path: "~/.ssh/produser_key#1".to_string()
            }
        );
        assert_eq!(app.jump_hosts, vec![bastion.id]);

        assert_eq!(extract_proxy_jump_host("2001:db8::1"), "2001:db8::1");
        assert_eq!(extract_proxy_jump_host("[2001:db8::1]:2222"), "2001:db8::1");
        assert_eq!(extract_proxy_jump_host("ssh://ops@bastion:2222"), "bastion");
    }

    #[test]
    fn parse_file_expands_include_globs_and_prevents_cycles() {
        let dir = std::env::temp_dir().join(format!("serverhub-sshcfg-{}", Uuid::new_v4()));
        let conf_d = dir.join("config.d");
        std::fs::create_dir_all(&conf_d).expect("mkdir");
        let main_cfg = dir.join("config");
        let sub_cfg = conf_d.join("prod.conf");
        std::fs::write(
            &main_cfg,
            "Include config.d/*.conf\nHost main-box\n  HostName 10.0.0.1\n",
        )
        .expect("write main");
        // Deliberately include main config back to verify cycle protection.
        std::fs::write(
            &sub_cfg,
            "Include config\nHost prod-edge\n  HostName 10.1.2.3\n  User deploy\n",
        )
        .expect("write sub");

        let servers = parse_file(&main_cfg, "root").expect("parse_file");
        assert_eq!(servers.len(), 2);
        assert!(
            servers
                .iter()
                .any(|s| s.name == "prod-edge" && s.host == "10.1.2.3" && s.username == "deploy")
        );
        assert!(
            servers
                .iter()
                .any(|s| s.name == "main-box" && s.host == "10.0.0.1")
        );

        let _ = std::fs::remove_dir_all(dir);
    }
}
