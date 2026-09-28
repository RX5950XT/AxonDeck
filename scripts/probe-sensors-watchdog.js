'use strict'
/**
 * 真機驗感測器 sidecar 的看門狗（要先裝好「VoiceInk Sensors」排程工作；不會跳 UAC）。
 *
 * 模擬主程式：每秒送 P＋S（第一條可控通道、寫它目前的 PWM，轉速不變）。
 * 1. 開記憶體組那 6 秒多讀取執行緒卡在 Gate 上，以前會被當成主程式沒聲音 → 8 秒自殺。
 * 2. 中途停 10 秒：要交還 BIOS（o=false）但不能斷線；恢復後要接回（o=true）。
 *
 * 用法：node scripts/probe-sensors-watchdog.js
 */
const net = require('net')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const assert = require('assert')
const { execFileSync } = require('child_process')

const PIPE = `\\\\.\\pipe\\voiceink-sensors-${crypto.randomBytes(16).toString('hex')}`
const HANDOFF = path.join(process.env.APPDATA, 'voiceink', 'sensors-handoff.txt')
const SILENT_FROM = 14_000
const SILENT_TO = 24_000
const END = 34_000
const t0 = Date.now()
const now = () => Date.now() - t0
/** @type {{ at: number, o: boolean }[]} */
const frames = []
/** 兩條執行緒同時寫管道時會攪出壞行 */
let bad = 0
let gotReset = false

const server = net.createServer((conn) => {
  let buf = ''
  let ctl = null
  conn.setEncoding('utf8')
  conn.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let payload
      try { payload = JSON.parse(line) } catch { bad += 1; continue }
      if (payload.reset) gotReset = true
      if (!Array.isArray(payload.h)) continue
      const c = payload.c || []
      if (!ctl) {
        const first = c.find((x) => x.pwm != null)
        assert.ok(first, '沒有可控的風扇通道，驗不了看門狗')
        ctl = { id: first.id, pwm: Math.max(20, Math.round(first.pwm)) }
      }
      frames.push({ at: now(), o: (c.find((x) => x.id === ctl.id) || {}).o === true })
    }
  })
  const beat = setInterval(() => {
    if (now() > SILENT_FROM && now() < SILENT_TO) return
    conn.write('P\n')
    if (ctl) conn.write(`S ${ctl.id} ${ctl.pwm}\n`)
  }, 1000)
  setTimeout(() => { clearInterval(beat); conn.write('R\n') }, END)
  conn.on('close', () => {
    clearInterval(beat)
    const died = now() < END
    const during = frames.filter((f) => f.at > SILENT_FROM + 7_000 && f.at < SILENT_TO)
    const after = frames.filter((f) => f.at > SILENT_TO + 2_000)
    console.log(frames.map((f) => `${(f.at / 1000).toFixed(1)}${f.o ? '*' : ''}`).join(' '))
    assert.strictEqual(bad, 0, '管道上出現壞掉的 JSON 行（兩條執行緒同時寫）')
    assert.ok(gotReset, 'R 之後要回 {"reset":1}')
    assert.ok(!died,`sidecar 在 ${(now() / 1000).toFixed(1)} 秒自己斷線（看門狗誤判）`)
    assert.ok(frames.some((f) => f.o && f.at < SILENT_FROM), '心跳正常時要接管')
    assert.ok(during.length > 0 && during.every((f) => !f.o), '沉默超過 5 秒要交還 BIOS')
    assert.ok(after.length > 0 && after.every((f) => f.o), '恢復心跳後要接回')
    console.log('OK')
    process.exit(0)
  })
})

server.listen(PIPE, () => {
  fs.writeFileSync(HANDOFF, PIPE, 'utf8')
  execFileSync('schtasks.exe', ['/run', '/tn', 'VoiceInk Sensors'])
})
setTimeout(() => { console.error('逾時：sidecar 沒連上或沒結束'); process.exit(1) }, END + 30_000)
