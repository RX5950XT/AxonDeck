'use strict'

/**
 * Linux 開機自啟動：寫使用者層的 XDG Autostart（~/.config/autostart）。
 * Electron 的 setLoginItemSettings 只支援 Windows／macOS，AppImage 若誤用
 * process.execPath 還會寫到掛載點（關掉就消失），所以必須自己處理。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const DESKTOP_ID = 'axondeck.desktop'
const MARKER = 'X-AxonDeck-Autostart=1'
const DEFAULT_ARGS = ['--hidden']

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function autostartDir(env = process.env) {
  const home = env.HOME || os.homedir()
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config')
  return path.join(config, 'autostart')
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function desktopPath(env = process.env) {
  return path.join(autostartDir(env), DESKTOP_ID)
}

/**
 * AppImage 要用 APPIMAGE（實際檔案）；已安裝的 deb／rpm 用 execPath。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [execPath]
 * @returns {string}
 */
function resolveExec(env = process.env, execPath = process.execPath) {
  if (env.APPIMAGE && exists(env.APPIMAGE)) return env.APPIMAGE
  return execPath
}

function exists(file) {
  try {
    fs.accessSync(file)
    return true
  } catch {
    return false
  }
}

/** @param {string} value */
function quote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * @param {{ exec: string, args?: string[] }} opts
 * @returns {string}
 */
function desktopEntry(opts) {
  const args = Array.isArray(opts.args) && opts.args.length ? opts.args : DEFAULT_ARGS
  const exec = [quote(opts.exec), ...args.map(String)].join(' ')
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=AxonDeck',
    'Comment=開機時啟動 AxonDeck（縮在系統匣）',
    'Exec=' + exec,
    'Icon=axondeck',
    'Terminal=false',
    'Categories=Utility;',
    'X-GNOME-Autostart-enabled=true',
    'Hidden=false',
    MARKER,
    ''
  ].join('\n')
}

function isOurs(text) {
  return typeof text === 'string' && (text.includes(MARKER) || /^Name=AxonDeck$/m.test(text))
}

/**
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {boolean}
 */
function isEnabled(opts = {}) {
  try {
    const text = fs.readFileSync(desktopPath(opts.env), 'utf8')
    if (!isOurs(text)) return false
    return !/^Hidden\s*=\s*true\b/im.test(text)
  } catch {
    return false
  }
}

/**
 * @param {boolean} enabled
 * @param {{ env?: NodeJS.ProcessEnv, execPath?: string, args?: string[] }} [opts]
 * @returns {{ openAtLogin: boolean, supported: true }}
 */
function setEnabled(enabled, opts = {}) {
  const env = opts.env || process.env
  const file = desktopPath(env)
  if (!enabled) {
    try {
      const text = fs.readFileSync(file, 'utf8')
      if (isOurs(text)) fs.unlinkSync(file)
    } catch { /* 沒有檔就當已關閉 */ }
    return { openAtLogin: false, supported: true }
  }
  fs.mkdirSync(autostartDir(env), { recursive: true, mode: 0o755 })
  const exec = resolveExec(env, opts.execPath)
  fs.writeFileSync(file, desktopEntry({ exec, args: opts.args || DEFAULT_ARGS }), { mode: 0o644 })
  return { openAtLogin: true, supported: true }
}

/**
 * 卸載時只刪我們寫過的 autostart 檔，不碰使用者其他項目。
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
function remove(opts = {}) {
  setEnabled(false, opts)
}

module.exports = {
  DESKTOP_ID,
  MARKER,
  DEFAULT_ARGS,
  autostartDir,
  desktopPath,
  resolveExec,
  desktopEntry,
  isEnabled,
  setEnabled,
  remove
}
