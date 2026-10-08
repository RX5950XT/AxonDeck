'use strict'

/**
 * AxonDeck — Linux「root 終端機」（Windows 管理員終端機的對應）。
 *
 * Windows 要另開一顆提權的 host 程序（UAC 沒辦法把 pty handle 交接過去）；Linux 不用：
 * pty 照常由我們開，只是跑的程式換成提權工具，**密碼在終端機裡輸入**——
 * 那是提權工具自己讀 tty（不回顯），AxonDeck 不讀、不存、不另外問。
 *
 * 提權工具依序挑第一個存在的（絕對路徑，不靠 PATH）：
 *   sudo   `sudo -- <shell>`：保留目前工作目錄與選的 shell；HOME／PATH 由 sudoers 的 env_reset 決定
 *   run0   systemd 256 起內建：`run0 --chdir=<cwd> <shell>`，polkit 在 tty 上問密碼
 *   pkexec `pkexec /bin/sh -c 'cd "$1"; TERM=…; exec "$3"' …`：pkexec 會把目錄換成 /root、清掉 TERM，所以補回來；
 *          有圖形 polkit agent 就跳視窗，沒有就退回 tty 上的文字 agent
 * App 本身已經是 root 就直接開 shell。
 *
 * Linux 的終端機在主程序內跑（service.js 的 IN_PROCESS），pty.js 只在 Linux 才 require 這支，
 * 所以不必進 host-runtime.js 的 HOST_FILES（Windows 的背景宿主不會載到它）。
 */

const fs = require('node:fs')

const TOOLS = {
  sudo: ['/usr/bin/sudo', '/bin/sudo'],
  run0: ['/usr/bin/run0', '/bin/run0'],
  pkexec: ['/usr/bin/pkexec', '/bin/pkexec']
}
const ORDER = ['sudo', 'run0', 'pkexec']
/** 測試用：讓 pty.js 走假的 sudo（真的提示密碼那條路在測試機上走不到） */
let detectOverride = null

const PKEXEC_SCRIPT = 'cd -- "$1" 2>/dev/null; TERM="$2"; export TERM; exec "$3"'

/** 分頁與對話框用的字；Windows 不用這份 */
const COPY = {
  menu: '以 root 身分執行',
  context: '以 root 身分開啟終端機',
  dialog: '以 root 身分執行',
  badge: 'root'
}

const defaultExists = (p) => {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * @param {{ exists?: (p: string) => boolean, uid?: () => number }} [deps]
 * @returns {{ method: ''|'root'|'sudo'|'run0'|'pkexec', bin: string }}
 */
function detect(deps = {}) {
  if (detectOverride) return detectOverride()
  const exists = deps.exists || defaultExists
  const uid = deps.uid ? deps.uid() : (typeof process.getuid === 'function' ? process.getuid() : -1)
  if (uid === 0) return { method: 'root', bin: '' }
  for (const method of ORDER) {
    const bin = TOOLS[method].find((p) => exists(p))
    if (bin) return { method, bin }
  }
  return { method: '', bin: '' }
}

/**
 * 實際要 spawn 的程式。shellExe 必須是絕對路徑（store.resolveExe 的結果）。
 * @param {{ method: string, bin: string }} tool
 * @param {string} shellExe
 * @param {string[]} shellArgs
 * @param {string} cwd
 * @returns {{ exe: string, args: string[] }}
 */
function rootCommand(tool, shellExe, shellArgs, cwd) {
  if (!shellExe.startsWith('/')) throw Object.assign(new Error('ROOT_SHELL'), { code: 'ROOT_SHELL', userMessage: '找不到 shell 的完整路徑。' })
  switch (tool.method) {
    case 'root': return { exe: shellExe, args: shellArgs }
    case 'sudo': return { exe: tool.bin, args: ['--', shellExe, ...shellArgs] }
    case 'run0': return { exe: tool.bin, args: [`--chdir=${cwd}`, shellExe, ...shellArgs] }
    case 'pkexec': return { exe: tool.bin, args: ['/bin/sh', '-c', PKEXEC_SCRIPT, 'axondeck-root', cwd, 'xterm-256color', shellExe] }
    default:
      throw Object.assign(new Error('ROOT_UNSUPPORTED'), {
        code: 'ROOT_UNSUPPORTED',
        userMessage: '這台機器沒有 sudo、run0 或 pkexec，開不了 root 終端機。'
      })
  }
}

/** 開頭那一行說明（寫進終端機畫面，不是送給 shell） */
function banner(tool) {
  const how = tool.method === 'root' ? 'AxonDeck 本身就是 root，直接開 shell'
    : `${tool.method} 會在下面問密碼；密碼由 ${tool.method} 直接讀，AxonDeck 不會看到也不會存`
  return `\x1b[1;37;41m root \x1b[0m \x1b[2m${how}。\x1b[0m\r\n`
}

const FAILURES = [
  [/is not in the sudoers file|is not allowed to run sudo|not in the sudoers|不在 sudoers/i,
    '這個帳號沒有 sudo 權限（不在 sudoers）。請系統管理員把你加進 sudo（Debian／Ubuntu）或 wheel（Fedora／Arch）群組，或改開一般終端機。'],
  [/incorrect password attempt|密碼錯誤/i, '密碼錯了三次，sudo 已放棄。關掉這個分頁再開一次 root 終端機即可重試。'],
  [/Request dismissed|Not authorized|AUTHENTICATING FOR|Error executing command as another user|Authentication failed|authentication .*failed/i,
    '授權沒有通過（取消、密碼錯誤，或這個帳號不是系統管理員）。'],
  [/a password is required|no tty present|a terminal is required/i, 'sudo 需要密碼卻讀不到終端機輸入。']
]

/**
 * root 分頁很快就結束（非 0）時，從最後的輸出判斷原因，回一行要補在畫面上的說明；判斷不了回 ''。
 * @param {string} tail 最後幾 KB 輸出
 * @param {number|null} exitCode
 */
function failureHint(tail, exitCode) {
  if (exitCode === 0) return ''
  const text = String(tail || '').slice(-4096)
  for (const [re, hint] of FAILURES) if (re.test(text)) return `\r\n\x1b[33m[AxonDeck] ${hint}\x1b[0m\r\n`
  return ''
}

module.exports = {
  TOOLS, ORDER, COPY, PKEXEC_SCRIPT, detect, rootCommand, banner, failureHint,
  _setDetectForTest(fn) { detectOverride = typeof fn === 'function' ? fn : null }
}
