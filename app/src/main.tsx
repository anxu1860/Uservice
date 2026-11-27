import { Component, type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyAppearanceSettings, loadSettings } from "./lib/settings";
import { applyTheme, getStoredTheme } from "./lib/theme";
import "./index.css";

const ua = navigator.userAgent.toLowerCase();
const platform = ua.includes("mac")
  ? "mac"
  : ua.includes("win")
    ? "windows"
    : "linux";
document.documentElement.dataset.platform = platform;

applyTheme(getStoredTheme());
applyAppearanceSettings(loadSettings());

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null; copied: boolean }
> {
  state: { error: Error | null; copied: boolean } = {
    error: null,
    copied: false,
  };

  static getDerivedStateFromError(error: Error) {
    return { error, copied: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("App crashed:", error, info);
  }

  private copyTimer: number | null = null;

  componentWillUnmount() {
    if (this.copyTimer !== null) {
      window.clearTimeout(this.copyTimer);
      this.copyTimer = null;
    }
  }

  handleCopy = () => {
    const err = this.state.error;
    if (!err) return;
    const text = err.stack || err.message || String(err);
    void navigator.clipboard?.writeText(text).then(() => {
      this.setState({ copied: true });
      if (this.copyTimer !== null) {
        window.clearTimeout(this.copyTimer);
      }
      this.copyTimer = window.setTimeout(() => {
        this.copyTimer = null;
        this.setState({ copied: false });
      }, 2000);
    });
  };

  handleResetSettings = () => {
    try {
      localStorage.removeItem("serverhub.settings.v1");
    } catch {
      // Ignore storage errors
    }
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 28,
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            color: "var(--foreground, #111827)",
            background: "var(--content-bg, #ffffff)",
            height: "100vh",
            overflow: "auto",
            userSelect: "text",
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <div>
            <h2
              style={{
                fontSize: 18,
                fontWeight: 600,
                color: "#ef4444",
                marginBottom: 6,
              }}
            >
              界面渲染异常
            </h2>
            <p style={{ fontSize: 13, opacity: 0.75, margin: 0 }}>
              应用遇到未捕获的前端异常，你的服务器配置与密钥数据未受影响。可以尝试恢复界面或重新加载。
            </p>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                padding: "7px 14px",
                borderRadius: 10,
                border: "none",
                background: "#007aff",
                color: "#ffffff",
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              重新加载应用
            </button>
            <button
              type="button"
              onClick={() => this.setState({ error: null, copied: false })}
              style={{
                padding: "7px 14px",
                borderRadius: 10,
                border: "1px solid rgba(128,128,128,0.3)",
                background: "transparent",
                color: "inherit",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              尝试恢复界面
            </button>
            <button
              type="button"
              onClick={this.handleCopy}
              style={{
                padding: "7px 14px",
                borderRadius: 10,
                border: "1px solid rgba(128,128,128,0.3)",
                background: "transparent",
                color: "inherit",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {this.state.copied ? "已复制错误堆栈" : "复制错误信息"}
            </button>
            <button
              type="button"
              onClick={this.handleResetSettings}
              style={{
                padding: "7px 14px",
                borderRadius: 10,
                border: "1px solid rgba(239,68,68,0.35)",
                background: "transparent",
                color: "#ef4444",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              重置本地设置并刷新
            </button>
          </div>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "ui-monospace, Menlo, monospace",
              fontSize: 12,
              lineHeight: 1.5,
              padding: 14,
              borderRadius: 12,
              background: "rgba(239, 68, 68, 0.08)",
              color: "#ef4444",
              margin: 0,
            }}
          >
            {this.state.error.stack || this.state.error.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
