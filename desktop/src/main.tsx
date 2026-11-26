import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ErrorBoundary from "./components/ErrorBoundary";
import { DialogProvider } from "./components/dialog";
import { ToastProvider } from "./components/toast";
import { initTheme } from "./theme";
import App from "./App";
import "./styles.css";
import "./styles/tokens.css";
import "./styles/ui.css";
import "./styles/toast.css";
import "./styles/about.css";
import "./styles/panel-common.css";
import "./styles/panels/apps.css";
import "./styles/panels/shell.css";
import "./styles/panels/logcat.css";
import "./styles/panels/emmc.css";
import "./styles/panels/monkey.css";
import "./styles/panels/files.css";
import "./styles/panels/serial.css";
import "./styles/panels/info.css";
import "./styles/panels/remote.css";
import "./styles/panels/keycheck.css";

initTheme();

const root = document.getElementById("root")!;
createRoot(root).render(
  <StrictMode>
    <DialogProvider>
      <ToastProvider>
        <ErrorBoundary title="页面渲染异常">
          <App />
        </ErrorBoundary>
      </ToastProvider>
    </DialogProvider>
  </StrictMode>,
);
