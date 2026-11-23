# eMMC 测试说明

SEIAndroidTVTestToolBox **eMMC测试** 页用于 eMMC 导入验证，包含 5 个子项，结果统一写入同一份 Excel 测试报告。

---

## 一、使用前准备

| 项目 | 说明 |
|------|------|
| 设备连接 | USB 连接测试机，顶部 ADB 栏可刷新 SN |
| adb | 打包版自带 `vendor/platform-tools/adb.exe`，无需单独安装 |
| 资源目录 | 程序目录下 `vendor/`：`iozone`、`rpmb`、报告模版、OTA 包目录 |
| 流程号 | **必填**，同一流程号的多项测试写入**同一份报告** |

### 打包后目录结构

```
程序目录/
├── SEIAndroidTVTestToolBox.exe
├── config/              ← 各子项默认 ini
├── vendor/              ← adb、iozone、rpmb、报告模版、OTA 包
├── output/emmc/reports/ ← 测试报告（运行后生成）
└── logs/emmc/           ← 测试日志（运行后生成）
```

OTA 包请放到：`vendor/ota/ota_package.zip`（按项目自行准备，体积大不随安装包分发）。

---

## 二、测试报告流程

1. 填写顶部 **流程号**。
2. 首次测试前点击 **「填写报告头部」**，填写导入项目、eMMC 规格、测试人员等；勾选 **A/B 升级** 则 OTA 为必测项。
3. 确认后自动创建报告，文件名格式：

   `eMMC For {导入项目} 导入测试报告模版v2.0 {流程号}.xlsx`

   报告标题：`eMMC For {导入项目} 导入测试报告2.0`

4. 报告输出目录：`output/emmc/reports/`（可点 **「打开报告目录」**）。
5. 各子项测试完成后自动写入报告，并刷新 **测试初判结果**。

> 若报告已存在，填好流程号后直接开始测试即可，无需重复填表头。  
> 写入报告前请关闭已打开的 Excel 文件，否则可能因文件被占用而失败。

---

## 三、测试子项

### 1. 读写压力测试

**目的**：循环 dd 读写校验，验证 eMMC 数据完整性。

**操作**：

- 选择 SN，设置停止条件：**按次数**（循环次数）或 **按时长**（分钟），二选一。
- 点击 **开始测试**。

**流程**：

- `adb root` → 自动检测分区（`/dev/block/by-name/super` 或 `/dev/block/system`）。
- 每轮：写入 → 读出 → `cmp` 校验 → 删除临时文件。

**判定**：读写校验全部成功 → **Pass**，否则 **Fail**。

**配置**：`config/emmc_stress.ini`

---

### 2. iozone 读写速度

**目的**：测量 eMMC 顺序/随机读写速率。

**操作**：

- 选择 SN、文件大小（MB，常用 **100**）。
- 可选 **三星 eMMC**（判定标准不同）。
- 点击 **开始测试**。

**流程**：

- push `vendor/iozone/iozone` 到设备。
- 连续跑 **3 次**，取平均值写入报告（100M 对应报告必测项）。

**判定**：

| 类型 | Pass 条件 |
|------|-----------|
| 普通 eMMC | 平均 write_rate ≥ 100 MB/s **且** read_rate ≥ 100 MB/s |
| 三星 eMMC | 平均 write_rate ≥ 40 MB/s |

**配置**：`config/emmc_iozone.ini`（`iozone_bin = vendor/iozone/iozone`）

---

### 3. reboot 测试

**目的**：验证反复重启后系统能否正常开机。

**操作**：

- 选择 SN，设置停止条件：**按时长**（小时）或 **按次数**，二选一。
- 点击 **开始测试**。

**流程**：

- 循环 `adb reboot`。
- 等待 `sys.boot_completed=1`（**不要求进入 Launcher**）。

**判定**：

- 达到设定时长且 **失败次数 = 0** → **Pass**。
- 任一次开机超时 → 记失败；有失败 → **Fail**。

**参考时长**：基本测试 1 小时，全量测试 24 小时。

**配置**：`config/emmc_reboot.ini`

---

### 4. RPMB 测试

**目的**：RPMB 分区可靠性测试（**破坏性测试**）。

**操作**：

- 选择 SN，设置运行时间（分钟）。
- 点击 **开始测试**。

**流程**：

- push `vendor/rpmb/` 下脚本与密钥（`rpmb_test_v7_dev.sh`、`mmc_utils`、`rpmbkey.bin`）到设备并执行。
- 到设定时间后程序停止设备端脚本。

**判定**：

- 达到时长且脚本未异常退出 → **Pass**。
- 未到时间脚本退出，或日志出现失败关键字 → **Fail**。

**⚠ 注意**：测试完成后设备重启不可用，需更换 eMMC 芯片（正常现象）。开始前会弹窗确认。

**配置**：`config/emmc_rpmb.ini`（`assets_dir = vendor/rpmb`）

---

### 5. OTA 测试 v5

**目的**：A/B 升级压力测试（仅 **A/B 升级** 项目必测）。

**操作**：

- 将 OTA 包放到 `vendor/ota/ota_package.zip`（或通过界面选择）。
- 设置停止条件：**按次数**（升级轮次）或 **按时长**（最大运行分钟），二选一；以及超时、间隔等。
- 点击 **开始测试**。

**流程**：

- 解析 OTA ZIP → `adb root` 推送 → `update_engine` 预检 → `update_engine_client` 升级 → 成功后重启。
- 循环至设定轮次，或达到最大运行时长。

**判定**：失败次数为 0 且完成目标 → **Pass**。

**配置**：`config/emmc_ota_v5.ini`（高级项如 engine 预检、cancel 等见该文件）。

**失败日志**：`logs/emmc/ota_v5_fail_logs/`

---

## 四、测试初判结果（自动汇总）

报告第 9 行 **测试初判结果** 由程序自动计算：

| 规则 | 说明 |
|------|------|
| **必测项** | iozone(100M)、读写压力、reboot、RPMB |
| **A/B 升级** | 另加 OTA；非 A/B 时 OTA 标 **N/A**，不参与初判 |
| **Pass** | 全部必测项均为 Pass |
| **Fail** | 任一项 Fail |
| **留空** | 必测项尚未全部完成 |

填写报告头部时可勾选 **「A/B 升级（需执行 OTA 升级压力测试）」** 以控制 OTA 是否纳入初判。

---

## 五、配置文件一览

| 文件 | 对应子项 |
|------|----------|
| `config/emmc_stress.ini` | 读写压力测试 |
| `config/emmc_iozone.ini` | iozone 读写速度 |
| `config/emmc_reboot.ini` | reboot 测试 |
| `config/emmc_rpmb.ini` | RPMB 测试 |
| `config/emmc_ota_v5.ini` | OTA 测试 v5 |

配置路径均相对程序根目录；打包后首次运行若缺少 config，会从内置模板自动复制。

---

## 六、建议测试顺序

```
填写流程号 → 填写报告头部 → iozone(100M) → 读写压力 → reboot → OTA(若 A/B) → RPMB
```

RPMB 为破坏性测试，必须放在最后；OTA 需提前准备好 OTA 包。

---

## 七、一键自动化

eMMC 测试页顶部 **「自动化测试」** 区域支持单台设备按序执行多项测试：

1. 勾选要执行的子项（默认含 iozone、读写压力、reboot、RPMB；OTA 需手动勾选）。
2. 填写 **流程号** 与 **SN**（与各 Tab 共用；自动化开始前会同步到各子项）。
3. 点击 **「一键自动化」**，确认顺序与 RPMB 破坏性提示后开始。
4. 每项参数取自对应 Tab 界面与 `config/*.ini`（运行时长、loop_num、OTA 包路径等请提前配好）。
5. **「失败时停止」** 默认开启：任一项 Fail 则中止后续项；取消勾选则继续跑完队列。
6. **RPMB** 若勾选会自动排在最后；**OTA** 仅在勾选且报告头部为 A/B 升级时执行。

自动化日志显示在「自动化测试」区域；各子项详细日志仍在对应 Tab。

**注意**：读写压力测试进行中无法中途跳过，需等当前轮次结束；reboot / OTA 可通过「停止自动化」请求停止。

---

## 八、常见问题

**Q：找不到 adb / iozone / 报告模版？**  
A：确认程序目录下存在 `vendor/` 文件夹；打包版资源在 `vendor/` 或 `_internal/vendor/`，首次启动会自动展开。

**Q：测试初判结果一直为空？**  
A：必测项（iozone 100M、读写压力、reboot、RPMB）须全部 Pass 后才会显示 Pass；缺项或仅有部分结果时留空。

**Q：写入报告失败 Permission denied？**  
A：关闭 Excel 中已打开的同一份报告后再试。

**Q：RPMB 测试后设备无法开机？**  
A：正常现象，需更换 eMMC 芯片后继续其他验证。
