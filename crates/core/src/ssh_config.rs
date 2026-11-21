use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;

use crate::{AuthMethod, Server};

#[derive(Default)]
struct HostBlock {
    aliases: Vec<String>,
    hostname: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
}

fn current_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn strip_comment(line: &str) -> &str {
    let mut in_quotes = false;
    for (idx, ch) in line.char_indices() {
        match ch {
            '"' => in_quotes = !in_quotes,
            '#' if !in_quotes => return &line[..idx],
            _ => {}
        }
    }
    line
}

fn split_kv(line: &str) -> Option<(&str, &str)> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(eq_idx) = trimmed.find('=') {
        let before = trimmed[..eq_idx].trim();
        let after = trimmed[eq_idx + 1..].trim();
        // Only treat '=' as separator if the key has no whitespace
        if !before.is_empty() && !before.contains(char::is_whitespace) {
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

fn flush_block(block: Option<HostBlock>, default_user: &str, now: i64, out: &mut Vec<Server>) {
    let Some(b) = block else {
        return;
    };
    for alias in b.aliases {
        if alias.contains('*') || alias.contains('?') {
            continue;
        }
        let host = b.hostname.clone().unwrap_or_else(|| alias.clone());
        let username = b.user.clone().unwrap_or_else(|| default_user.to_string());
        let port = b.port.unwrap_or(22);
        let key_path = b
            .identity_file
            .clone()
            .unwrap_or_else(|| "~/.ssh/id_ed25519".to_string());

        out.push(Server {
            id: Uuid::new_v4(),
            name: alias,
            host,
            port,
            username,
            auth: AuthMethod::Key { path: key_path },
            group: Some("SSH Config".to_string()),
            tags: Vec::new(),
            updated_at: now,
        });
    }
}

/// Parse `~/.ssh/config` content into `Server` entries.
pub fn parse(text: &str, default_user: &str) -> Vec<Server> {
    let mut out = Vec::new();
    let mut current: Option<HostBlock> = None;
    let mut in_match = false;
    let now = current_timestamp();

    for raw_line in text.lines() {
        let line = strip_comment(raw_line).trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, val)) = split_kv(line) else {
            continue;
        };

        let lower = key.to_ascii_lowercase();
        match lower.as_str() {
            "host" => {
                flush_block(current.take(), default_user, now, &mut out);
                in_match = false;
                let aliases = val
                    .split_whitespace()
                    .map(unquote)
                    .filter(|s| !s.is_empty())
                    .collect();
                current = Some(HostBlock {
                    aliases,
                    ..Default::default()
                });
            }
            "match" => {
                flush_block(current.take(), default_user, now, &mut out);
                in_match = true;
            }
            "include" => {
                // Ignored
            }
            _ if in_match => {}
            "hostname" => {
                if let Some(b) = current.as_mut()
                    && b.hostname.is_none()
                {
                    b.hostname = Some(unquote(val));
                }
            }
            "user" => {
                if let Some(b) = current.as_mut()
                    && b.user.is_none()
                {
                    b.user = Some(unquote(val));
                }
            }
            "port" => {
                if let Some(b) = current.as_mut()
                    && b.port.is_none()
                    && let Ok(p) = unquote(val).parse::<u16>()
                    && p > 0
                {
                    b.port = Some(p);
                }
            }
            "identityfile" => {
                if let Some(b) = current.as_mut()
                    && b.identity_file.is_none()
                {
                    b.identity_file = Some(unquote(val));
                }
            }
            _ => {}
        }
    }

    flush_block(current.take(), default_user, now, &mut out);
    out
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
}
