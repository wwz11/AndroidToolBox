const { spawn, execSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const py = process.env.TOOLBOX_PYTHON || "python";
const port = String(process.env.TOOLBOX_API_PORT || "17831");

// 启动前清理占用了同一端口的残留旧 API 进程，避免新进程因 10048 端口占用退出而继续连到旧代码
if (process.platform === "win32") {
  try {
    const out = execSync(`netstat -ano -p tcp | findstr :${port}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[1].endsWith(`:${port}`) && parts[3] === "LISTENING") {
        const pid = Number(parts[4]);
        if (pid > 0 && pid !== process.pid) pids.add(pid);
      }
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", windowsHide: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* no existing listener */
  }
}

const args = ["-m", "tools.api", "--port", port];
if (process.argv.includes("--reload") || process.env.TOOLBOX_API_RELOAD !== "0") {
  args.push("--reload");
}

const child = spawn(py, args, {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    PYTHONPATH: root + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ""),
  },
});

child.on("exit", (code) => process.exit(code ?? 0));
