const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("toolbox", {
  apiBase: process.env.TOOLBOX_API_URL || "http://127.0.0.1:17831",
  apiToken: process.env.TOOLBOX_API_TOKEN || "",
  platform: process.platform,
  /** 尝试重启本地 API 侧车 */
  restartApi: async () => {
    try {
      const r = await ipcRenderer.invoke("toolbox:restart-api");
      return r && typeof r === "object" ? r : { ok: false };
    } catch (err) {
      return {
        ok: false,
        message: String(err?.message || err || "重启失败"),
      };
    }
  },
  /** Electron：从 File 对象取本机绝对路径 */
  pathForFile: (file) => {
    try {
      if (!file || typeof webUtils?.getPathForFile !== "function") return "";
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  /** 拖出到系统资源管理器（需本机已有文件） */
  startDrag: (filePath) => {
    try {
      if (!filePath) return;
      ipcRenderer.send("toolbox:drag-start", String(filePath));
    } catch {
      /* ignore */
    }
  },
  /** 选择本机目录；取消返回空字符串 */
  chooseDirectory: async (opts) => {
    try {
      const dir = await ipcRenderer.invoke("toolbox:choose-directory", {
        title: opts?.title || "选择保存目录",
        defaultPath: opts?.defaultPath || "",
      });
      return typeof dir === "string" ? dir : "";
    } catch {
      return "";
    }
  },
  /** 用资源管理器打开文件/目录 */
  openPath: async (filePath) => {
    try {
      const r = await ipcRenderer.invoke("toolbox:open-path", String(filePath || ""));
      return r && typeof r === "object"
        ? r
        : { ok: false, path: "", message: "打开失败" };
    } catch (err) {
      return {
        ok: false,
        path: "",
        message: String(err?.message || err || "打开失败"),
      };
    }
  },
  /** 选择本机文件；取消返回空字符串 */
  chooseFile: async (opts) => {
    try {
      const file = await ipcRenderer.invoke("toolbox:choose-file", {
        title: opts?.title || "选择文件",
        defaultPath: opts?.defaultPath || "",
        filters: opts?.filters || undefined,
      });
      return typeof file === "string" ? file : "";
    } catch {
      return "";
    }
  },
  /** 读取本机文件为 base64 */
  readFileBase64: async (filePath) => {
    try {
      const r = await ipcRenderer.invoke(
        "toolbox:read-file-base64",
        String(filePath || ""),
      );
      return r && typeof r === "object"
        ? r
        : { ok: false, message: "读取失败" };
    } catch (err) {
      return {
        ok: false,
        message: String(err?.message || err || "读取失败"),
      };
    }
  },
  /** 保存 base64 到本机（可弹另存为） */
  saveFileBase64: async (opts) => {
    try {
      const r = await ipcRenderer.invoke("toolbox:save-file-base64", {
        title: opts?.title || "保存文件",
        defaultPath: opts?.defaultPath || "",
        filters: opts?.filters || undefined,
        dataBase64: opts?.dataBase64 || "",
        forceDialog: Boolean(opts?.forceDialog),
      });
      return r && typeof r === "object"
        ? r
        : { ok: false, canceled: false, message: "保存失败" };
    } catch (err) {
      return {
        ok: false,
        canceled: false,
        message: String(err?.message || err || "保存失败"),
      };
    }
  },
  /** 默认拉取目录 */
  defaultPullDir: async () => {
    try {
      const dir = await ipcRenderer.invoke("toolbox:default-pull-dir");
      return typeof dir === "string" ? dir : "";
    } catch {
      return "";
    }
  },
  /** 默认 GOTA 分割输出目录 */
  defaultGotaDir: async () => {
    try {
      const dir = await ipcRenderer.invoke("toolbox:default-gota-dir");
      return typeof dir === "string" ? dir : "";
    } catch {
      return "";
    }
  },
  /** 主进程请求关闭确认 */
  onClosePrompt: (handler) => {
    const onMsg = () => {
      try {
        ipcRenderer.send("toolbox:close-prompt-ack");
      } catch {
        /* ignore */
      }
      try {
        handler();
      } catch {
        /* ignore */
      }
    };
    ipcRenderer.on("toolbox:close-prompt", onMsg);
    return () => {
      try {
        ipcRenderer.removeListener("toolbox:close-prompt", onMsg);
      } catch {
        /* ignore */
      }
    };
  },
  replyClosePrompt: (action) => {
    try {
      ipcRenderer.send("toolbox:close-prompt-result", action);
    } catch {
      /* ignore */
    }
  },
  onAppPrompt: (handler) => {
    const onMsg = (_e, spec) => {
      try {
        handler(spec || {});
      } catch {
        /* ignore */
      }
    };
    ipcRenderer.on("toolbox:app-prompt", onMsg);
    return () => {
      try {
        ipcRenderer.removeListener("toolbox:app-prompt", onMsg);
      } catch {
        /* ignore */
      }
    };
  },
  onAppPromptDismiss: (handler) => {
    const onMsg = () => {
      try {
        handler();
      } catch {
        /* ignore */
      }
    };
    ipcRenderer.on("toolbox:app-prompt-dismiss", onMsg);
    return () => {
      try {
        ipcRenderer.removeListener("toolbox:app-prompt-dismiss", onMsg);
      } catch {
        /* ignore */
      }
    };
  },
  ackAppPrompt: () => {
    try {
      ipcRenderer.send("toolbox:app-prompt-ack");
    } catch {
      /* ignore */
    }
  },
  replyAppPrompt: (action) => {
    try {
      ipcRenderer.send("toolbox:app-prompt-result", action);
    } catch {
      /* ignore */
    }
  },
  checkForUpdates: async () => {
    try {
      return await ipcRenderer.invoke("toolbox:check-for-updates");
    } catch (err) {
      return {
        ok: false,
        message: String(err?.message || err || "检查更新失败"),
      };
    }
  },
  getAppVersion: async () => {
    try {
      const v = await ipcRenderer.invoke("toolbox:get-app-version");
      return typeof v === "string" ? v : "";
    } catch {
      return "";
    }
  },
  windowControls: async () => {
    try {
      const r = await ipcRenderer.invoke("toolbox:window-controls");
      return r && typeof r === "object" ? r : {};
    } catch {
      return {};
    }
  },
  windowMinimize: () => ipcRenderer.invoke("toolbox:window-minimize"),
  windowToggleMaximize: () =>
    ipcRenderer.invoke("toolbox:window-toggle-maximize"),
  windowClose: () => ipcRenderer.invoke("toolbox:window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("toolbox:window-is-maximized"),
  windowIsAlwaysOnTop: () =>
    ipcRenderer.invoke("toolbox:window-is-always-on-top"),
  windowToggleAlwaysOnTop: () =>
    ipcRenderer.invoke("toolbox:window-toggle-always-on-top"),
  getAppSettings: async () => {
    try {
      const r = await ipcRenderer.invoke("toolbox:get-app-settings");
      return r && typeof r === "object" ? r : {};
    } catch {
      return {};
    }
  },
  setAppSettings: async (patch) => {
    try {
      const r = await ipcRenderer.invoke("toolbox:set-app-settings", patch || {});
      return r && typeof r === "object" ? r : {};
    } catch {
      return {};
    }
  },
  onWindowMaximized: (handler) => {
    const onMsg = (_e, maximized) => {
      try {
        handler(Boolean(maximized));
      } catch {
        /* ignore */
      }
    };
    ipcRenderer.on("toolbox:window-maximized", onMsg);
    return () => {
      try {
        ipcRenderer.removeListener("toolbox:window-maximized", onMsg);
      } catch {
        /* ignore */
      }
    };
  },
  clipboardWriteText: async (text) => {
    try {
      return Boolean(
        await ipcRenderer.invoke("toolbox:clipboard-write", String(text ?? "")),
      );
    } catch {
      return false;
    }
  },
  clipboardReadText: async () => {
    try {
      const t = await ipcRenderer.invoke("toolbox:clipboard-read");
      return typeof t === "string" ? t : "";
    } catch {
      return "";
    }
  },
  tideOaLogin: async () => {
    try {
      const r = await ipcRenderer.invoke("toolbox:tide-oa-login");
      return r && typeof r === "object"
        ? r
        : { ok: false, message: "Tide OA 登录失败" };
    } catch (err) {
      return {
        ok: false,
        message: String(err?.message || err || "Tide OA 登录失败"),
      };
    }
  },
  openOAuthWindow: async (opts) => {
    try {
      const r = await ipcRenderer.invoke("toolbox:open-oauth-window", opts || {});
      return r && typeof r === "object"
        ? r
        : { ok: false, closed: true, message: "打开登录窗口失败" };
    } catch (err) {
      return {
        ok: false,
        closed: true,
        message: String(err?.message || err || "打开登录窗口失败"),
      };
    }
  },
  closeOAuthWindow: async () => {
    try {
      return Boolean(await ipcRenderer.invoke("toolbox:close-oauth-window"));
    } catch {
      return false;
    }
  },
  reportActivity: (payload) => {
    try {
      ipcRenderer.send("toolbox:activity", {
        id: payload?.id || "",
        active: Boolean(payload?.active),
        label: payload?.label || "",
      });
    } catch {
      /* ignore */
    }
  },
  onUpdateStatus: (handler) => {
    const onMsg = (_e, payload) => {
      try {
        handler(payload || {});
      } catch {
        /* ignore */
      }
    };
    ipcRenderer.on("toolbox:update-status", onMsg);
    return () => {
      try {
        ipcRenderer.removeListener("toolbox:update-status", onMsg);
      } catch {
        /* ignore */
      }
    };
  },
});
