#!/usr/bin/env node
/**
 * 額度提醒與 5 小時窗口預熱（`src/main/usage/quota-alerts.js`、`warmup.js`、`quota-watch.js`）。
 * 不打網路、不跑真 CLI：usage／spawn 都注入。
 */

'use strict'

const path = require('path')
const { EventEmitter } = require('events')
const { tempDir, removeTree } = require('./lib/test-temp')
const ROOT = path.join(__dirname, '..')
const { dueReminders } = require(path.join(ROOT, 'src/main/usage/quota-alerts.js'))
const warmup = require(path.join(ROOT, 'src/main/usage/warmup.js'))
const { createQuotaWatch } = require(path.join(ROOT, 'src/main/usage/quota-watch.js'))

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`) } else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

const H = 3600_000
const now = new Date(2026, 9, 17, 9, 0).getTime()
const iso = (ms) => new Date(ms).toISOString()
const win = (id, kind, used, resetMs) => ({ id, label: '', kind, used, limit: 100, resetAt: resetMs ? iso(resetMs) : '' })

console.log('\n[A] 提醒')
{
  const accounts = [
    { provider: 'claude-code', windows: [win('claude-weekly', 'weekly', 40, now + 3 * H), win('claude-5h', 'rolling-5h', 10, now + H)] },
    { provider: 'codex', windows: [win('codex-weekly', 'weekly', 90, now + 2 * H)],
      resetCredits: { available: 2, credits: [{ id: 'a', expiresAt: iso(now + 5 * H) }, { id: 'b', expiresAt: iso(now + 30 * H) }] } }
  ]
  const first = dueReminders(accounts, {}, now)
  ok('週額度快重置還剩 60% → 提醒；5 小時窗口不提醒；用了 90% 不提醒', first.alerts.filter((a) => /額度快重置/.test(a.title)).length === 1 && /還剩 60%/.test(first.alerts[0].body))
  ok('Codex 重置次數 6 小時內過期 → 提醒（只算到期在範圍內的）', first.alerts.some((a) => /重置次數快過期/.test(a.title) && /^1 次/.test(a.body)))
  const again = dueReminders(accounts, first.marks, now + 20 * 60_000)
  ok('同一輪窗口不重講', again.alerts.length === 0)
  const drift = accounts.map((a) => a.provider === 'claude-code' ? { ...a, windows: [win('claude-weekly', 'weekly', 40, now + 3 * H + 5 * 60_000)] } : a)
  ok('重置時間飄 5 分鐘仍算同一輪', dueReminders(drift, first.marks, now + 30 * 60_000).alerts.length === 0)
  const nextWeek = [{ provider: 'claude-code', windows: [win('claude-weekly', 'weekly', 10, now + 7 * 24 * H + 2 * H)] }]
  ok('下一輪（隔一週）會再講', dueReminders(nextWeek, first.marks, now + 7 * 24 * H).alerts.length === 1)
  const multi = [{ provider: 'claude-code', windows: [], profiles: [
    { id: 'p1', email: 'a@x', windows: [win('claude-weekly', 'weekly', 20, now + H)] },
    { id: 'p2', email: 'b@x', windows: [win('claude-weekly', 'weekly', 20, now + H)] }] }]
  ok('Claude 多帳號各講各的', dueReminders(multi, {}, now).alerts.length === 2)
}

console.log('\n[B] 預熱時間與窗口判斷')
{
  ok('時間清單去重排序、擋壞格式', JSON.stringify(warmup.sanitizeTimes(['11:00', '06:00', '06:00', '25:00', 'x', 3])) === '["06:00","11:00"]')
  const at6 = new Date(2026, 9, 17, 6, 0).getTime()
  ok('06:00 設定、現在 06:20 → 到了', warmup.dueSlot(['06:00'], at6 + 20 * 60_000) === at6)
  ok('晚超過 1 小時就放掉', warmup.dueSlot(['06:00'], at6 + 2 * H) === null)
  ok('凌晨 00:10、昨天 23:30 那個點還在寬限內', warmup.dueSlot(['23:30'], new Date(2026, 9, 18, 0, 10).getTime()) === new Date(2026, 9, 17, 23, 30).getTime())
  ok('同一天同時刻記號相同', warmup.slotKey(at6) === '2026-10-17 06:00')
  const acct = (windows, status = 'available') => ({ status, windows })
  ok('讀不到官方額度 → 不知道', warmup.windowIdle(acct([], 'connected'), 'claude-5h', now) === null)
  ok('Claude 沒有 5 小時這格（從沒用過）→ 該送', warmup.windowIdle(acct([]), 'claude-5h', now) === true)
  ok('重置時間已過 → 該送', warmup.windowIdle(acct([win('claude-5h', 'rolling-5h', 30, now - 1000)]), 'claude-5h', now) === true)
  ok('窗口在跑 → 不送', warmup.windowIdle(acct([win('claude-5h', 'rolling-5h', 1, now + 2 * H)]), 'claude-5h', now) === false)
  ok('Codex 閒置（0%、重置在整整 5 小時後）→ 該送', warmup.windowIdle(acct([win('codex-5h', 'rolling-5h', 0, now + 5 * H)]), 'codex-5h', now) === true)
}

async function main() {
  console.log('\n[C] 排程：到時間、窗口閒置才送，一個時間點只送一次')
  const dir = tempDir('axondeck-quota-watch-')
  try {
    const at6 = new Date(2026, 9, 17, 6, 5).getTime()
    let clock = at6
    const state = {
      settings: { alerts: { resetReminder: true }, warmup: { claude: ['06:00'], codex: [] } },
      lastSyncedAt: at6,
      accounts: [{ provider: 'claude-code', status: 'available', windows: [] }, { provider: 'codex', status: 'available', windows: [] }]
    }
    let syncs = 0
    const spawned = []
    const spawnImpl = (command, args) => {
      spawned.push(args.join(' '))
      const child = new EventEmitter()
      child.stdin = { end() {} }
      child.kill = () => {}
      setImmediate(() => child.emit('exit', 0))
      return child
    }
    const watch = createQuotaWatch({
      usage: { load: async () => state, sync: async () => { syncs++; return state } },
      notify: () => {},
      file: path.join(dir, 'usage-watch.json'),
      warmDeps: { cwd: path.join(dir, 'warm'), launch: async (spec) => ({ command: spec.command, args: spec.args, options: {} }), withPath: (env) => env, spawnImpl },
      now: () => clock
    })
    await watch.runTick()
    ok('到 06:00 → 先同步再送 Claude 預熱（Codex 沒設不送）', syncs === 1 && spawned.length === 1 && /--model haiku/.test(spawned[0]), `${syncs} ${spawned}`)
    clock += 5 * 60_000
    await watch.runTick()
    ok('同一個時間點不再送、也不再為預熱同步', spawned.length === 1 && syncs === 1, `${syncs} ${spawned.length}`)
    clock = at6 + 24 * H
    state.lastSyncedAt = clock
    state.accounts[0].windows = [win('claude-5h', 'rolling-5h', 20, clock + 3 * H)]
    await watch.runTick()
    ok('隔天窗口已經在跑 → 記上但不送', spawned.length === 1)
  } finally {
    removeTree(dir)
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main()
