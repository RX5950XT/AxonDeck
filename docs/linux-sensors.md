# Linux：感測器、風扇與效能調整

系統監控頁在 Linux 不用 LibreHardwareMonitor sidecar，改由主程序直接讀 sysfs（`src/main/sysmon/sensors-linux.js`、`hwmon-linux.js`），輸出格式與 Windows sidecar 相同，所以風扇曲線、感測器面板、超頻面板都共用同一套 UI。

## 讀取（不需要 root）

| 來源 | 內容 |
| --- | --- |
| `/sys/class/hwmon/hwmon*/` | `temp*_input`、`fan*_input`、`in*_input`、`curr*_input`、`power*_input`／`power*_average`、`freq*_input`、`*_label`；`name` 決定分類（`k10temp`／`coretemp` → CPU、`amdgpu` → AMD GPU、`i915`／`xe` → Intel GPU、`nvme`／`drivetemp` → 儲存、`nct*`／`it87`／`f71882fg`… → 主機板 Super I/O） |
| `/sys/class/thermal/thermal_zone*/` | `type`＋`temp`；同名 hwmon 已有就不重複列（`x86_pkg_temp` 會變成 CPU 的 `Package`） |
| `/sys/class/powercap/intel-rapl:*/energy_uj` | 兩次取樣相減換算 CPU 封裝功耗（W）；部分發行版預設 root 才能讀，讀不到就不顯示 |
| `/sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq` | 每核時脈 |
| `/proc/stat` | CPU 總使用率 |
| `nvidia-smi` | NVIDIA 卡的溫度／功耗／時脈／使用率／風扇（沿用既有 GPU 取樣，裝了驅動才有） |

虛擬機與容器通常沒有任何 hwmon／thermal，頁面會顯示「這台機器沒有公開任何溫度感測器」，其餘 CPU／記憶體／磁碟／網路照常。

## 風扇控制（需要一次授權）

`pwmN`／`pwmN_enable` 預設只有 root 能寫。AxonDeck **不會**自己呼叫 sudo，也不會常駐 root 程序。
在「風扇」分頁按「授權風扇控制（pkexec）」才會跳出系統的 polkit 密碼視窗，安裝一條內容固定的 udev 規則：

```
/etc/udev/rules.d/90-axondeck-fan.rules
ACTION=="add|change", SUBSYSTEM=="hwmon", RUN+="/bin/sh -c 'cd /sys%p || exit 0; for f in pwm[0-9] pwm[0-9][0-9] pwm[0-9]_enable pwm[0-9][0-9]_enable; do [ -e $$f ] && chgrp <你的主群組 gid> $$f && chmod g+w $$f; done; exit 0'"
```

它只把 hwmon 底下 `pwm*` 與 `pwm*_enable` 兩種檔案改成你的主群組可寫，別的檔案權限都不動。若你的主群組是多人共用的（例如 `users`），同群組的其他帳號也會取得風扇寫入權。

### 沒有 pkexec 時手動安裝

```sh
gid=$(id -g)
sudo tee /etc/udev/rules.d/90-axondeck-fan.rules >/dev/null <<RULE
ACTION=="add|change", SUBSYSTEM=="hwmon", RUN+="/bin/sh -c 'cd /sys%p || exit 0; for f in pwm[0-9] pwm[0-9][0-9] pwm[0-9]_enable pwm[0-9][0-9]_enable; do [ -e \$\$f ] && chgrp $gid \$\$f && chmod g+w \$\$f; done; exit 0'"
RULE
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=hwmon --action=change
```

### 撤銷

目前介面沒有「移除授權」按鈕，請手動：

```sh
sudo rm /etc/udev/rules.d/90-axondeck-fan.rules
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=hwmon --action=change
```

（已改過的權限會在下次開機或驅動重新載入時回到預設。）

### 接手與歸還

- 寫入前先記下每條通道原本的 `pwmN_enable` 與 `pwmN`，接手時設 `pwmN_enable=1`（手動）再寫 `pwmN`（0–100% → 0–255）。
- 曲線引擎停止、App 結束、或 5 秒沒收到新指令（看門狗）時，全部寫回原本的 `pwmN_enable`（通常是 2＝晶片自動）。
- 筆電、多數虛擬機、部分主機板驅動（例如沒載入 `nct6775`／`it87`）不公開 PWM，此時只顯示轉速。

## 效能調整（時脈／功耗牆）

Linux 版不寫 SMU／GPU 暫存器（Windows 版的 PBO、Curve Optimizer、NVAPI V/F 曲線沒有對應的安全介面），只用核心與驅動公開的介面（`src/main/sysmon/oc-linux*.js`）：

| 裝置 | 可調項 | 介面 | 上下限來源 |
| --- | --- | --- | --- |
| CPU | 時脈上限、調速器、EPP、加速開關 | `cpufreq/policyN/scaling_max_freq`／`scaling_governor`／`energy_performance_preference`、`intel_pstate/no_turbo` 或 `cpufreq/boost` | `cpuinfo_min/max_freq`、`scaling_available_governors`、`energy_performance_available_preferences` |
| CPU | PL1／PL2 功耗牆 | `/sys/class/powercap/intel-rapl:N/constraint_M_power_limit_uw` | `constraint_M_max_power_uw`；沒有就取原始值的 50%～150% |
| AMD 顯示卡 | 功耗上限 | `hwmon/power1_cap` | `power1_cap_min／_max`（百分比相對 `power1_cap_default`） |
| AMD 顯示卡 | 核心／記憶體時脈上限偏移、電壓偏移 | `pp_od_clk_voltage`（`s 1`／`m 1`／`vo`，再 `c` 提交） | `OD_RANGE`，另外偏移限制在 ±500／±1000 MHz、電壓只准 -100～0 mV（除非 `OD_RANGE` 另有範圍） |
| AMD 顯示卡 | 效能等級 | `power_dpm_force_performance_level`（auto／high／low） | — |
| NVIDIA | 功耗上限、核心／記憶體時脈上限（只能往下） | `nvidia-smi -pl`、`-lgc 0,<MHz>`／`-lmc 0,<MHz>`，解除 `-rgc`／`-rmc` | `power.min_limit`～`power.max_limit`、`clocks.max.*` |

### AMD OverDrive

`pp_od_clk_voltage` 要 amdgpu 的 OverDrive 功能位元（`ppfeaturemask` 的 0x4000）才會出現。沒開時畫面會顯示目前值與建議的開機參數，例如：

```
amdgpu.ppfeaturemask=0xfff7ffff
```

加在開機參數（GRUB 的 `GRUB_CMDLINE_LINUX_DEFAULT`）後重開機。功耗上限與效能等級不受影響。

### 安全措施

- 只寫你動過的項目；值一律夾在上表的上下限。
- 拉高功耗牆（AMD／NVIDIA ＞100%、RAPL 高於原始值）、正的時脈偏移、任何電壓偏移 → 會先跳確認視窗。
- 每個值第一次寫之前記下原始值（連同 `boot_id` 存在設定裡，App 當掉重開還原得回去；重開機後作廢，因為 sysfs 本來就回出廠了）。「還原原始值」寫回它們。
- 套用期間每秒看溫度，達到過熱門檻（預設 95 °C）或全部讀不到就自動還原；完全讀不到溫度時不准套用。
- 關閉 App 時同步寫回 sysfs 的原始值。**NVIDIA 例外**：還原要 root，關 App 時不會跳密碼視窗，設定會留到重開機或下一次按「還原原始值」。過熱自動還原也一樣跳過 NVIDIA（並在畫面提示）；NVIDIA 在 Linux 只能往下鎖頻、功耗牆最高到驅動允許的 `power.max_limit`，卡本身的溫度保護仍然有效。
- 不開機自動套用。

### 授權

sysfs 那幾個檔案預設 root 才能寫。在「效能調整」分頁按「授權效能調整（pkexec）」，用 polkit 安裝 `/etc/udev/rules.d/91-axondeck-oc.rules`（內容固定，只放寬下面這幾種檔案給你的主群組）：

- hwmon：`power[0-9]_cap`
- amdgpu：`pp_od_clk_voltage`、`power_dpm_force_performance_level`
- cpufreq：`scaling_max_freq`、`scaling_governor`、`energy_performance_preference`、`intel_pstate/no_turbo`、`cpufreq/boost`
- RAPL：`constraint_[0-9]_power_limit_uw`（**不**放寬 `energy_uj`：那是 Platypus 旁路攻擊的來源，維持 root 才能讀）

規則全文可在 `src/main/sysmon/oc-access-linux.js` 的 `ruleText` 看到。撤銷（介面目前沒有按鈕）：

```sh
sudo rm /etc/udev/rules.d/91-axondeck-oc.rules
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=hwmon --subsystem-match=drm --subsystem-match=cpu --subsystem-match=powercap --action=change
```

NVIDIA 沒有 sysfs 介面，每次套用／還原各跳一次 pkexec 密碼視窗（一次套用的所有 nvidia-smi 指令合併成一次授權）；參數在送出前逐一驗過（旗標白名單、數字格式）。以 root 執行 App 時全部直接寫，不跳視窗。

## 測試

- `node scripts/test-sysmon-oc-linux.js`：假的 sysfs 樹（4 個 cpufreq policy、RAPL、RDNA2 amdgpu＋模擬 `pp_od_clk_voltage` 規則的假核心）、假的 `nvidia-smi`、假 pkexec（照真的 argv 跑 NVIDIA 腳本）：邊界、確認、套用、還原、過熱、當掉重開、OverDrive 沒開、權限不足。
- `node scripts/test-sysmon-sensors-linux.js`：用假的 sysfs 樹（k10temp、nct6798、amdgpu、nvme、acpitz、x86_pkg_temp、RAPL、cpufreq）驗分類、讀數、風扇來源、PWM 接手／歸還／看門狗、唯讀模式、pkexec 指令組裝。
- 真硬體（實體機的 hwmon、PWM 寫入、效能調整的 cpufreq／RAPL／amdgpu OverDrive／nvidia-smi 寫入、pkexec／udev 安裝流程）**尚未實測**：開發用的 Linux 測試機是沒有任何 hwmon／thermal／cpufreq／GPU 的虛擬機。
