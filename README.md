# ServerHub

跨端开源服务器管理与 SSH 客户端（macOS / Windows / Linux，基于 Tauri 2 + Rust + React）。

## 核心特性（规划）
- 多设备配置同步（Google Drive / WebDAV，端到端加密）
- 原生毛玻璃桌面体验 + xterm.js 终端
- 无 Agent Linux 服务器监控、SFTP、端口转发、Docker 面板
- TOFU 主机指纹校验与系统密钥链集成

## 本地开发

前置依赖：Rust、Node.js、pnpm、Xcode Command Line Tools（macOS）。

```bash
cd app
pnpm install
pnpm tauri dev
```

## 测试与检查

```bash
cargo fmt --all
cargo clippy --workspace --all-targets
cargo test --workspace
```

## License

Apache-2.0
