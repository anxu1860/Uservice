# Contributing to Uservice

Thank you for your interest in contributing to **Uservice**! Following these lightweight guidelines keeps issues, pull requests, and git history clean and easy to maintain.

## Prerequisites

- **Rust** `>= 1.88` (with `rustfmt` and `clippy`)
- **Node.js** `>= 20` and **pnpm** `10.x`
- Platform Tauri 2 build dependencies:
  - **macOS**: Xcode Command Line Tools
  - **Windows**: WebView2 + Visual Studio C++ Build Tools
  - **Linux**: `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libssl-dev`, `libxdo-dev`, `patchelf`

## Local Development

```bash
cd app
pnpm install
pnpm tauri dev
```

## Workspace Layout

```text
├── app/                 # React + TypeScript + Tailwind frontend & Tauri 2 shell
│   ├── src/             # Frontend UI components and libraries
│   └── src-tauri/       # Tauri commands, local vault, MCP server, multi-cloud sync
├── crates/
│   ├── core/            # Server & credential models, persistence, ~/.ssh/config parser
│   ├── ssh/             # Pure-Rust SSH client (russh) & TOFU known_hosts verification
│   ├── bridge/          # Local WebSocket / RDCleanPath secure bridge for VNC & RDP
│   ├── ai/              # Multi-protocol AI client (OpenAI / Anthropic / Gemini) & redaction
│   ├── monitor/         # System stats parser
│   └── sync/            # Pluggable encrypted sync traits
└── assets/              # Brand logos and icons
```

## Code Quality Checks

Run all checks locally before opening a Pull Request:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd app && pnpm build
```

## Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat(scope): ...` — new features
- `fix(scope): ...` — bug fixes
- `refactor(scope): ...` — code restructuring without behavior change
- `perf(scope): ...` — performance improvements
- `docs: ...` — documentation updates
- `chore: ...` — build, CI, or maintenance tasks

Keep each PR focused on a single topic and avoid committing unrelated files, temporary logs, or build artifacts.

## Reporting Issues

- Always use the structured **Bug Report** or **Feature Request** issue forms.
- Search existing issues before opening a new one.
- **Never** paste passwords, private keys, Bearer tokens, or real production IPs into issues or screenshots.
