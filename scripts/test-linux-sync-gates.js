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
  const runtime = require('../src/main/miroxen/runtime')
  const keys = Object.keys(models.MODELS).filter((key) => key.startsWith('miroxen'))
  if (process.platform === 'win32') {
    assert.ok(keys.includes('miroxenruntime'), 'Windows 照舊列 Miroxen')
    assert.equal(runtime.ENGINE, 'miroxen-win-x64.zip')
    assert.ok(runtime.ENGINE_FILES.includes('miroxen.exe'))
  } else if (process.platform === 'linux') {
    assert.ok(keys.includes('miroxenruntime'), 'Linux 也列 Miroxen 引擎')
    assert.match(runtime.ENGINE, /^miroxen-linux-(x64|arm64)\.tar\.gz$/)
    assert.ok(runtime.ENGINE_FILES.includes('miroxen'))
    assert.doesNotMatch(runtime.ENGINE, /win-x64/)
  } else {
    assert.deepEqual(keys, [])
  }
  const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8')
  assert.match(main, /const MIROXEN_SUPPORTED = process\.platform === 'win32' \|\| process\.platform === 'linux'/)
  const page = fs.readFileSync(path.join(root, 'src/renderer/scripts/imagegen-page.js'), 'utf8')
  assert.match(page, /status\.supported === false/, '沒有發行檔或非支援平台時頁面仍能顯示說明')
}

function screenTranslate() {
  const src = fs.readFileSync(path.join(root, 'src/main/screen-translate/index.js'), 'utf8')
  assert.match(src, /if \(process\.platform !== 'win32'\) throw fail\('UNSUPPORTED', UNSUPPORTED_MESSAGE\)/)
  assert.match(src, /Linux 版暫不支援螢幕翻譯/)
}

function ocrOverlay() {
  const models = require('../src/main/models')
  if (process.platform === 'win32') {
    assert.ok(models.MODELS.unlimitedocr2q8, 'Windows 照舊列 Unlimited-OCR-2')
    assert.deepEqual(models.OCR_MODEL_KEYS, ['unlimitedocr2q8'])
  } else {
    assert.equal(models.MODELS.unlimitedocr2q8, undefined, 'Linux 不列需要 Windows llama 補丁的 OCR 模型')
    assert.deepEqual(models.OCR_MODEL_KEYS, [])
  }
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
