'use strict'

/**
 * 偵測 apt／dnf／pacman／zypper 與 flatpak，組搜尋、清單、安裝指令。
 * 提權只用 pkexec（或 kdesudo／gksudo／beesu）或看得見密碼提示的終端機 sudo，絕不靜默 sudo。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile, spawn } = require('child_process')

const GRAPHICAL_SUDO = ['pkexec', 'kdesudo', 'gksudo', 'beesu']
const TERMINALS = [
  ['xdg-terminal-exec', []],
  ['x-terminal-emulator', ['-e']],
  ['gnome-terminal', ['--']],
  ['konsole', ['-e']],
  ['xfce4-terminal', ['-e']],
  ['kgx', ['-e']],
  ['alacritty', ['-e']],
  ['kitty', []],
  ['wezterm', ['start']]
]

function hasCommand(name, env = process.env) {
  return String(env.PATH || '').split(path.delimiter).filter(Boolean).some((dir) => {
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true } catch { return false }
  })
}

function detect(opts = {}) {
  const env = opts.env || process.env
  const has = opts.hasCommand || ((name) => hasCommand(name, env))
  let native = ''
  if (has('apt-get') || has('apt')) native = 'apt'
  else if (has('dnf')) native = 'dnf'
  else if (has('zypper')) native = 'zypper'
  else if (has('pacman')) native = 'pacman'
  const graphical = GRAPHICAL_SUDO.find((name) => has(name)) || ''
  const terminal = TERMINALS.find(([name]) => has(name))?.[0] || ''
  return { native, flatpak: has('flatpak'), graphical, terminal }
}

function nativeArgs(native, action, pkg) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(pkg)) throw Object.assign(new Error('INVALID'), { userMessage: '套件名稱無效。' })
  if (native === 'apt') {
    if (action === 'uninstall') return ['apt-get', ['remove', '-y', '--', pkg]]
    if (action === 'upgrade') return ['apt-get', ['install', '--only-upgrade', '-y', '--', pkg]]
    return ['apt-get', ['install', '-y', '--', pkg]]
  }
  if (native === 'dnf') {
    const verb = action === 'uninstall' ? 'remove' : action === 'upgrade' ? 'upgrade' : 'install'
    return ['dnf', [verb, '-y', '--', pkg]]
  }
  if (native === 'zypper') {
    const verb = action === 'uninstall' ? 'remove' : action === 'upgrade' ? 'update' : 'install'
    return ['zypper', ['--non-interactive', verb, '--', pkg]]
  }
  if (native === 'pacman') {
    if (action === 'uninstall') return ['pacman', ['-R', '--noconfirm', '--', pkg]]
    if (action === 'upgrade') return ['pacman', ['-Syu', '--noconfirm', '--', pkg]]
    return ['pacman', ['-S', '--noconfirm', '--', pkg]]
  }
  throw Object.assign(new Error('NO_BACKEND'), { userMessage: '這台沒有可用的套件管理員（apt、dnf、zypper 或 pacman）。' })
}

function flatpakArgs(action, pkg, user = true) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pkg)) throw Object.assign(new Error('INVALID'), { userMessage: 'Flatpak 識別無效。' })
  const scope = user ? ['--user'] : []
  if (action === 'uninstall') return ['flatpak', ['uninstall', '-y', ...scope, pkg]]
  return ['flatpak', ['install', '-y', ...scope, 'flathub', pkg]]
}

/**
 * 組提權命令。flatpak --user 不提權。絕不會加上 sudo -n／-S。
 * @returns {{ exe: string, args: string[], elevated: boolean, visibleSudo: boolean }}
 */
function privilegeCommand(exe, args, opts = {}) {
  const info = opts.detect || detect(opts)
  if (exe === 'flatpak' && (args.includes('--user') || opts.user !== false)) {
    return { exe, args, elevated: false, visibleSudo: false }
  }
  if (info.graphical) return { exe: info.graphical, args: [exe, ...args], elevated: true, visibleSudo: false }
  if (info.terminal) {
    const prefix = TERMINALS.find(([name]) => name === info.terminal)
    const termArgs = prefix ? prefix[1] : ['-e']
    // 看得見的終端機裡跑 sudo（會問密碼），不用 -n、-S、--non-interactive
    return { exe: info.terminal, args: [...termArgs, 'sudo', exe, ...args], elevated: true, visibleSudo: true }
  }
  throw Object.assign(new Error('NO_PRIVILEGE'), {
    userMessage: '安裝系統套件需要提權：請安裝 pkexec（polkit），或在有終端機的桌面環境再試。不會使用靜默 sudo。'
  })
}

function assertNotSilentSudo(exe, args) {
  const all = [exe, ...args].join(' ')
  if (/(^|\s)sudo(\s|$)/.test(all) && (args.includes('-n') || args.includes('--non-interactive') || args.includes('-S'))) {
    throw Object.assign(new Error('SILENT_SUDO'), { userMessage: '拒絕使用靜默 sudo。' })
  }
}

function run(exe, args, opts = {}) {
  assertNotSilentSudo(exe, args)
  const execFileFn = opts.execFileFn || execFile
  return new Promise((resolve, reject) => {
    try {
      execFileFn(exe, args, { timeout: opts.timeout || 5 * 60_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) => {
          const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0
          resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') })
        })
    } catch (error) { reject(error) }
  })
}

function spawnDetached(exe, args, opts = {}) {
  assertNotSilentSudo(exe, args)
  return new Promise((resolve, reject) => {
    try {
      const child = (opts.spawnFn || spawn)(exe, args, { detached: true, stdio: 'ignore' })
      child.once('error', reject)
      child.once('spawn', () => { child.unref(); resolve({ code: 0, started: true }) })
    } catch (error) { reject(error) }
  })
}

function parseDpkg(text) {
  return String(text || '').split(/\r?\n/).map((line) => {
    const [id, version] = line.split('\t')
    return id && version ? { id, name: id, version, source: 'apt' } : null
  }).filter(Boolean)
}

function parseRpm(text, source = 'dnf') {
  return String(text || '').split(/\r?\n/).map((line) => {
    const [id, version] = line.split('\t')
    return id && version ? { id, name: id, version, source } : null
  }).filter(Boolean)
}

function parsePacman(text) {
  return String(text || '').split(/\r?\n/).map((line) => {
    const m = /^(\S+)\s+(\S+)/.exec(line.trim())
    return m ? { id: m[1], name: m[1], version: m[2], source: 'pacman' } : null
  }).filter(Boolean)
}

function parseFlatpak(text) {
  return String(text || '').split(/\r?\n/).map((line) => {
    const cells = line.split('\t').map((s) => s.trim())
    if (cells.length < 2 || cells[0].toLowerCase() === 'application') return null
    return { id: cells[0], name: cells[2] || cells[0], version: cells[1] || '', source: 'flatpak' }
  }).filter(Boolean)
}


function parseDesktopFile(text, file) {
  const src = String(text || '')
  let block = ''
  for (const part of src.split(/\n(?=\[)/)) {
    if (/^\[Desktop Entry\]/.test(part)) { block = part; break }
  }
  if (!block) return null
  const field = (key) => {
    const m = new RegExp('^' + key + '=(.*)$', 'm').exec(block)
    return m ? m[1].trim() : ''
  }
  if ((field('Type') || 'Application') !== 'Application') return null
  if (/^true$/i.test(field('NoDisplay')) || /^true$/i.test(field('Hidden'))) return null
  const name = field('Name')
  const exec = field('Exec')
  if (!name || !exec) return null
  const id = path.basename(file, '.desktop')
  return { id, name, version: field('Version') || '', source: 'desktop', exec, icon: field('Icon') || '', desktop: file }
}

function applicationDirs(opts = {}) {
  const env = opts.env || process.env
  const home = opts.home || env.HOME || os.homedir()
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local/share')
  const extra = String(env.XDG_DATA_DIRS == null ? '/usr/local/share:/usr/share' : env.XDG_DATA_DIRS).split(':').filter(Boolean)
  const dirs = [path.join(dataHome, 'applications')]
  for (const root of extra) dirs.push(path.join(root, 'applications'))
  return dirs
}

function listDesktopApps(opts = {}) {
  const readDir = opts.readDir || ((dir) => fs.readdirSync(dir))
  const readFile = opts.readFile || ((file) => fs.readFileSync(file, 'utf8'))
  const seen = new Set()
  const rows = []
  for (const dir of applicationDirs(opts)) {
    let names = []
    try { names = readDir(dir) } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.desktop')) continue
      const file = path.join(dir, name)
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      let parsed
      try { parsed = parseDesktopFile(readFile(file), file) } catch { continue }
      if (!parsed) continue
      seen.add(key)
      rows.push(parsed)
    }
  }
  return rows
}

async function listInstalled(opts = {}) {
  const info = opts.detect || detect(opts)
  const runFn = opts.run || ((exe, args) => run(exe, args, opts))
  const rows = []
  if (info.native === 'apt') {
    const r = await runFn('dpkg-query', ['-W', '-f', '${Package}\\t${Version}\\n'])
    rows.push(...parseDpkg(r.stdout))
  } else if (info.native === 'dnf' || info.native === 'zypper') {
    const r = await runFn('rpm', ['-qa', '--qf', '%{NAME}\\t%{VERSION}\\n'])
    rows.push(...parseRpm(r.stdout, info.native))
  } else if (info.native === 'pacman') {
    const r = await runFn('pacman', ['-Q'])
    rows.push(...parsePacman(r.stdout))
  }
  if (info.flatpak) {
    const r = await runFn('flatpak', ['list', '--app', '--columns=application,version,name'])
    rows.push(...parseFlatpak(r.stdout))
  }
  const desktops = (opts.listDesktopApps || listDesktopApps)(opts)
  const have = new Set(rows.map((row) => String(row.id || '').toLowerCase()))
  const haveName = new Set(rows.map((row) => String(row.name || '').toLowerCase()))
  for (const row of desktops) {
    const id = String(row.id || '').toLowerCase()
    const name = String(row.name || '').toLowerCase()
    if (have.has(id) || haveName.has(name)) continue
    have.add(id)
    haveName.add(name)
    rows.push(row)
  }
  return rows
}

async function search(query, opts = {}) {
  const q = String(query || '').trim()
  if (!q || q.length > 80) return []
  const info = opts.detect || detect(opts)
  const runFn = opts.run || ((exe, args) => run(exe, args, { ...opts, timeout: 20_000 }))
  const rows = []
  if (info.native === 'apt') {
    const r = await runFn('apt-cache', ['search', '--names-only', '--', q])
    for (const line of String(r.stdout || '').split(/\n/)) {
      const m = /^(\S+)\s+-\s+(.*)$/.exec(line)
      if (m) rows.push({ id: m[1], name: m[1], description: m[2], source: 'apt' })
    }
  } else if (info.native === 'dnf' || info.native === 'zypper') {
    const exe = info.native
    const r = await runFn(exe, info.native === 'zypper' ? ['--non-interactive', 'search', '--', q] : ['search', '-C', q])
    for (const line of String(r.stdout || '').split(/\n/)) {
      const cells = line.split('|').map((s) => s.trim())
      if (cells.length >= 3 && !/^[-+|]+$/.test(line) && !/name/i.test(cells[1] || '')) {
        rows.push({ id: cells[1], name: cells[1], description: cells[2] || '', source: info.native })
      }
    }
  } else if (info.native === 'pacman') {
    const r = await runFn('pacman', ['-Ss', '--', q])
    const lines = String(r.stdout || '').split(/\n/)
    for (let i = 0; i < lines.length; i++) {
      const m = /^[^\s/]+\/(\S+)\s+(\S+)/.exec(lines[i])
      if (m) rows.push({ id: m[1], name: m[1], version: m[2], description: (lines[i + 1] || '').trim(), source: 'pacman' })
    }
  }
  if (info.flatpak) {
    const r = await runFn('flatpak', ['search', '--columns=application,name,description', q])
    for (const line of String(r.stdout || '').split(/\n/)) {
      const cells = line.split('\t').map((s) => s.trim())
      if (cells[0] && cells[0].toLowerCase() !== 'application') {
        rows.push({ id: cells[0], name: cells[1] || cells[0], description: cells[2] || '', source: 'flatpak' })
      }
    }
  }
  return rows
}

module.exports = {
  GRAPHICAL_SUDO, detect, hasCommand, nativeArgs, flatpakArgs, privilegeCommand,
  assertNotSilentSudo, run, spawnDetached, listInstalled, search,
  parseDpkg, parseRpm, parsePacman, parseFlatpak, parseDesktopFile, listDesktopApps, applicationDirs
}
