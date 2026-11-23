# AndroidTVTestToolBox

面向 Android / Android TV 测试与调试的桌面工具箱，基于 **Electron + React + TypeScript** 与本地 **Python (FastAPI)** 后端构建，内置 `adb` 与内嵌 `scrcpy`。

## 主要功能

- **设备管理（ADB）**：多设备标签页管理、设备详情与存储容量查看、应用安装/批量管理/权限授权、实时 Logcat 抓取与 `bugreport` 流式导出、交互式 Shell、UI 层级查看。
- **设备文件管理**：远端目录浏览、拖拽上传/拉取（实时进度与取消）、文本/图片预览与编辑、空间填充测试（支持 `fallocate` 极速占位与 `dd` 回退）及一键释放。
- **虚拟遥控器**：内嵌 `scrcpy` 实时投屏与录屏、方向键（支持长按连发与右键 `--longpress`）、`Enter` 键、文本输入（支持中文）、截图裁剪标注、常用账号一键填充。
- **专项测试与本地工具**：eMMC 自动化测试与报告生成、Monkey 压力测试、按键键值判断、串口终端、Base64 / MD5 / 条码工具、GOTA 序列号分割。

## 目录结构

```text
├── desktop/          # Electron 主进程与 React + Vite 前端
├── tools/            # Python FastAPI 后端与 ADB / eMMC / 遥控器核心模块
├── build/            # Python 依赖清单、图标资源与版本生成脚本
├── scripts/          # 开发启动与 NSIS 安装包构建脚本
├── config/           # 运行配置
└── docs/             # 项目文档
```

## 开发运行

前置条件：Windows、Python 3.10+、Node.js 20+。

1. 安装 Python 依赖：
   ```bash
   pip install -r build/requirements-api.txt
   pip install -r build/requirements-scrcpy.txt
   ```
2. 安装前端依赖并启动开发环境：
   ```bash
   cd desktop
   npm install
   npm run dev
   ```

## 编译与发布（GitHub Releases）

1. 在项目根目录执行 NSIS 打包脚本（版本号按 `年.月.序号` 自动递增）：
   ```bat
   scripts\build_desktop_nsis.bat
   ```
2. 打包产物生成在 `desktop\release\`：
   - `SEIAndroidTVTestToolBox-Setup-<版本号>.exe`
   - `latest.yml`
   - `SEIAndroidTVTestToolBox-Setup-<版本号>.exe.blockmap`（可选）
3. 在 GitHub 仓库 [Releases](https://github.com/wwz11/AndroidToolBox/releases) 创建正式版 Release（Tag 为 `v<版本号>`），上传 `SEIAndroidTVTestToolBox-Setup-<版本号>.exe` 与 `latest.yml` 即可支持客户端自动检查更新。
