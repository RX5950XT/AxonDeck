'use strict'

/**
 * 列出本機 distrobox／toolbox 容器，給終端機「＋」選單當 WSL 的 Linux 對應。
 * 解析指令輸出、不執行 enter；真正開 shell 由 pty.js 依 key 組參數。
 */

const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/
const KINDS = {
  distrobox: {
    bin: 'distrobox',
    args: ['list', '--no-color'],
    enter: (name) => ['enter', '--name', name]
  },
  toolbox: {
    bin: 'toolbox',
    args: ['list', '--containers'],
    enter: (name) => ['enter', name]
  }
}

function hasCommand(name, env = process.env) {
  return String(env.PATH || '').split(path.delimiter).filter(Boolean).some((dir) => {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

/** 從表格或空白分隔的清單抓名稱（略過標題列與空行）。 */
function parseNames(text) {
  const names = []
  const seen = new Set()
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim()
    if (!line || /^id\b|^container\s+id\b|^name\b/i.test(line) || /^[-+|]+$/.test(line)) continue
    const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean)
    const token = cells.length >= 2 ? cells[1] : line.split(/\s+/).find((part, i, all) => {
      if (NAME_RE.test(part) && !/^[0-9a-f]{8,}$/i.test(part)) return true
      // toolbox：第二欄常是名稱，第一欄是短 hash
      return i === 1 && NAME_RE.test(part)
    })
    const name = token && NAME_RE.test(token) ? token : ''
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

function run(cmd, args, execFileFn = execFile) {
  return new Promise((resolve) => {
    try {
      execFileFn(cmd, args, { timeout: 8000, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true },
        (error, stdout) => resolve(error ? '' : String(stdout || '')))
    } catch {
      resolve('')
    }
  })
}

/**
 * @param {string} key
 * @returns {{ kind: 'distrobox'|'toolbox', name: string } | null}
 */
function parseKey(key) {
  if (typeof key !== 'string') return null
  const match = /^(distrobox|toolbox):([A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/.exec(key)
  return match ? { kind: /** @type {'distrobox'|'toolbox'} */ (match[1]), name: match[2] } : null
}

function labelOf(kind, name) {
  return kind === 'toolbox' ? `Toolbox：${name}` : `Distrobox：${name}`
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, execFileFn?: typeof execFile, hasCommand?: (name: string) => boolean }} [opts]
 * @returns {Promise<Array<{ key: string, label: string, exe: string, args: string[], kind: string, name: string }>>}
 */
async function listContainers(opts = {}) {
  const env = opts.env || process.env
  const has = opts.hasCommand || ((name) => hasCommand(name, env))
  const execFileFn = opts.execFileFn || execFile
  const out = []
  for (const kind of /** @type {const} */ (['distrobox', 'toolbox'])) {
    const def = KINDS[kind]
    if (!has(def.bin)) continue
    const text = await run(def.bin, def.args, execFileFn)
    for (const name of parseNames(text)) {
      out.push({
        key: `${kind}:${name}`,
        label: labelOf(kind, name),
        exe: def.bin,
        args: def.enter(name),
        kind,
        name
      })
    }
  }
  return out
}

/**
 * 同步解析（給 spawn：清單已寫入快取，或參數本身可信任）。
 * @param {string} key
 * @returns {{ exe: string, args: string[], label: string } | null}
 */
function commandFor(key) {
  const parsed = parseKey(key)
  if (!parsed) return null
  const def = KINDS[parsed.kind]
  return { exe: def.bin, args: def.enter(parsed.name), label: labelOf(parsed.kind, parsed.name) }
}

function runSync(cmd, args, spawnSyncFn) {
  try {
    const result = spawnSyncFn(cmd, args, { timeout: 5000, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 })
    return result && result.status === 0 ? String(result.stdout || '') : ''
  } catch {
    return ''
  }
}

/**
 * 給終端機 catalog 用的同步清單（開啟「＋」選單時呼叫，通常幾百毫秒內結束）。
 * @param {{ env?: NodeJS.ProcessEnv, spawnSyncFn?: typeof import('child_process').spawnSync, hasCommand?: (name: string) => boolean }} [opts]
 */
function listContainersSync(opts = {}) {
  const { spawnSync } = require('child_process')
  const env = opts.env || process.env
  const has = opts.hasCommand || ((name) => hasCommand(name, env))
  const spawnSyncFn = opts.spawnSyncFn || spawnSync
  const out = []
  for (const kind of /** @type {const} */ (['distrobox', 'toolbox'])) {
    const def = KINDS[kind]
    if (!has(def.bin)) continue
    const text = runSync(def.bin, def.args, spawnSyncFn)
    for (const name of parseNames(text)) {
      out.push({
        key: `${kind}:${name}`,
        label: labelOf(kind, name),
        exe: def.bin,
        args: def.enter(name),
        kind,
        name
      })
    }
  }
  return out
}

module.exports = { parseNames, parseKey, commandFor, listContainers, listContainersSync, hasCommand, NAME_RE, KINDS }
