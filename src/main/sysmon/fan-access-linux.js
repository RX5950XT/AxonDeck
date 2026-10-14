'use strict'

/**
 * AxonDeck — Linux 風扇寫入權限（一次性、使用者明確同意才做）。
 *
 * hwmon 的 pwmN／pwmN_enable 預設 root 才能寫。我們不把 App 提權、不呼叫 sudo，
 * 而是讓使用者按一次「授權風扇控制」→ pkexec（系統的密碼對話框）安裝一條**內容固定**的 udev 規則：
 * 只把 hwmon 底下 pwm*／pwm*_enable 這兩種檔案的群組改成目前使用者的主群組並加 g+w。
 *
 * 為什麼是 udev 規則而不是常駐的 root helper：
 *   - 規則是純資料，不指向任何使用者可寫的程式（不會變成提權跳板；比照 Windows 版
 *     「開發版不准裝排程工作」那條）
 *   - 重開機／熱插拔後仍然有效，之後每次開 App 都不用再輸入密碼
 * 撤銷：手動刪 /etc/udev/rules.d/90-axondeck-fan.rules（見 docs/linux-sensors.md）。
 */

const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')

const RULE_PATH = '/etc/udev/rules.d/90-axondeck-fan.rules'
/** 系統工具指名絕對路徑，不靠 PATH（PATH 上可能被塞同名程式） */
const PKEXEC = ['/usr/bin/pkexec', '/bin/pkexec']
const SH = '/bin/sh'
const PKEXEC_CANCELLED = new Set([126, 127])

/**
 * 規則內容。`$$` 是 udev 的字面 `$`；`%p` 是裝置路徑。gid 只收整數。
 * @param {number} gid
 */
function ruleText(gid) {
  const g = Number(gid)
  if (!Number.isInteger(g) || g < 0) throw new Error('bad gid')
  return [
    '# AxonDeck 風扇控制：讓群組 ' + g + ' 可寫 hwmon 的 pwm*／pwm*_enable（只放寬這兩種檔案）。',
    '# 撤銷：刪除此檔後執行 udevadm control --reload-rules && udevadm trigger --subsystem-match=hwmon --action=change',
    `ACTION=="add|change", SUBSYSTEM=="hwmon", RUN+="${SH} -c 'cd /sys%p || exit 0; for f in pwm[0-9] pwm[0-9][0-9] pwm[0-9]_enable pwm[0-9][0-9]_enable; do [ -e $$f ] && chgrp ${g} $$f && chmod g+w $$f; done; exit 0'"`,
    ''
  ].join('\n')
}

/** pkexec 端跑的腳本：寫規則、重載、對現有 hwmon 補觸發一次。規則內容走 $1，不拼進腳本。 */
const INSTALL_SCRIPT = 'set -e; umask 022; printf "%s" "$1" > ' + RULE_PATH
  + '; udevadm control --reload-rules; udevadm trigger --subsystem-match=hwmon --action=change'
const REMOVE_SCRIPT = 'rm -f ' + RULE_PATH
  + '; udevadm control --reload-rules; udevadm trigger --subsystem-match=hwmon --action=change'

function accessError(code, userMessage) {
  const err = new Error(code)
  err.code = code
  err.userMessage = userMessage
  return err
}

/**
 * pkexec 執行固定腳本（`/bin/sh -c <script> <$0> <args…>`）。參數走位置參數，不拼進腳本。
 * 給風扇與效能調整共用：只有使用者按了按鈕才會呼叫，系統跳 polkit 密碼視窗。
 * @param {{ spawnFn?: Function, exists?: (p: string) => boolean }} deps
 */
function createPkexecRunner(deps = {}) {
  const spawnFn = deps.spawnFn || spawn
  const exists = deps.exists || ((p) => { try { return fs.existsSync(p) } catch { return false } })

  function pkexecPath() {
    return PKEXEC.find((p) => exists(p)) || ''
  }

  /**
   * @param {string} script
   * @param {string[]} extra
   * @param {{ name?: string, noPkexecMessage?: string, failMessage?: string, declinedMessage?: string }} [text]
   */
  function run(script, extra, text = {}) {
    const bin = pkexecPath()
    if (!bin) {
      return Promise.reject(accessError('SYSMON_FAN_NO_PKEXEC',
        text.noPkexecMessage || '系統沒有 pkexec（polkit）。請照 docs/linux-sensors.md 手動安裝 udev 規則。'))
    }
    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawnFn(bin, [SH, '-c', script, text.name || 'axondeck-fan-access', ...extra], { stdio: 'ignore' })
      } catch {
        reject(accessError('SYSMON_FAN_ACCESS_FAILED', '無法啟動 pkexec。'))
        return
      }
      child.on('error', () => reject(accessError('SYSMON_FAN_ACCESS_FAILED', '無法啟動 pkexec。')))
      child.on('close', (code) => {
        if (code === 0) resolve(true)
        else if (PKEXEC_CANCELLED.has(code)) reject(accessError('SYSMON_FAN_ACCESS_DECLINED', text.declinedMessage || '授權已取消，風扇維持由晶片自動控制。'))
        else reject(accessError('SYSMON_FAN_ACCESS_FAILED', text.failMessage || '安裝 udev 規則失敗。'))
      })
    })
  }

  return { run, pkexecPath }
}

function createFanAccess(deps = {}) {
  const exists = deps.exists || ((p) => { try { return fs.existsSync(p) } catch { return false } })
  const gidFn = deps.gid || (() => os.userInfo().gid)
  const uidFn = deps.uid || (() => (typeof process.getuid === 'function' ? process.getuid() : -1))
  const rulePath = deps.rulePath || RULE_PATH
  const runner = createPkexecRunner({ spawnFn: deps.spawnFn, exists })
  const pkexecPath = runner.pkexecPath
  const run = (script, extra) => runner.run(script, extra)

  return {
    /**
     * @param {Array<{ writable: boolean }>} channels 最近掃到的 pwm 通道（含不可寫的）
     */
    status(channels = []) {
      const total = channels.length
      const writableCount = channels.filter((c) => c.writable).length
      const installed = exists(rulePath)
      const root = uidFn() === 0
      const hasPkexec = Boolean(pkexecPath())
      let reason = ''
      if (!total) reason = '這台機器沒有公開可控的風扇 PWM（/sys/class/hwmon/*/pwm*）；筆電與虛擬機多半如此。'
      else if (writableCount === total) reason = ''
      else if (!hasPkexec) reason = `偵測到 ${total} 條 PWM 通道，但沒有寫入權限；系統沒有 pkexec，請照 docs/linux-sensors.md 手動安裝 udev 規則。`
      else if (installed) reason = `已安裝 udev 規則，但仍有 ${total - writableCount} 條通道寫不進去（可能要重新登入讓群組生效，或晶片驅動不允許手動 PWM）。`
      return {
        manual: true,
        kind: 'udev',
        installed: installed || (total > 0 && writableCount === total),
        canInstall: hasPkexec && total > 0 && writableCount < total && !root,
        stale: false,
        total,
        writable: writableCount,
        label: '授權風扇控制（pkexec）',
        hint: reason || (writableCount < total
          ? `偵測到 ${total} 條 PWM 通道，寫入需要一次系統授權（安裝 udev 規則，只放寬 pwm 檔案）。讀取溫度與轉速不需要授權。`
          : ''),
        reason
      }
    },

    async install() {
      if (uidFn() === 0) return { installed: true, already: true }
      await run(INSTALL_SCRIPT, [ruleText(gidFn())])
      return { installed: true, already: false }
    },

    async remove() {
      if (!exists(rulePath)) return { removed: false }
      await run(REMOVE_SCRIPT, [])
      return { removed: true }
    }
  }
}

module.exports = { createFanAccess, createPkexecRunner, accessError, ruleText, RULE_PATH, INSTALL_SCRIPT, REMOVE_SCRIPT, PKEXEC, SH }
