'use strict'

/**
 * mpv 後端：開一個 mpv 程序，透過 JSON IPC（--input-ipc-server，Unix socket）控制。
 *
 * - socket 放在自己建的 0700 暫存資料夾，別的使用者連不進來；結束時 unlink＋rmdir（不遞迴刪）
 * - 只送這裡組好的指令；renderer 傳進來的只有「動作名稱＋數字」，見 controller.js 的 mpvAction
 * - mpv 視窗自己有畫面與快捷鍵（空白鍵、方向鍵…），AxonDeck 的播放頁同步顯示進度並能遙控
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const { EventEmitter } = require('events')
const { spawn } = require('child_process')

const OBSERVE = ['time-pos', 'duration', 'pause', 'volume', 'mute', 'speed', 'idle-active', 'sub-delay', 'sub-visibility', 'track-list', 'media-title']

/**
 * @param {{
 *   mpvPath: string,
 *   title?: string,
 *   extraArgs?: string[],
 *   spawnFn?: typeof spawn,
 *   tmpRoot?: string,
 *   connectTimeoutMs?: number
 * }} opts
 */
function createMpvSession(opts) {
  const emitter = new EventEmitter()
  const spawnFn = opts.spawnFn || spawn
  let child = null
  let socket = null
  let dir = ''
  let sock = ''
  let nextId = 1
  let closed = false
  let buffer = ''
  const pending = new Map()
  const props = {}

  function cleanup() {
    if (sock) { try { fs.unlinkSync(sock) } catch { /* 已不在 */ } }
    if (dir) { try { fs.rmdirSync(dir) } catch { /* 不是空的就留著 */ } }
    sock = ''
    dir = ''
  }

  function failAll(err) {
    for (const { reject } of pending.values()) reject(err)
    pending.clear()
  }

  function onLine(line) {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.request_id && pending.has(msg.request_id)) {
      const { resolve, reject } = pending.get(msg.request_id)
      pending.delete(msg.request_id)
      if (msg.error && msg.error !== 'success') reject(Object.assign(new Error(`mpv: ${msg.error}`), { code: 'MPV_COMMAND' }))
      else resolve(msg.data)
      return
    }
    if (msg.event === 'property-change') {
      props[msg.name] = msg.data
      emitter.emit('property', msg.name, msg.data)
      return
    }
    if (msg.event) emitter.emit('event', msg)
  }

  async function connect(deadline) {
    while (Date.now() < deadline) {
      if (closed) throw Object.assign(new Error('mpv 已結束'), { code: 'MPV_EXITED' })
      try {
        return await new Promise((resolve, reject) => {
          const s = net.createConnection(sock)
          s.once('connect', () => { s.removeAllListeners('error'); resolve(s) })
          s.once('error', reject)
        })
      } catch { await new Promise((r) => setTimeout(r, 50)) }
    }
    throw Object.assign(new Error('連不上 mpv'), { code: 'MPV_CONNECT' })
  }

  async function start() {
    dir = fs.mkdtempSync(path.join(opts.tmpRoot || os.tmpdir(), 'axondeck-mpv-'))
    fs.chmodSync(dir, 0o700)
    sock = path.join(dir, 'ipc.sock')
    const args = [
      `--input-ipc-server=${sock}`,
      '--idle=yes',
      '--force-window=yes',
      '--keep-open=no',
      '--no-terminal',
      '--input-terminal=no',
      `--title=${opts.title || 'AxonDeck 播放器（mpv）'}`,
      ...(opts.extraArgs || [])
    ]
    child = spawnFn(opts.mpvPath, args, { stdio: 'ignore', shell: false, detached: false })
    child.once('error', () => { closed = true; emitter.emit('exit', -1); failAll(Object.assign(new Error('mpv 無法啟動'), { code: 'MPV_SPAWN' })) })
    child.once('exit', (code) => {
      closed = true
      failAll(Object.assign(new Error('mpv 已結束'), { code: 'MPV_EXITED' }))
      cleanup()
      emitter.emit('exit', code)
    })
    socket = await connect(Date.now() + (opts.connectTimeoutMs || 8000))
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffer += chunk
      if (buffer.length > 4 * 1024 * 1024) buffer = ''
      let i
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 1)
        if (line.trim()) onLine(line)
      }
    })
    socket.on('error', () => {})
    OBSERVE.forEach((name, idx) => { void command(['observe_property', idx + 1, name]).catch(() => {}) })
  }

  /** @param {Array<string | number | boolean>} cmd */
  function command(cmd) {
    if (!socket || closed) return Promise.reject(Object.assign(new Error('mpv 沒在跑'), { code: 'MPV_EXITED' }))
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      socket.write(`${JSON.stringify({ command: cmd, request_id: id })}\n`)
    })
  }

  function quit() {
    if (!child || closed) { cleanup(); return }
    void command(['quit']).catch(() => {})
    const c = child
    setTimeout(() => { if (!closed) { try { c.kill('SIGTERM') } catch { /* 已結束 */ } } }, 1500).unref?.()
  }

  /** App 結束時同步收掉，不留孤兒 */
  function killNow() {
    if (child && !closed) { try { child.kill('SIGTERM') } catch { /* 已結束 */ } }
    cleanup()
  }

  return {
    start,
    command,
    quit,
    killNow,
    on: (...a) => emitter.on(...a),
    get alive() { return Boolean(child) && !closed },
    get pid() { return child?.pid || 0 },
    get socketPath() { return sock },
    props
  }
}

module.exports = { createMpvSession, OBSERVE }
