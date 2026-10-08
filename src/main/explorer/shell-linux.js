'use strict'

/**
 * Linux 的殼層右鍵（取代 Windows 的 IContextMenu）：
 * 用預設程式開啟、開啟方式…、壓縮／解壓縮（archive-linux.js）、在檔案管理員中顯示、
 * 在這裡開啟終端機，以及隱藏的 `properties` 動詞（renderer 的「內容」改開 App 內的 Linux 內容視窗）。
 * 標籤刻意避開 App 已有的「開啟／複製…」，以免 filterShellItems 整組丟掉。
 *
 * invoke 回傳：`{ invoked, operation? , confirm?, error?, toast?, linuxProperties? }`
 * - `operation`：壓縮／解壓縮已交給 operations.js 跑（進度、取消都在檔案操作面板）
 * - `confirm`：「解壓縮到這裡」遇到同名項目，renderer 問過使用者再呼叫 `confirm(id, true)`
 */

const { spawn } = require('child_process')
const path = require('path')
const fsp = require('../raw-fs').promises
const paths = require('./paths')

const archive = require('./archive-linux')
const openWith = require('./open-with-linux')

const CMD_OPEN_DEFAULT = 1
const CMD_REVEAL = 2
const CMD_TERMINAL = 3
const CMD_PROPERTIES = 4
const CMD_HINT = 5
const CMD_EXTRACT_HERE = 20
const CMD_EXTRACT_FOLDER = 21
/** 壓縮：10 + FORMATS 的索引（zip、7z、tar.gz） */
const CMD_COMPRESS_BASE = 10
/** 開啟方式：100 + 應用程式清單的索引 */
const CMD_OPEN_WITH_BASE = 100
const CONFIRM_TTL_MS = 10 * 60 * 1000
const FORMAT_LABEL = { zip: 'ZIP', '7z': '7z', 'tar.gz': 'tar.gz' }

/** 「解壓縮到這裡」等使用者確認的計畫：id → { archives, replace, at } */
const pendingConfirm = new Map()
let nextConfirm = 1

/** @type {Map<number, { paths: string[], dir: string, apps: object[], folder: string }>} */
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
  const built = await buildItems(targets, Boolean(list.length))
  sessions.set(token, { paths: targets, apps: built.apps, folder: built.folder })
  return { token, items: built.items }
}

async function statOf(full) {
  try { return await fsp.stat(full) } catch { return null }
}

/** 開啟方式：用第一個項目的 MIME（資料夾＝inode/directory） */
async function openWithItems(targets) {
  let apps = []
  try {
    const st = await statOf(targets[0])
    const mime = st && st.isDirectory() ? 'inode/directory' : (await require('./properties-linux').mimeOf(targets[0], st || { isDirectory: () => false })).mime
    apps = await openWith.appsFor(mime)
  } catch { apps = [] }
  const children = apps.map((app, index) => ({
    cmd: CMD_OPEN_WITH_BASE + index,
    label: app.isDefault ? `${app.name}（預設）` : app.name,
    verb: 'openwith-app',
    disabled: false
  }))
  return { apps, item: children.length ? { label: '開啟方式', verb: 'openwith', disabled: false, children } : null }
}

/** 壓縮／解壓縮：只列有工具能做的；全都做不了時列一行灰色提示 */
function archiveItems(targets, folder) {
  const tools = archive.detectTools()
  const items = []
  const sameDir = targets.every((t) => path.dirname(t) === folder)
  const formats = archive.FORMATS.filter((format) => archive.compressTool(format, tools))
  if (sameDir && formats.length) {
    items.push({
      label: '壓縮',
      verb: 'compress',
      disabled: false,
      children: formats.map((format) => ({
        cmd: CMD_COMPRESS_BASE + archive.FORMATS.indexOf(format),
        label: `壓縮成 ${FORMAT_LABEL[format]}`,
        verb: `compress-${format}`,
        disabled: false
      }))
    })
  }
  const kinds = targets.map((t) => archive.archiveKind(t))
  if (kinds.every(Boolean)) {
    if (kinds.every((kind) => archive.extractTool(kind, tools))) {
      const stem = targets.length === 1 ? archive.stripArchiveExt(path.basename(targets[0])) : ''
      items.push({ cmd: CMD_EXTRACT_HERE, label: '解壓縮到這裡', verb: 'extract-here', disabled: false })
      items.push({ cmd: CMD_EXTRACT_FOLDER, label: stem ? `解壓縮到「${stem}/」` : '各自解壓縮到資料夾', verb: 'extract-folder', disabled: false })
    } else {
      items.push({ cmd: CMD_HINT, label: '解壓縮（需要 7-Zip 或 libarchive-tools）', verb: 'archive-hint', disabled: true })
    }
  }
  const hint = archive.missingHint(tools)
  if (hint && sameDir) items.push({ cmd: CMD_HINT, label: `缺少壓縮工具：${hint}`, verb: 'archive-hint', disabled: true })
  return items
}

/**
 * @param {string[]} targets 已驗證的絕對路徑
 * @param {boolean} selection 有選東西（false＝在資料夾空白處按右鍵）
 */
async function buildItems(targets, selection) {
  const multi = targets.length > 1
  const folder = selection ? path.dirname(targets[0]) : targets[0]
  const items = [{ cmd: CMD_OPEN_DEFAULT, label: multi ? '用預設程式開啟選取項目' : '用預設程式開啟', verb: 'defaultapp', disabled: false }]
  let apps = []
  if (selection) {
    const openWithMenu = await openWithItems(targets)
    apps = openWithMenu.apps
    if (openWithMenu.item) items.push(openWithMenu.item)
    const archived = archiveItems(targets, folder)
    if (archived.length) items.push({ sep: true }, ...archived)
  }
  items.push({ sep: true })
  items.push({ cmd: CMD_REVEAL, label: '在檔案管理員中顯示', verb: 'reveal', disabled: false })
  items.push({ cmd: CMD_TERMINAL, label: '在這裡開啟終端機', verb: 'terminal', disabled: false })
  // renderer 的 filterShellItems 會藏掉 properties，只給「內容（Alt+Enter）」用
  items.push({ cmd: CMD_PROPERTIES, label: '內容', verb: 'properties', disabled: false })
  return { items, apps, folder }
}

/** 交給檔案操作面板跑（有進度、可取消）；回傳操作編號 */
function startOperation(mode, items, runner) {
  const operations = require('./operations')
  let id = ''
  const done = operations.run({
    mode,
    items,
    runner,
    type: 'file-operation',
    onEvent: (event) => { if (!id && event && event.id) id = event.id }
  })
  done.catch(() => {})
  return { id, done }
}

function compressOperation(targets, format) {
  paths.assertCreatable(path.dirname(targets[0]))
  return startOperation('compress', [{ source: targets[0], destination: path.dirname(targets[0]) }], (item, opts) => (
    archive.compress({ sources: targets, format, signal: opts.signal, onTotal: opts.onTotal, onProgress: opts.onProgress })
  ))
}

function extractOperation(archives, mode, replace = {}) {
  for (const file of archives) paths.assertCreatable(path.dirname(file))
  return startOperation('extract', archives.map((a) => ({ source: a, destination: path.dirname(a) })), (item, opts) => (
    archive.extract({ archive: item.source, mode, replace: replace[item.source] || [], signal: opts.signal, onTotal: opts.onTotal, onProgress: opts.onProgress })
  ))
}

/** 「解壓縮到這裡」：先列出內容，跟目的地同名的要使用者確認 */
async function extractHere(archives) {
  const conflicts = {}
  let names = []
  for (const file of archives) {
    const plan = await archive.planExtract(file, path.dirname(file))
    if (plan.conflicts.length) {
      conflicts[file] = plan.conflicts
      names = names.concat(plan.conflicts)
    }
  }
  if (!names.length) return { invoked: true, operation: extractOperation(archives, 'here').id }
  const id = nextConfirm++
  pendingConfirm.set(id, { archives, replace: conflicts, at: Date.now() })
  const shown = names.slice(0, 8).join('\n')
  const more = names.length > 8 ? `\n…還有 ${names.length - 8} 個` : ''
  return {
    invoked: false,
    confirm: {
      id,
      title: `取代 ${names.length} 個同名項目？`,
      desc: `這些項目已經存在，取代時舊的會移到垃圾桶：\n${shown}${more}\n\n想保留兩份請改用「解壓縮到資料夾」。`,
      confirmText: '取代'
    }
  }
}

/**
 * renderer 問過使用者之後回來：`accept` 才真的開始（同名的舊項目丟回收筒）。
 * @param {unknown} rawId @param {unknown} accept
 */
async function confirm(rawId, accept) {
  const id = Number(rawId)
  const plan = pendingConfirm.get(id)
  pendingConfirm.delete(id)
  for (const [key, value] of pendingConfirm) if (Date.now() - value.at > CONFIRM_TTL_MS) pendingConfirm.delete(key)
  if (!plan || Date.now() - plan.at > CONFIRM_TTL_MS) return { invoked: false, error: '這個確認已經過期，請再操作一次' }
  if (accept !== true) return { invoked: false, cancelled: true }
  return { invoked: true, operation: extractOperation(plan.archives, 'here', plan.replace).id }
}

function failure(error) {
  return { invoked: false, error: error && error.userMessage ? error.userMessage : '操作失敗' }
}

async function terminalFor(session) {
  const first = session.paths[0]
  const st = first ? await statOf(first) : null
  const dir = st && st.isDirectory() && session.paths.length === 1 ? first : session.folder || path.dirname(first)
  const used = await openWith.openTerminal(dir)
  return used ? { invoked: true } : { invoked: false, error: '找不到終端機程式（可安裝 gnome-terminal、konsole 或 xterm）' }
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
  try {
    if (command === CMD_OPEN_DEFAULT) {
      let ok = false
      for (const target of targets.slice(0, 8)) ok = (await openPath(target)) || ok
      return { invoked: ok }
    }
    if (command === CMD_REVEAL) return { invoked: targets[0] ? await revealPath(targets[0]) : false }
    if (command === CMD_TERMINAL) return await terminalFor(session)
    if (command === CMD_PROPERTIES) return { invoked: true, linuxProperties: { paths: targets.slice() } }
    const format = archive.FORMATS[command - CMD_COMPRESS_BASE]
    if (format && command >= CMD_COMPRESS_BASE) return { invoked: true, operation: compressOperation(targets.slice(), format).id }
    if (command === CMD_EXTRACT_HERE) return await extractHere(targets.slice())
    if (command === CMD_EXTRACT_FOLDER) return { invoked: true, operation: extractOperation(targets.slice(), 'folder').id }
    const app = command >= CMD_OPEN_WITH_BASE ? session.apps[command - CMD_OPEN_WITH_BASE] : null
    if (app) return (await openWith.launch(app.id, targets.slice())) ? { invoked: true } : { invoked: false, error: `${app.name} 打不開` }
  } catch (error) {
    return failure(error)
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
  pendingConfirm.clear()
}

module.exports = {
  CMD_OPEN_DEFAULT,
  CMD_REVEAL,
  CMD_TERMINAL,
  CMD_PROPERTIES,
  CMD_EXTRACT_HERE,
  CMD_EXTRACT_FOLDER,
  CMD_COMPRESS_BASE,
  CMD_OPEN_WITH_BASE,
  menu,
  invoke,
  confirm,
  release,
  shutdown,
  openPath,
  revealPath
}
