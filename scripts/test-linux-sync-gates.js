#!/usr/bin/env node
'use strict'

/**
 * master v1.52～v1.61 新功能在 Linux 的對應：
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
  assert.match(src, /if \(process\.platform !== 'win32'\) throw fail\('UNSUPPORTED', UNSUPPORTED_MESSAGE\)/)
  assert.match(src, /Linux 版暫不支援螢幕翻譯/)
}

claude()
miroxen()
screenTranslate()
console.log('test-linux-sync-gates: all passed')
