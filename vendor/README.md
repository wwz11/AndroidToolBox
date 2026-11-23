# vendor

正式产物为 Electron 便携包（`dist\Toolbox-Desktop\` / `Toolbox-Desktop_portable_YYYYMMDD.zip`）。
`vendor/` 由 `scripts\build_desktop.bat` 打入侧车 `toolbox-api`（`_internal\vendor\`）。

打包前由 `build\fetch_platform_tools.bat` 自动下载 adb；`build\verify_vendor_resources.py` 会检查下列资源是否齐全。

| 目录 | 必需文件 |
|------|----------|
| `platform-tools/` | `adb.exe`, `AdbWinApi.dll`, `AdbWinUsbApi.dll` |
| `rpmb/` | `rpmb_test_v7_dev.sh`, `mmc_utils`, `rpmbkey.bin` |
| `iozone/` | `iozone`（Android 端 push 用） |
| `emmc/` | `eMMC For SEIxxxxx 导入测试报告模版v2.0.xlsx` |
| `ota/` | `config.ini.example`（自备 OTA 包放 `%LOCALAPPDATA%\Toolbox\vendor\ota\`） |

默认配置模板在 `config_defaults/`；运行时配置写入 `%LOCALAPPDATA%\Toolbox\config\`（升级不丢）。

该目录体积较大，默认不提交到 Git。打包：`scripts\build_desktop.bat`（或根目录 `build.bat`）。
