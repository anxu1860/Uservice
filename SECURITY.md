# Security Policy

Security is a core design pillar of **Uservice** (SSH/VNC/RDP remote access, local AES-256-GCM credential vault, built-in MCP server, and end-to-end encrypted sync).

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them privately using [GitHub Security Advisories](https://github.com/anxu1860/Uservice/security/advisories/new) on this repository.

Please include as much of the following as possible:

- Affected component (e.g., SSH client, local vault, MCP server, RDP/VNC bridge, encrypted sync)
- Reproduction steps or proof of concept
- Potential impact and suggested mitigation (if any)

We aim to acknowledge reports within **72 hours** and coordinate a fix before public disclosure.

## Security Design Highlights

- **Local Credential Vault**: Secrets are encrypted with AES-256-GCM using HKDF-derived keys in SQLite with memory zeroization on drop.
- **TOFU Host Verification**: SSH host keys and RDP TLS leaf certificates are verified and pinned against mismatch attacks.
- **Local MCP Server**: Bound to loopback (`127.0.0.1`) by default, guarded by Bearer token authentication, Host/Origin validation (DNS rebinding protection), and granular per-capability switches.
- **End-to-End Encrypted Sync**: Cloud sync bundles are encrypted client-side (AES-256-GCM + PBKDF2-HMAC-SHA256) before leaving the device.
- **AI Output Redaction**: Sensitive patterns (private keys, tokens, credentials) are redacted before context is sent to external AI providers.
