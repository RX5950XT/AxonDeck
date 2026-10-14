'use strict'

// 真實 Grok TUI / ConPTY；只輸入未送出的測試草稿與命令面板，不送 AI 提問。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { tempDir } = require('./lib/test-temp')

if (!process.versions.electron) {
  const { spawn } = require('node:child_process')
  const child = spawn(path.join(__dirname, '../node_modules/electron/dist/electron.exe'), [__filename], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'inherit'
  })
  child.on('exit', code => { process.exitCode = code || 0 })
  child.on('error', error => { console.error(error); process.exitCode = 1 })
} else {
  const pty = require('@lydell/node-pty')
  const exe = path.join(os.homedir(), '.grok/bin/grok.exe')
  const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const clean = value => value.replace(ANSI, '')

  function isolatedEnv(home, profile) {
    const env = { ...process.env, GROK_HOME: home, GROK_SHOW_TIMELINE: 'false', TERM: 'xterm-256color',
      TERM_PROGRAM: 'ghostty', TERM_PROGRAM_VERSION: '1.1.0', USERPROFILE: profile, HOME: profile,
      APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local') }
    for (const key of Object.keys(env)) {
      if (/^(?:XAI|GROK|OPENAI|ANTHROPIC|CLAUDE|CODEX)_.*(?:KEY|TOKEN|AUTH)/i.test(key)) delete env[key]
    }
    env.XAI_API_KEY = 'axondeck-conpty-probe-unused'
    return env
  }

  async function until(terminal, read, predicate, message, timeout = 12000) {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (terminal.exited) throw new Error(`${message}: Grok 提前結束`)
      if (predicate(clean(read()))) return clean(read())
      await wait(100)
    }
    throw new Error(`${message}; captured ${read().length} terminal characters`)
  }

  async function run(mode) {
    const profile = tempDir(`grok-nav-${mode}-`)
    const home = path.join(profile, '.grok')
    const cwd = path.join(profile, 'project')
    fs.mkdirSync(cwd, { recursive: true })
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'config.toml'), '[auth]\npreferred_method = "api_key"\n[ui]\nscreen_mode = "minimal"\nshow_timeline = false\n')
    // --minimal --no-alt-screen 留在一般緩衝區且不開滑鼠回報，AxonDeck 捲軸與跳轉才找得到列。
    const args = mode === 'fullscreen'
      ? ['--fullscreen', '--leader-socket', path.join(home, 'leader.sock')]
      : ['--minimal', '--no-alt-screen', '--leader-socket', path.join(home, 'leader.sock')]
    const terminal = pty.spawn(exe, args, { cwd, cols: 120, rows: 36, env: isolatedEnv(home, profile), name: 'xterm-256color' })
    let output = ''
    terminal.exited = false
    terminal.onData(data => {
      output += data
      if (data.includes('\x1b[6n')) terminal.write('\x1b[1;1R')
    })
    terminal.onExit(() => { terminal.exited = true })
    try {
      await until(terminal, () => output, value => /grok build/i.test(value), 'TUI 啟動')
      await wait(400)
      const alternate = /\x1b\[\?(?:\d+;)*(?:1049|1047|47)(?:;\d+)*h/.test(output)
      const mouse = /\x1b\[\?(?:\d+;)*(?:1000|1002|1003)(?:;\d+)*h/.test(output)
      if (mode === 'fullscreen') {
        assert(alternate, 'fullscreen 應進入 alternate-screen')
        console.log(JSON.stringify({ mode, alternate, mouse }))
        return
      }
      assert(!alternate, '--minimal --no-alt-screen 不應切換 terminal buffer')
      assert(!mouse, '--minimal --no-alt-screen 不應打開滑鼠回報')
      const draft = 'AXONDECK_UNSENT_GROK_DRAFT'
      terminal.write(draft)
      await until(terminal, () => output, value => value.includes(draft), '輸入未送出的測試草稿')
      terminal.write('\x10')
      await until(terminal, () => output, value => /esc close/i.test(value), 'Ctrl+P 開命令面板')
      terminal.write('jump')
      await until(terminal, () => output, value => /no matches/i.test(value), '確認沒有原生跳轉命令')
      terminal.write('\x1b')
      await wait(400)
      assert(clean(output).includes(draft), '關閉命令面板後，未送出的草稿仍在')
      console.log(JSON.stringify({ mode, alternate, mouse, nativeJump: false, draftPreserved: true }))
    } finally {
      if (!terminal.exited) {
        try { execFileSync('taskkill', ['/PID', String(terminal.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 已退出 */ }
        terminal.kill()
      }
    }
  }

  assert(fs.existsSync(exe), `找不到 Grok CLI: ${exe}`)
  run('shipped').then(() => run('fullscreen')).then(() => {
    console.log('PASS Grok --minimal --no-alt-screen 留在一般緩衝區且不開滑鼠回報；單獨 --fullscreen 會進 alternate screen；未送出 AI 提問')
  }).catch(error => { console.error(error); process.exitCode = 1 })
}
