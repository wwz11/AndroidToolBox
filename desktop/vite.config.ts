import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const EXPECTED_API_REV = 87;

function ensureFreshToolboxApiPlugin() {
  let checked = false;
  return {
    name: "ensure-fresh-toolbox-api",
    configureServer() {
      if (checked) return;
      checked = true;
      const port = process.env.TOOLBOX_API_PORT || "17831";
      const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1500 }, (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            const data = JSON.parse(raw);
            if (data?.service === "toolbox-api" && Number(data?.api_rev || 0) < EXPECTED_API_REV) {
              const script = path.resolve(__dirname, "scripts", "run-api.cjs");
              const child = spawn(process.execPath, [script, "--reload"], {
                cwd: __dirname,
                detached: true,
                stdio: "ignore",
                windowsHide: true,
              });
              child.unref();
            }
          } catch {
            /* ignore */
          }
        });
      });
      req.on("error", () => {});
    },
  };
}

export default defineConfig({
  plugins: [react(), ensureFreshToolboxApiPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  optimizeDeps: {
    include: [
      "exceljs",
      "@univerjs/presets",
      "@univerjs/preset-sheets-core",
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  base: "./",
});
