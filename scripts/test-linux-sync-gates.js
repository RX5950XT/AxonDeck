#!/usr/bin/env node
'use strict'

/**
 * master 新功能在 Linux 的對應：
 * - Claude 多帳號登入找 `claude`（不是 claude.exe）
 * - Miroxen（生成圖片影像）只有 Windows 版：Linux 不列引擎與生成模型、IPC 回中文說明
 * - 螢幕翻譯在 Linux 回中文說明（取景框無法從擷取中排除自己）
 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')

const root = path.join(__dirname, '..')

function claude() {
  const accounts = require('../src/main/usage/claude-accounts')
  const home = tempDir('claude-linux-')
  try {
    const bin = path.join(home, '.local', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'claude'), '')
    assert.equal(accounts.findClaude(home, { PATH: '' }, 'linux'), path.join(bin, 'claude'))
    assert.equal(accounts.findClaude(home, { PATH: '' }, 'win32'), '', 'Windows 仍只認 claude.exe')
    fs.writeFileSync(path.join(bin, 'claude.exe'), '')
    assert.equal(accounts.findClaude(home, { PATH: '' }, 'win32'), path.join(bin, 'claude.exe'))
    const other = path.join(home, 'npm-bin')
    fs.mkdirSync(other)
    fs.writeFileSync(path.join(other, 'claude'), '')
    fs.rmSync(path.join(bin, 'claude'))
    assert.equal(accounts.findClaude(home, { PATH: other }, 'linux'), path.join(other, 'claude'), 'PATH 也找')
  } finally {
    removeTree(home)
  }
}

function miroxen() {
  const models = require('../src/main/models')
  const keys = Object.keys(models.MODELS).filter((key) => key.startsWith('miroxen'))
  if (process.platform === 'win32') {
    assert.ok(keys.includes('miroxenruntime'), 'Windows 照舊列 Miroxen')
  } else {
    assert.deepEqual(keys, [], 'Linux 不列 Miroxen 引擎與生成模型')
    assert.deepEqual(models.MIROXEN_MODEL_KEYS, [])
  }
  const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8')
  assert.match(main, /const MIROXEN_UNSUPPORTED = 'Linux 版暫不支援「生成圖片影像」/)
  assert.match(main, /const MIROXEN_SUPPORTED = process\.platform === 'win32'/)
  assert.match(main, /status: async \(options\) => MIROXEN_SUPPORTED\n\s+\? loadMiroxen\(\)\.status\(options\)/, 'Windows 照舊走 Miroxen 模組')
  assert.match(main, /if \(!MIROXEN_SUPPORTED\) throw miroxenUnsupported\(\)\n\s+return loadMiroxen\(\)/, '其他動作在非 Windows 直接回中文錯誤')
  for (const name of ['start', 'openOutput', 'api', 'setLan']) {
    assert.match(main, new RegExp(`${name}: async \\([^)]*\\) => \\(await loadMiroxenChecked\\(\\)\\)\\.${name}\\(`), `${name} 要先過平台檢查`)
  }
  const page = fs.readFileSync(path.join(root, 'src/renderer/scripts/imagegen-page.js'), 'utf8')
  assert.match(page, /status\.supported === false/, '生成圖片影像頁顯示平台說明')
}

function screenTranslate() {
  const src = fs.readFileSync(path.join(root, 'src/main/screen-translate/index.js'), 'utf8')
  assert.match(src, /captureExcludingWindow/)
  assert.match(src, /setOpacity\(0\)/)
  assert.doesNotMatch(src, /if \(process\.platform !== 'win32'\) throw fail\('UNSUPPORTED', UNSUPPORTED_MESSAGE\)/)
}

function ocrOverlay() {
  const models = require('../src/main/models')
  if (process.platform === 'win32' || process.platform === 'linux') {
    assert.ok(models.MODELS.unlimitedocr2q8, 'Windows／Linux 都列 Unlimited-OCR-2')
    assert.deepEqual(models.OCR_MODEL_KEYS, ['unlimitedocr2q8'])
  } else {
    assert.equal(models.MODELS.unlimitedocr2q8, undefined)
    assert.deepEqual(models.OCR_MODEL_KEYS, [])
  }
  const patch = fs.readFileSync(path.join(root, 'scripts/patches/unlimited-ocr2.patch'), 'utf8')
  assert.match(patch, /unlimited-ocr2/)
  const script = fs.readFileSync(path.join(root, 'scripts/build-unlimited-ocr2-linux.sh'), 'utf8')
  assert.match(script, /unlimited-ocr2.patch/)
}

function terminalAdminAndWsl() {
  const pty = fs.readFileSync(path.join(root, 'src/main/terminal/pty.js'), 'utf8')
  assert.match(pty, /supportsAdmin: platform\.isWindows/, '系統管理員終端機只在 Windows 開放')
  const store = fs.readFileSync(path.join(root, 'src/main/terminal/store.js'), 'utf8')
  assert.match(store, /const SHELLS = platform\.isWindows \? WINDOWS_SHELLS : LINUX_SHELLS/)
  assert.match(store, /wsl: \{ label: 'WSL（Linux）', exe: 'wsl\.exe' \}/)
  assert.match(store, /const LINUX_SHELLS = \{[\s\S]*bash:/)
  const tabs = fs.readFileSync(path.join(root, 'src/renderer/scripts/ws-tabs.js'), 'utf8')
  assert.match(tabs, /if \(supportsAdmin\)/, '終端機子選單在 Linux 不畫 UAC 盾牌')
}

function clipboardFormats() {
  const { parseUriList, parseGnomeCopiedFiles, pathContains } = require('../src/main/explorer/clipboard-formats')
  const { pathToFileURL } = require('url')
  const a = '/tmp/axd-clip-src'
  const b = '/tmp/axd-clip-src/inner'
  assert.deepEqual(parseUriList(`# comment\n${pathToFileURL('/tmp/foo bar.txt').href}\nfile://host/x`), ['/tmp/foo bar.txt'])
  assert.deepEqual(parseGnomeCopiedFiles(`cut\n${pathToFileURL('/home/box/a').href}`), { mode: 'cut', paths: ['/home/box/a'] })
  assert.deepEqual(parseGnomeCopiedFiles(`copy\n${pathToFileURL('/home/box/a').href}`), { mode: 'copy', paths: ['/home/box/a'] })
  if (process.platform !== 'win32') {
    assert.equal(pathContains(a, b), true)
    assert.equal(pathContains(a, '/tmp/axd-clip-SRC/inner'), false, 'Linux 路徑要分大小寫')
  }
}

function mimeAndThumbs() {
  const shell = require('../src/main/explorer/shell')
  assert.equal(shell.mimeOfExt('.html'), 'text/html')
  assert.equal(shell.mimeOfExt('JSON'), 'application/json')
  assert.equal(shell.mimeOfExt('.axondeck-no-such-ext'), '')
  const thumbs = fs.readFileSync(path.join(root, 'src/main/explorer/media-thumbs.js'), 'utf8')
  assert.match(thumbs, /findOnPath\('mpv'\)/)
  assert.match(thumbs, /findOnPath\('magick'\) \|\| findOnPath\('convert'\)/)
}

claude()
miroxen()
screenTranslate()
ocrOverlay()
terminalAdminAndWsl()
clipboardFormats()
mimeAndThumbs()
console.log('test-linux-sync-gates: all passed')
