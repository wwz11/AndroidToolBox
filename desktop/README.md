# SEIAndroidTVTestToolBox Desktop（Electron 桌面版）

这不是用浏览器打开的网页。界面用 Web 技术绘制，但通过 **Electron 打成 Windows 桌面程序（.exe）**，双击即可运行。

## 便携打包（目标机无需 Python / adb）

在仓库根目录执行：

```bat
scripts\build_desktop.bat
```

产出整夹便携包（内嵌 Electron、Python API 侧车、platform-tools/adb、eMMC/RPMB/iozone 等）：

- `desktop\release\win-unpacked\SEIAndroidTVTestToolBox.exe`
- 同步副本：`dist\SEIAndroidTVTestToolBox-Desktop\SEIAndroidTVTestToolBox.exe`
- 压缩包：`dist\SEIAndroidTVTestToolBox-Desktop_portable_YYYYMMDD.zip`

把整个文件夹拷到目标机即可双击运行，**不必安装 Python、adb 或其它运行时**。

关闭窗口会进入**系统托盘后台运行**；双击托盘打开，右键「退出」才真正结束。

配置 / 报告 / 自备 OTA 默认优先保存在 `<安装目录>\userdata\`（若存在旧版 `%LOCALAPPDATA%\SEIAndroidTVTestToolBox\` 数据则自动迁移；仅当安装目录无写入权限时回退到 `%LOCALAPPDATA%\SEIAndroidTVTestToolBox\`）。

## 后续升级（一键）

1. 解压**新版本**整夹（任意位置）。
2. 双击新包里的 `升级.bat`（会结束旧进程、覆盖安装目录、自动启动）。
3. `升级.bat` 会保留 `<安装目录>\userdata\` 下的配置、报告与自备包，无需手工备份。

首次升级若找不到旧目录：按提示把当前的 `SEIAndroidTVTestToolBox.exe` 拖进窗口即可。

托盘右键可「打开数据目录」「打开安装目录」。

开发机重打包：再次执行 `scripts\build_desktop.bat`。

## 开发调试（也会开桌面窗口，不是浏览器）

```bat
scripts\desktop_dev.bat
```

或：

```bat
cd desktop
npm install --cache .\.npm-cache
npm run dev
```

## 打包入口

- 推荐：`scripts\build_desktop.bat` 或仓库根目录 `build.bat`
- 旧 Tk 安装包流水线已停用（会重定向到本脚本）
