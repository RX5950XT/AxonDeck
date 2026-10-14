'use strict'

/**
 * AxonDeck — Linux 效能調整的寫入權限（一次性、使用者按了「授權效能調整」才做）。
 *
 * 跟風扇同一個模式（見 fan-access-linux.js）：pkexec 安裝一條**內容固定**的 udev 規則，
 * 只把下面這幾種 sysfs 檔案改成使用者主群組可寫，別的不動：
 *   - amdgpu：device/pp_od_clk_voltage、device/power_dpm_force_performance_level、hwmon 的 power[0-9]_cap
 *   - CPU：cpufreq 的 scaling_max_freq／scaling_governor／energy_performance_preference、
 *          intel_pstate/no_turbo、cpufreq/boost
 *   - RAPL：intel-rapl:* 的 constraint_[0-9]_power_limit_uw（**不**放寬 energy_uj：那是 Platypus 旁路攻擊，維持 root 才能讀）
 *
 * NVIDIA 沒有 sysfs 介面：`nvidia-smi -pl／-lgc／-lmc／-rgc／-rmc` 要 root。
 * 每次套用／還原各走一次 pkexec（系統跳密碼視窗），參數在這裡逐一驗過才送。
 */

const fs = require('fs')
const os = require('os')
const { createPkexecRunner, accessError } = require('./fan-access-linux')

const RULE_PATH = '/etc/udev/rules.d/91-axondeck-oc.rules'
const SH = '/bin/sh'
const SUBSYSTEMS = ['hwmon', 'drm', 'cpu', 'powercap']
const TRIGGER = 'udevadm trigger ' + SUBSYSTEMS.map((s) => `--subsystem-match=${s}`).join(' ') + ' --action=change'

/** 放寬一組檔案的 shell 片段；`$$` 是 udev 的字面 `$` */
function grant(gid, files) {
  return `for f in ${files}; do [ -e $$f ] && chgrp ${gid} $$f && chmod g+w $$f; done`
}

/**
 * @param {number} gid
 */
function ruleText(gid) {
  const g = Number(gid)
  if (!Number.isInteger(g) || g < 0) throw new Error('bad gid')
  const run = (body) => `RUN+="${SH} -c '${body}; exit 0'"`
  return [
    `# AxonDeck 效能調整：讓群組 ${g} 可寫下列 sysfs 檔案（只放寬這幾種）。`,
    '# 撤銷：刪除此檔後執行 udevadm control --reload-rules && ' + TRIGGER,
    `ACTION=="add|change", SUBSYSTEM=="hwmon", ${run(`cd /sys%p || exit 0; ${grant(g, 'power[0-9]_cap')}`)}`,
    `ACTION=="add|change", SUBSYSTEM=="drm", KERNEL=="card[0-9]*", DRIVERS=="amdgpu", ${run(`cd /sys%p/device || exit 0; ${grant(g, 'pp_od_clk_voltage power_dpm_force_performance_level')}`)}`,
    `ACTION=="add|change", SUBSYSTEM=="cpu", KERNEL=="cpu[0-9]*", ${run(`cd /sys%p/cpufreq 2>/dev/null && ${grant(g, 'scaling_max_freq scaling_governor energy_performance_preference')}; ${grant(g, '/sys/devices/system/cpu/intel_pstate/no_turbo /sys/devices/system/cpu/cpufreq/boost')}`)}`,
    `ACTION=="add|change", SUBSYSTEM=="powercap", KERNEL=="intel-rapl:*", ${run(`cd /sys%p || exit 0; ${grant(g, 'constraint_[0-9]_power_limit_uw')}`)}`,
    ''
  ].join('\n')
}

const INSTALL_SCRIPT = 'set -e; umask 022; printf "%s" "$1" > ' + RULE_PATH + '; udevadm control --reload-rules; ' + TRIGGER
const REMOVE_SCRIPT = 'rm -f ' + RULE_PATH + '; udevadm control --reload-rules; ' + TRIGGER
/** $1＝nvidia-smi 絕對路徑，之後每三個一組：<index> <旗標> <值或 -> */
const NVIDIA_SCRIPT = 'set -e; smi="$1"; shift; while [ $# -ge 3 ]; do if [ "$3" = "-" ]; then "$smi" -i "$1" "$2" >/dev/null; else "$smi" -i "$1" "$2" "$3" >/dev/null; fi; shift 3; done'

const NVIDIA_FLAGS = new Set(['-pl', '-lgc', '-lmc', '-rgc', '-rmc'])
const NO_VALUE = new Set(['-rgc', '-rmc'])

/**
 * 每一組都要過：index 整數、旗標白名單、值是數字或「數字,數字」。
 * @param {Array<[number, string, string|number|null]>} ops
 */
function validateNvidiaOps(ops) {
  if (!Array.isArray(ops) || !ops.length || ops.length > 32) throw accessError('SYSMON_OC_BAD_OP', 'NVIDIA 指令不合法。')
  return ops.map(([index, flag, value]) => {
    if (!Number.isInteger(index) || index < 0 || index > 15 || !NVIDIA_FLAGS.has(flag)) {
      throw accessError('SYSMON_OC_BAD_OP', 'NVIDIA 指令不合法。')
    }
    if (NO_VALUE.has(flag)) return [String(index), flag, '-']
    const text = String(value)
    if (!/^\d{1,5}(\.\d{1,2})?$/.test(text) && !/^\d{1,5},\d{1,5}$/.test(text)) {
      throw accessError('SYSMON_OC_BAD_OP', 'NVIDIA 指令不合法。')
    }
    return [String(index), flag, text]
  })
}

/**
 * @param {{ spawnFn?: Function, exists?: (p: string) => boolean, gid?: () => number, uid?: () => number, rulePath?: string, execFile?: Function }} deps
 */
function createOcAccess(deps = {}) {
  const exists = deps.exists || ((p) => { try { return fs.existsSync(p) } catch { return false } })
  const gidFn = deps.gid || (() => os.userInfo().gid)
  const uidFn = deps.uid || (() => (typeof process.getuid === 'function' ? process.getuid() : -1))
  const rulePath = deps.rulePath || RULE_PATH
  const runner = createPkexecRunner({ spawnFn: deps.spawnFn, exists })
  const text = {
    name: 'axondeck-oc-access',
    noPkexecMessage: '系統沒有 pkexec（polkit）。請照 docs/linux-sensors.md 手動安裝效能調整的 udev 規則。',
    declinedMessage: '授權已取消，沒有變更任何設定。',
    failMessage: '安裝效能調整的 udev 規則失敗。'
  }

  return {
    isRoot: () => uidFn() === 0,
    installed: () => exists(rulePath),
    hasPkexec: () => Boolean(runner.pkexecPath()),

    async install() {
      if (uidFn() === 0) return { installed: true, already: true }
      await runner.run(INSTALL_SCRIPT, [ruleText(gidFn())], text)
      return { installed: true, already: false }
    },

    async remove() {
      if (!exists(rulePath)) return { removed: false }
      await runner.run(REMOVE_SCRIPT, [], { ...text, failMessage: '移除效能調整的 udev 規則失敗。' })
      return { removed: true }
    },

    /**
     * 跑一批 nvidia-smi：root 直接跑，否則一次 pkexec（一個密碼視窗）。
     * @param {string} smiPath 絕對路徑
     * @param {Array<[number, string, any]>} ops
     * @param {(file: string, args: string[]) => Promise<void>} execRoot root 時直接執行
     */
    async runNvidia(smiPath, ops, execRoot) {
      if (!smiPath.startsWith('/')) throw accessError('SYSMON_OC_BAD_OP', '找不到 nvidia-smi。')
      const triples = validateNvidiaOps(ops)
      if (uidFn() === 0) {
        for (const [index, flag, value] of triples) {
          await execRoot(smiPath, value === '-' ? ['-i', index, flag] : ['-i', index, flag, value])
        }
        return true
      }
      return runner.run(NVIDIA_SCRIPT, [smiPath, ...triples.flat()], {
        name: 'axondeck-oc-nvidia',
        noPkexecMessage: '調整 NVIDIA 需要 root，系統沒有 pkexec（polkit）可以授權。',
        declinedMessage: '授權已取消，NVIDIA 設定沒有變更。',
        failMessage: 'nvidia-smi 回報失敗（這張卡或驅動可能不支援這項設定）。'
      })
    }
  }
}

module.exports = { createOcAccess, ruleText, validateNvidiaOps, RULE_PATH, INSTALL_SCRIPT, REMOVE_SCRIPT, NVIDIA_SCRIPT, SUBSYSTEMS }
