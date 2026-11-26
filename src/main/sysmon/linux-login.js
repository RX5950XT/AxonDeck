'use strict'

/**
 * Linux：登入時套用風扇／效能設定的使用者服務。
 * 對應 Windows 的「免 UAC 排程工作」。寫入不需要 root；PWM 寫入權限仍靠既有的
 * udev 規則（使用者按一次「授權風扇控制」安裝）。
 *
 * 優先 systemd --user；沒有 systemctl 時退回 XDG Autostart（獨立 desktop，不覆蓋 App 開機自啟動）。
 * 帶 --user-data-dir 的預覽／測試不會寫入。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

const UNIT_NAME = 'axondeck-sensors.service'
const DESKTOP_ID = 'axondeck-sensors.desktop'
const MARKER = 'X-AxonDeck-Sensors=1'
const DEFAULT_ARGS = ['--hidden']

function isPreview(argv = process.argv, env = process.env) {
  if (env.AXONDECK_TEST) return true
  return (argv || []).some((arg) => arg === '--user-data-dir' || String(arg).startsWith('--user-data-dir='))
}

function resolveExec(env = process.env, execPath = process.execPath) {
  if (env.APPIMAGE && exists(env.APPIMAGE)) return env.APPIMAGE
  return execPath
}

function exists(file) {
  try { fs.accessSync(file); return true } catch { return false }
}

function quote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function configHome(env = process.env) {
  return env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config')
}

function unitPath(env = process.env) {
  return path.join(configHome(env), 'systemd', 'user', UNIT_NAME)
}

function desktopPath(env = process.env) {
  return path.join(configHome(env), 'autostart', DESKTOP_ID)
}

function unitText(exec, args = DEFAULT_ARGS) {
  const command = [exec, ...args].map((part) => (/\s/.test(part) ? quote(part) : part)).join(' ')
  return [
    '[Unit]',
    'Description=AxonDeck fan and performance settings at login',
    'After=graphical-session.target',
    '',
    '[Service]',
    'Type=simple',
    'ExecStart=' + command,
    'Restart=on-failure',
    'RestartSec=8',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n')
}

function desktopEntry(exec, args = DEFAULT_ARGS) {
  const command = [quote(exec), ...args.map(String)].join(' ')
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=AxonDeck Sensors',
    'Comment=登入時套用 AxonDeck 風扇與效能設定',
    'Exec=' + command,
    'Icon=axondeck',
    'Terminal=false',
    'Hidden=false',
    'X-GNOME-Autostart-enabled=true',
    MARKER,
    ''
  ].join('\n')
}

function isOurs(file, kind) {
  if (!exists(file)) return false
  try {
    const text = fs.readFileSync(file, 'utf8')
    if (kind === 'desktop') return text.includes(MARKER)
    return text.includes('Description=AxonDeck fan and performance settings at login')
  } catch {
    return false
  }
}

function runSystemctl(args, deps = {}) {
  const fn = deps.execFileFn || execFile
  const env = deps.env || process.env
  return new Promise((resolve) => {
    try {
      fn('systemctl', ['--user', ...args], {
        timeout: 8000,
        encoding: 'utf8',
        env,
        windowsHide: true
      }, (error, stdout, stderr) => {
        resolve({ ok: !error, code: error && error.code, stdout: String(stdout || ''), stderr: String(stderr || '') })
      })
    } catch (err) {
      resolve({ ok: false, error: err })
    }
  })
}

function hasSystemctl(deps = {}) {
  if (deps.hasSystemctl != null) return Boolean(deps.hasSystemctl)
  const env = deps.env || process.env
  for (const dir of String(env.PATH || '/usr/bin:/bin').split(path.delimiter)) {
    if (exists(path.join(dir, 'systemctl'))) return true
  }
  return exists('/usr/bin/systemctl')
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o644 })
}

function removeFile(file) {
  try { fs.unlinkSync(file) } catch { /* 本來就沒有 */ }
}

/**
 * @param {object} [opts]
 * @returns {Promise<{ installed: boolean, kind: string, preview?: boolean, reason?: string, unit?: string, desktop?: string }>}
 */
async function install(opts = {}) {
  const env = opts.env || process.env
  const argv = opts.argv || process.argv
  if (isPreview(argv, env)) {
    return { installed: false, kind: '', preview: true, reason: '預覽或測試模式不註冊登入服務。' }
  }
  const exec = opts.exec || resolveExec(env, opts.execPath || process.execPath)
  const args = Array.isArray(opts.args) && opts.args.length ? opts.args : DEFAULT_ARGS
  const unit = unitPath(env)
  const desktop = desktopPath(env)

  if (opts.prefer === 'xdg' || !hasSystemctl(opts)) {
    writeFile(desktop, desktopEntry(exec, args))
    return { installed: true, kind: 'xdg', desktop }
  }

  writeFile(unit, unitText(exec, args))
  const reload = await runSystemctl(['daemon-reload'], opts)
  const enable = await runSystemctl(['enable', UNIT_NAME], opts)
  if (!reload.ok || !enable.ok) {
    // systemd 使用者服務啟用失敗時仍留 XDG，登入還是會套用
    writeFile(desktop, desktopEntry(exec, args))
    return { installed: true, kind: 'xdg', unit, desktop, reason: 'systemctl --user 啟用失敗，已改寫 XDG Autostart。' }
  }
  // 成功走 systemd 就不要再用第二份 XDG，以免開兩次
  if (isOurs(desktop, 'desktop')) removeFile(desktop)
  return { installed: true, kind: 'systemd', unit }
}

/**
 * @param {object} [opts]
 */
function status(opts = {}) {
  const env = opts.env || process.env
  const unit = unitPath(env)
  const desktop = desktopPath(env)
  const systemd = isOurs(unit, 'unit')
  const xdg = isOurs(desktop, 'desktop')
  return {
    installed: systemd || xdg,
    kind: systemd ? 'systemd' : (xdg ? 'xdg' : ''),
    canInstall: !isPreview(opts.argv || process.argv, env),
    preview: isPreview(opts.argv || process.argv, env),
    unit: systemd ? unit : '',
    desktop: xdg ? desktop : ''
  }
}

/**
 * 只刪我們寫的 unit／desktop。
 * @param {object} [opts]
 */
async function remove(opts = {}) {
  const env = opts.env || process.env
  const unit = unitPath(env)
  const desktop = desktopPath(env)
  if (isOurs(unit, 'unit')) {
    await runSystemctl(['disable', '--now', UNIT_NAME], opts)
    removeFile(unit)
    await runSystemctl(['daemon-reload'], opts)
  }
  if (isOurs(desktop, 'desktop')) removeFile(desktop)
  return { installed: false, kind: '' }
}

module.exports = {
  UNIT_NAME,
  DESKTOP_ID,
  MARKER,
  isPreview,
  resolveExec,
  unitPath,
  desktopPath,
  unitText,
  desktopEntry,
  install,
  status,
  remove
}
