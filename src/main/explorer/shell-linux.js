'use strict'

/**
 * Linux 最小殼層右鍵（xdg-open／gio／FileManager1）。
 * 標籤刻意避開 App 已有的「開啟／複製…」，以免 filterShellItems 整組丟掉。
 */

const { spawn } = require('child_process')
const path = require('path')
const fsp = require('../raw-fs').promises
const paths = require('./paths')

const CMD_OPEN_DEFAULT = 1
const CMD_REVEAL = 2

/** @type {Map<number, { paths: string[] }>} */
const sessions = new Map()
let nextToken = 1

function runDetached(file, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', shell: false })
      child.once('error', () => resolve(false))
      child.once('spawn', () => {
        child.unref()
        resolve(true)
      })
    } catch {
      resolve(false)
    }
  })
}

async function openPath(target) {
  if (await runDetached('xdg-open', [target])) return true
  if (await runDetached('gio', ['open', target])) return true
  return false
}

async function revealPath(target) {
  let st
  try {
    st = await fsp.stat(target)
  } catch {
    return openPath(path.dirname(target))
  }
  if (st.isDirectory()) return openPath(target)
  const uri = `file://${encodeURI(target)}`
  if (await runDetached('dbus-send', [
    '--session',
    '--dest=org.freedesktop.FileManager1',
    '--type=method_call',
    '/org/freedesktop/FileManager1',
    'org.freedesktop.FileManager1.ShowItems',
    `array:string:${uri}`,
    'string:'
  ])) return true
  return openPath(path.dirname(target))
}

/**
 * @param {{ paths?: unknown, dir?: unknown }} spec
 * @returns {Promise<{ token: number, items: object[] }>}
 */
async function menu(spec) {
  const input = spec && typeof spec === 'object' ? spec : {}
  const list = []
  for (const item of Array.isArray(input.paths) ? input.paths.slice(0, 64) : []) {
    try {
      list.push(paths.resolveExisting(item))
    } catch {
      // 剛刪掉的略過
    }
  }
  let dir = ''
  if (!list.length && input.dir) {
    try {
      dir = paths.resolveExisting(input.dir)
    } catch {
      return { token: 0, items: [] }
    }
  }
  if (!list.length && !dir) return { token: 0, items: [] }

  const token = nextToken++
  const targets = list.length ? list : [dir]
  sessions.set(token, { paths: targets })

  const multi = targets.length > 1
  return {
    token,
    items: [
      {
        cmd: CMD_OPEN_DEFAULT,
        label: multi ? '用預設程式開啟選取項目' : '用預設程式開啟',
        verb: 'defaultapp',
        disabled: false
      },
      { sep: true },
      {
        cmd: CMD_REVEAL,
        label: '在檔案管理員中顯示',
        verb: 'reveal',
        disabled: false
      }
    ]
  }
}

/**
 * @param {unknown} token
 * @param {unknown} cmd
 */
async function invoke(token, cmd) {
  const id = Number(token)
  const command = Number(cmd)
  const session = sessions.get(id)
  if (!session || !Number.isInteger(command)) return { invoked: false }
  const targets = session.paths
  if (command === CMD_OPEN_DEFAULT) {
    let ok = false
    for (const target of targets.slice(0, 8)) {
      ok = (await openPath(target)) || ok
    }
    return { invoked: ok }
  }
  if (command === CMD_REVEAL) {
    const target = targets[0]
    return { invoked: target ? await revealPath(target) : false }
  }
  return { invoked: false }
}

/** @param {unknown} token */
async function release(token) {
  sessions.delete(Number(token))
  return { released: true }
}

function shutdown() {
  sessions.clear()
}

module.exports = {
  CMD_OPEN_DEFAULT,
  CMD_REVEAL,
  menu,
  invoke,
  release,
  shutdown,
  openPath,
  revealPath
}
