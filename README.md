# AndroidTVTestToolBox

面向 **Android / Android TV 测试与研发调试** 的一体化桌面工具箱。基于 **Electron + React + TypeScript** 桌面壳与本地 **Python (FastAPI)** 后端服务构建，打包后内置 `adb`（Android Platform-Tools）、内嵌 `scrcpy` 及 eMMC / RPMB / iozone 测试工具，**目标电脑无需预先安装 Python 或 ADB 即可运行**。

---

## 功能特性

### 一、设备管理（多设备标签页）
在「设备」页支持同时连接与切换多台 USB / 网络 ADB 设备，顶部标签栏实时显示在线状态：
- **设备信息**：查看设备型号、Android 版本、Build Fingerprint、分辨率、DPI、存储分区容量等。
- **应用管理**：
  - 按系统/第三方筛选包名，支持模糊搜索与一键定位当前前台应用。
  - 安装本地 APK（含覆盖/降级等参数）、批量导出 APK、启用/停用、卸载、清除数据、强停。
  - 查看应用详情与运行时权限列表，支持单项授权/撤销或一键授予全部未授权权限。
- **Logcat & 诊断导出**：
  - 实时 WebSocket 流式抓取 Logcat，支持按 Tag、日志级别、缓冲区（main/system/crash 等）、包名或 PID 过滤，支持自动落盘与按大小自动切分。
  - 支持一键抓取当前日志、写入自定义日志标记、`dmesg`、`dumpsys`（预设服务补全）、`getprop`、异常现场（Crash/ANR/Tombstones）打包。
  - 支持非阻塞后台生成 `bugreport`（实时显示阶段、文件大小、已耗时及取消），不阻塞同时抓取其他日志。
- **交互式 Shell**：基于 `xterm.js` 的交互式 `adb shell` 终端，支持快捷键、命令预设管理与会话日志保存。
- **UI 层级**：抓取并查看当前屏幕 UI 树结构与节点属性。
- **设备文件管理**：
  - 远端目录浏览、路径收藏夹、排序、隐藏文件开关、设备内搜索、文本/图片在线预览与编辑、MD5 计算、权限（chmod）/复制/剪切/重命名/新建/删除。
  - **双向拖拽与实时进度**：支持从电脑拖入文件/文件夹上传（`adb push`），以及从设备列表拉取/拖出到电脑，悬浮进度卡片实时展示已传大小、速率与百分比并支持取消。
  - **存储空间填充测试**：按剩余空间百分比填充（优先 `fallocate` 秒级真实占位，不支持时自动回退至 `bs=4M` 流式 `dd`）及一键释放测试文件。
- **虚拟遥控器**：
  - 内嵌 `scrcpy` 实时投屏、鼠标点击/滑动控制、键盘映射、清晰度切换（720p / 960p / 1440p）、录屏及断线重连等待。
  - 方向键（支持按住连发与右键 `--longpress` 长按）、`Enter` 键、中英文文本输入、截图裁剪/标注编辑器、常用登录账号管理与一键填充。
  - 支持直接将 APK 拖入投屏预览区安装。
- **键值判断**：监听并校验物理遥控器按键事件与键值 ID。

### 二、专项测试与辅助工具
- **eMMC 测试**：勾选多项测试后按序串行执行（含 iozone 读写测速、重启压测、OTA 升级压测、RPMB 测试等，其中 `rpmb` 固定排在最后执行），实时查看每项进度与日志，自动生成 Excel 测试报告。
- **Monkey 测试**：可视化配置事件数、间隔、Seed、忽略崩溃/超时/安全异常等参数，支持检测并清理设备上残留的 Monkey 进程。
- **串口终端**：连接本机 COM 串口、实时交互收发、日志落盘，内置串口遥控器快捷按键面板。
- **本地效率工具**：
  - **MD5 值生成**：支持文本与大文件 MD5 计算（大小写切换）。
  - **条形码预览**：生成并预览 Code128 条形码（支持批量多行预览）。
  - **BASE64**：支持标准 / URL-Safe 编码与解码（含 JSON 自动格式化）。
  - **GOTA 序列号分割器**：按行数批量分割序列号文本并导出文件。

### 三、全局通知与历史记录
- 顶部标题栏右侧提供通知铃铛与未读角标，弹窗与历史面板均会展示**状态、来源模块与当前设备名称/SN**，支持按类型与按设备筛选历史通知。

---

## 目录结构

```text
AndroidTVToolBox/
├── desktop/                     # Electron 桌面壳 + React 19 + Vite + TypeScript 前端
│   ├── electron/                # 主进程 (main.cjs)、预加载脚本 (preload.cjs) 与图标
│   ├── scripts/                 # 前端辅助脚本（如 run-api.cjs）
│   ├── src/
│   │   ├── api/                 # 后端 HTTP / NDJSON / WebSocket 客户端封装
│   │   ├── components/          # 通用组件（标题栏、通知历史、弹窗、APK 分析等）
│   │   ├── pages/               # 一级页面（设备、eMMC、Monkey、串口、本地工具）
│   │   ├── panels/              # 业务面板（FilesPanel、RemotePanel、adb/* 等）
│   │   └── styles/              # 全局 Token 与各面板样式
│   ├── electron-builder.yml     # Electron NSIS / 便携包构建配置
│   └── package.json             # 前端依赖与脚本
├── tools/                       # Python FastAPI 后端与核心工具集
│   ├── api/                     # FastAPI 应用入口与各路由模块 (routes/)
│   ├── adb_tools/               # ADB 核心封装（设备信息、远端文件、空间填充等）
│   ├── emmc_test/               # eMMC 自动化测试与 Excel 报告生成
│   ├── remote/                  # 虚拟遥控器与内嵌 scrcpy 服务
│   ├── screenshot/              # ADB 截屏封装
│   ├── serial_terminal/         # 串口终端后端
│   ├── barcode_gen/             # 条形码生成
│   ├── base64_codec/            # Base64 编解码
│   ├── md5_tool/                # MD5 计算
│   └── unifykey/                # UnifyKey 工具
├── build/                       # Python 依赖清单、PyInstaller spec、版本号生成脚本
├── scripts/                     # 一键启动开发、打包便携版与 NSIS 安装包脚本
├── config/ & config_defaults/   # 测试参数配置与默认配置模板
├── vendor/                      # 外部工具与报告模板（iozone、rpmb、eMMC Excel 模版等）
├── docs/                        # 使用说明与专项文档
└── tests/                       # 单元测试
```

---

## 本地开发运行

### 环境要求
- **操作系统**：Windows 10 / 11（64 位）
- **Python**：3.10+（推荐 3.11 / 3.14）
- **Node.js**：20+

### 安装依赖与启动
1. 安装 Python 后端与内嵌 `scrcpy` 依赖：
   ```bash
   pip install -r build/requirements-api.txt
   pip install -r build/requirements-scrcpy.txt
   ```
2. 安装前端依赖：
   ```bash
   cd desktop
   npm install
   ```
3. 启动开发环境（同时拉起 FastAPI 后端、Vite 热更新与 Electron 窗口）：
   ```bash
   cd desktop
   npm run dev
   ```
   > 也可以直接在项目根目录运行 `scripts\desktop_dev.bat`。

---

## 编译打包与发布

### 1. 打包便携版 Zip
在项目根目录执行：
```bat
scripts\build_desktop.bat
```
脚本会自动完成以下步骤：
1. 调用 `build\write_build_version.py` 按 `年.月.序号` 自动递增版本号（例如 `2026.11.12` → `2026.11.13`）。
   - 如需指定版本号：`set TOOLBOX_APP_VERSION=2026.11.20`
   - 如需沿用当前 `desktop/package.json` 版本不递增：`set TOOLBOX_BUMP=none`
2. 检查/拉取 `vendor\platform-tools`（`adb.exe`）与内置资源。
3. 使用 Vite 构建前端，并使用 PyInstaller 将 `tools\api` 打包为独立 `toolbox-api`。
4. 使用 `electron-builder` 打包便携目录并压缩到 `dist\AndroidTVTestToolBox-Desktop_portable_<版本号>.zip`。

### 2. 发布到 GitHub Releases
1. 运行 `scripts\build_desktop.bat` 生成便携版 Zip。
2. 打开 [GitHub Releases](https://github.com/wwz11/AndroidToolBox/releases) → **Draft a new release**，Tag 填写 `v<版本号>`，上传 `dist\AndroidTVTestToolBox-Desktop_portable_<版本号>.zip` 并发布。

---

## 数据目录与配置覆盖

- **用户数据与日志目录**：`%LOCALAPPDATA%\AndroidTVTestToolBox`（升级或重装时保留用户配置、串口/Shell/Logcat 日志及本地缓存）。
- **自定义更新源**：可通过软件设置修改更新地址，或设置环境变量 `TOOLBOX_UPDATE_URL` / 编辑 `%LOCALAPPDATA%\AndroidTVTestToolBox\update-url.txt`。
- **更多文档**：参见 [docs/用户使用说明.md](docs/用户使用说明.md) 与 [docs/emmc_test.md](docs/emmc_test.md)。
