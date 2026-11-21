import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import ReactDOM from "react-dom/client";
import App from "./App";
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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
