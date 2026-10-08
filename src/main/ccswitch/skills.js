'use strict'

/**
 * 各家 AI 的 skills 與全域記憶檔（Main Process）。
 *
 * Skills 就是 `<home>/skills/<name>/SKILL.md`（名字與描述讀 frontmatter）。
 * `~/.claude/skills` 通常是指到 `~/.agents/skills` 的連結，兩邊看到同一份——
 * 讀的時候解開連結，UI 標「共用」才不會以為有兩份。
 *
 * 停用＝把目錄搬進 `skills/.disabled/<name>`（各家 CLI 認不到就等於關掉，
 * 要用再搬回來；直接刪掉的話設定就找不回來了）。搬移只允許在解開後的
 * skills 目錄裡發生，名字卡死字元集，跨出目錄一律拒絕。
 *
 * 記憶檔（讀＋改）：
 * | 家 | 檔案 |
 * |---|---|
 * | claude | `CLAUDE.md` |
 * | codex | `AGENTS.md`、`CLAUDE.md`（兩個都認得，有才列） |
 * | grok | `MEMORY.md` |
 * | opencode | `AGENTS.md` |
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const claudeSettings = require('./claude-settings')

/** SKILL.md 只讀開頭這麼多（frontmatter 一定在最前面） */
const SKILL_HEAD_BYTES = 64 * 1024
/** 掃幾個 skill 就停（plugin 農場動輒上百個） */
const MAX_SKILLS = 200
/** 記憶檔上限 */
const MAX_MEMORY_BYTES = 256 * 1024
const MAX_BACKUPS = 20
/** skill 目錄名／記憶檔名允許的字元 */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/

/** @type {string} */
let homeOverride = ''

function configure(options = {}) {
  if (options && typeof options.homeDir === 'string') homeOverride = options.homeDir
}

/** @returns {string} */
function baseHome() {
  return homeOverride || os.homedir()
}

/**
 * @param {string | undefined} value
 * @param {string} fallback
 * @returns {string}
 */
function envHome(value, fallback) {
  const dir = typeof value === 'string' ? value.trim() : ''
  return dir || path.join(baseHome(), fallback)
}

/**
 * @returns {Array<{ id: string, label: string, dir: string, memory: string[] }>}
 */
function homes() {
  const claude = envHome(process.env.CLAUDE_CONFIG_DIR ? String(process.env.CLAUDE_CONFIG_DIR).split(',')[0] : '', '.claude')
  return [
    { id: 'claude', label: 'Claude Code', dir: path.join(claude, 'skills'), memory: ['CLAUDE.md'] },
    { id: 'codex', label: 'Codex', dir: path.join(envHome(process.env.CODEX_HOME, '.codex'), 'skills'), memory: ['AGENTS.md', 'CLAUDE.md'] },
    { id: 'grok', label: 'Grok', dir: path.join(envHome(process.env.GROK_HOME, '.grok'), 'skills'), memory: ['MEMORY.md'] },
    { id: 'opencode', label: 'OpenCode', dir: path.join(baseHome(), '.config', 'opencode', 'skills'), memory: ['AGENTS.md'] },
    { id: 'agents', label: '.agents（共用）', dir: path.join(baseHome(), '.agents', 'skills'), memory: [] }
  ]
}

/**
 * @param {unknown} id
 * @returns {{ id: string, label: string, dir: string, memory: string[] }}
 */
function assertHome(id) {
  const home = homes().find((row) => row.id === id)
  if (!home) {
    const error = new Error('SKILL_HOME_UNKNOWN')
    error.code = 'SKILL_HOME_UNKNOWN'
    error.userMessage = '不支援這個 AI 家目錄'
    throw error
  }
  return home
}

/**
 * @param {string} code
 * @param {string} userMessage
 * @returns {Error}
 */
function fail(code, userMessage) {
  const error = new Error(code)
  error.code = code
  error.userMessage = userMessage
  return error
}

/**
 * 記憶檔的家目錄（跟 skills 目錄不一定同一層：opencode 的記憶在 config 根目錄）。
 * @param {{ id: string, dir: string }} home
 * @returns {string}
 */
function memoryDir(home) {
  if (home.id === 'opencode') return path.dirname(home.dir)
  if (home.id === 'agents') return home.dir
  return path.dirname(home.dir)
}

/**
 * @param {string} dir
 * @returns {string | null} 解開連結後的真實目錄；不存在回 null
 */
function realDir(dir) {
  try {
    const stat = fs.statSync(dir)
    if (!stat.isDirectory()) return null
    return fs.realpathSync.native(dir)
  } catch {
    return null
  }
}

/**
 * 最小 frontmatter 解析：只要開頭 `---` 區塊裡的 `name:`／`description:`。
 * @param {string} text
 * @returns {{ name: string, description: string }}
 */
function parseFrontmatter(text) {
  const out = { name: '', description: '' }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  if (!text.startsWith('---')) return out
  const end = text.indexOf('\n---', 3)
  if (end < 0) return out
  for (const line of text.slice(3, end).split('\n')) {
    const match = line.match(/^\s*(name|description)\s*:\s*(.*)\s*$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[match[1]] = value.slice(0, 200)
  }
  return out
}

/**
 * @param {string} dir skills 目錄（已解開）
 * @param {string} name
 * @param {boolean} enabled
 * @returns {{ name: string, description: string, enabled: boolean } | null}
 */
function readSkill(dir, name, enabled) {
  if (!SKILL_NAME_RE.test(name)) return null
  const file = path.join(dir, enabled ? name : '.disabled', enabled ? '' : name, 'SKILL.md')
  let head = ''
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(Math.min(SKILL_HEAD_BYTES, fs.fstatSync(fd).size))
      fs.readSync(fd, buf, 0, buf.length, 0)
      head = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return { name, description: '', enabled }
  }
  const meta = parseFrontmatter(head)
  return { name: meta.name || name, description: meta.description || '', enabled }
}

/**
 * @param {string} rawHome
 * @returns {{ dir: string, sharedWith: string[], skills: Array<{ name: string, description: string, enabled: boolean }> }}
 */
function list(rawHome) {
  const home = assertHome(rawHome)
  const dir = realDir(home.dir)
  const sharedWith = homes()
    .filter((row) => row.id !== home.id && realDir(row.dir) && realDir(row.dir) === dir)
    .map((row) => row.label)
  if (!dir) return { dir: home.dir, sharedWith, skills: [] }
  /** @type {Array<{ name: string, description: string, enabled: boolean }>} */
  const skills = []
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { dir, sharedWith, skills }
  }
  for (const name of names) {
    if (skills.length >= MAX_SKILLS) break
    if (name.startsWith('.')) continue
    const row = readSkill(dir, name, true)
    if (row) skills.push(row)
  }
  const disabledDir = path.join(dir, '.disabled')
  if (realDir(disabledDir)) {
    let disabled = []
    try {
      disabled = fs.readdirSync(disabledDir)
    } catch {
      disabled = []
    }
    for (const name of disabled) {
      if (skills.length >= MAX_SKILLS) break
      if (name.startsWith('.')) continue
      const row = readSkill(dir, name, false)
      if (row) skills.push(row)
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return { dir, sharedWith, skills }
}

/**
 * 停用／啟用＝目錄在 `skills/<name>` 與 `skills/.disabled/<name>` 之間搬移。
 * @param {string} rawHome
 * @param {string} rawName
 * @param {boolean} enabled
 * @returns {{ name: string, enabled: boolean }}
 */
function setEnabled(rawHome, rawName, enabled) {
  const home = assertHome(rawHome)
  const name = typeof rawName === 'string' ? rawName.trim() : ''
  if (!SKILL_NAME_RE.test(name)) throw fail('SKILL_BAD_NAME', '這個 skill 名稱不能用')
  const dir = realDir(home.dir)
  if (!dir) throw fail('SKILL_HOME_MISSING', '找不到這個 skills 資料夾')
  const live = path.join(dir, name)
  const parked = path.join(dir, '.disabled', name)
  const from = enabled ? parked : live
  const to = enabled ? live : parked
  let stat = null
  try {
    stat = fs.statSync(from)
  } catch {
    stat = null
  }
  if (!stat || !stat.isDirectory()) throw fail('SKILL_NOT_FOUND', '找不到這個 skill')
  if (fs.existsSync(to)) throw fail('SKILL_CONFLICT', '目標位置已經有同名 skill')
  if (!enabled) fs.mkdirSync(path.join(dir, '.disabled'), { recursive: true })
  fs.renameSync(from, to)
  return { name, enabled }
}

/**
 * @param {string} rawHome
 * @returns {Array<{ file: string, path: string, exists: boolean }>}
 */
function memoryFiles(rawHome) {
  const home = assertHome(rawHome)
  const dir = memoryDir(home)
  return home.memory.map((file) => {
    const full = path.join(dir, file)
    let exists = false
    try {
      exists = fs.statSync(full).isFile()
    } catch {
      exists = false
    }
    return { file, path: full, exists }
  })
}

/**
 * @param {string} rawHome
 * @param {string} rawFile
 * @returns {{ path: string, exists: boolean, content: string }}
 */
function readMemory(rawHome, rawFile) {
  const home = assertHome(rawHome)
  if (!home.memory.includes(rawFile)) throw fail('MEMORY_FILE_UNKNOWN', '這個記憶檔不在管理清單裡')
  const full = path.join(memoryDir(home), rawFile)
  let stat = null
  try {
    stat = fs.statSync(full)
  } catch (error) {
    if (error && error.code === 'ENOENT') return { path: full, exists: false, content: '' }
    throw fail('MEMORY_READ_FAILED', `讀取 ${rawFile} 失敗`)
  }
  if (!stat.isFile()) throw fail('MEMORY_READ_FAILED', `讀取 ${rawFile} 失敗`)
  if (stat.size > MAX_MEMORY_BYTES) throw fail('MEMORY_TOO_LARGE', `${rawFile} 太大，請用編輯器開`)
  try {
    return { path: full, exists: true, content: fs.readFileSync(full, 'utf8') }
  } catch {
    throw fail('MEMORY_READ_FAILED', `讀取 ${rawFile} 失敗`)
  }
}

/**
 * @param {string} rawHome
 * @param {string} rawFile
 * @param {unknown} rawContent
 * @returns {{ path: string }}
 */
function writeMemory(rawHome, rawFile, rawContent) {
  const home = assertHome(rawHome)
  if (!home.memory.includes(rawFile)) throw fail('MEMORY_FILE_UNKNOWN', '這個記憶檔不在管理清單裡')
  if (typeof rawContent !== 'string') throw fail('MEMORY_BAD_CONTENT', '記憶檔內容必須是文字')
  if (Buffer.byteLength(rawContent, 'utf8') > MAX_MEMORY_BYTES) {
    throw fail('MEMORY_TOO_LARGE', `${rawFile} 太大，請用編輯器存`)
  }
  const dir = memoryDir(home)
  const full = path.join(dir, rawFile)
  if (fs.existsSync(full)) {
    const backupRoot = claudeSettings.backupDir()
    fs.mkdirSync(backupRoot, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    fs.copyFileSync(full, path.join(backupRoot, `memory-${home.id}-${rawFile}-${stamp}.md`))
    try {
      const names = fs.readdirSync(backupRoot)
        .filter((name) => name.startsWith(`memory-${home.id}-${rawFile}-`) && name.endsWith('.md')).sort()
      for (const name of names.slice(0, Math.max(0, names.length - MAX_BACKUPS))) {
        try {
          fs.unlinkSync(path.join(backupRoot, name))
        } catch {
          // 刪不掉就算了
        }
      }
    } catch {
      // 備份目錄讀不到不擋寫入
    }
  }
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${full}.axondeck-tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, rawContent, 'utf8')
  try {
    fs.renameSync(tmp, full)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // 暫存檔清不掉不影響結果
    }
    throw error
  }
  return { path: full }
}

module.exports = {
  configure,
  homes,
  list,
  setEnabled,
  memoryFiles,
  readMemory,
  writeMemory
}
