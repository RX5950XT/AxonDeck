'use strict'

/**
 * 背景看額度：額度條沒開著也照樣每 `SYNC_EVERY_MS` 同步一次，再決定要不要提醒（quota-alerts.js）
 * 或預熱 5 小時窗口（warmup.js）。講過、送過的記號存在 userData，重開 App 不重複。
 */

const fsp = require('fs').promises
const path = require('path')
const { dueReminders } = require('./quota-alerts')
const warmup = require('./warmup')

const TICK_MS = 5 * 60_000
const SYNC_EVERY_MS = 30 * 60_000
const WARM_TARGETS = Object.freeze({ claude: ['claude-code', 'claude-5h'], codex: ['codex', 'codex-5h'] })

/**
 * @param {{ usage: { load: Function, sync: Function }, notify: (title: string, body: string) => void,
 *   file: string, warmDeps: object, now?: () => number }} deps
 */
function createQuotaWatch({ usage, notify, file, warmDeps, now = Date.now }) {
  let timer = null
  let running = null

  async function readMarks() {
    try {
      const raw = JSON.parse(await fsp.readFile(file, 'utf8'))
      return { alerts: raw?.alerts && typeof raw.alerts === 'object' ? raw.alerts : {}, warm: raw?.warm && typeof raw.warm === 'object' ? raw.warm : {} }
    } catch {
      return { alerts: {}, warm: {} }
    }
  }

  async function writeMarks(marks) {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    await fsp.writeFile(tmp, JSON.stringify(marks), 'utf8')
    await fsp.rename(tmp, file)
  }

  /** 到了預熱時間的那幾家：每個時間點只輪一次，不管窗口在不在跑都記上 */
  async function warmDue(state, marks, nowMs) {
    const times = state.settings?.warmup || {}
    for (const [agent, [provider, windowId]] of Object.entries(WARM_TARGETS)) {
      const slot = warmup.dueSlot(times[agent], nowMs)
      if (slot === null || marks.warm[agent] === warmup.slotKey(slot)) continue
      const idle = warmup.windowIdle(state.accounts.find((a) => a.provider === provider), windowId, nowMs)
      if (idle === null) continue // 這輪讀不到額度：下一個 tick 再試，還在寬限時間內
      marks.warm[agent] = warmup.slotKey(slot)
      if (!idle) continue
      try {
        await warmup.warm(agent, warmDeps)
        console.log(`[quota-watch] warmed ${agent}`)
      } catch (error) {
        console.warn(`[quota-watch] warm ${agent} failed: ${error?.message || 'WARM_FAILED'}`)
      }
    }
  }

  async function tick() {
    const nowMs = now()
    let state = await usage.load()
    const marks = await readMarks()
    const before = JSON.stringify(marks)
    // 到了還沒輪過的預熱時間點：要剛讀的額度才判斷得了窗口在不在跑
    const wantsWarm = Object.keys(WARM_TARGETS).some((agent) => {
      const slot = warmup.dueSlot(state.settings?.warmup?.[agent], nowMs)
      return slot !== null && marks.warm[agent] !== warmup.slotKey(slot)
    })
    if (wantsWarm || !(nowMs - (state.lastSyncedAt || 0) < SYNC_EVERY_MS)) state = await usage.sync()
    if (state.settings?.alerts?.resetReminder !== false) {
      const due = dueReminders(state.accounts, marks.alerts, nowMs)
      marks.alerts = due.marks
      for (const alert of due.alerts) notify(alert.title, alert.body)
    }
    await warmDue(state, marks, nowMs)
    if (JSON.stringify(marks) !== before) await writeMarks(marks)
  }

  function runTick() {
    if (running) return running
    running = tick().catch((error) => console.warn(`[quota-watch] tick failed: ${error?.code || 'UNKNOWN'}`))
      .finally(() => { running = null })
    return running
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(runTick, TICK_MS)
      timer.unref?.()
      setTimeout(runTick, 60_000).unref?.()
    },
    stop() {
      clearInterval(timer)
      timer = null
      return running || Promise.resolve()
    },
    runTick
  }
}

module.exports = { createQuotaWatch }
