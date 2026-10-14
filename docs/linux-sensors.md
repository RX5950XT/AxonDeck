# Linux：感測器、風扇與超頻

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

## 超頻／效能調整

Linux 版不支援。Windows 版靠 PawnIO／NVAPI 直接寫 SMU 與顯示卡暫存器；Linux 沒有對應且安全的免驅動介面（`amdgpu` 的 `pp_od_clk_voltage` 需要 root 與開機參數 `amdgpu.ppfeaturemask`）。面板維持唯讀並顯示原因。

## 測試

- `node scripts/test-sysmon-sensors-linux.js`：用假的 sysfs 樹（k10temp、nct6798、amdgpu、nvme、acpitz、x86_pkg_temp、RAPL、cpufreq）驗分類、讀數、風扇來源、PWM 接手／歸還／看門狗、唯讀模式、pkexec 指令組裝。
- 真硬體（實體機的 hwmon、PWM 寫入、pkexec／udev 安裝流程、nvidia-smi）**尚未實測**：開發用的 Linux 測試機是沒有任何 hwmon／thermal 的虛擬機。
