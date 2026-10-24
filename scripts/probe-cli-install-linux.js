'use strict'

/**
 * 真的連網安裝（Linux）：用 cli-install.js 的真實 runner，把 Codex（npm）與 Antigravity CLI（官方 install.sh）
 * 裝進暫存 HOME，驗證兩條路徑都能從零裝到 `--version`。不碰真的家目錄、不 sudo、結束整個刪掉。
 *
 * - HOME 指到 test-temp 的暫存資料夾；PATH 只留 /usr/bin:/bin（避免找到使用者已裝的那份而改跑 update）
 * - NPM_CONFIG_PREFIX=/proc（不可寫）→ 驗證「全域 prefix 不可寫 → 改裝到 ~/.local」這條
 *
 * 用法：node scripts/probe-cli-install-linux.js [codex|agy ...]   （預設兩個都裝；會下載數十 MB）
 */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { tempDir } = require('./lib/test-temp')
const cli = require('../src/main/ccswitch/cli-install')

async function main() {
  if (process.platform !== 'linux') { console.log('SKIP 非 Linux'); return }
  if (process.getuid?.() === 0) throw new Error('不要用 root 跑（會變成真的寫進 /usr）')
  const keys = process.argv.slice(2).length ? process.argv.slice(2) : ['codex', 'agy']
  let failed = 0
  for (const key of keys) {
    const home = tempDir(`probe-${key}-`)
    const env = { HOME: home, PATH: '/usr/bin:/bin', NPM_CONFIG_PREFIX: '/proc', LANG: 'C.UTF-8' }
    const pre = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', `export PATH="${home}/.local/bin:/usr/bin:/bin"; command -v ${key}`], { encoding: 'utf8' })
    if (pre.status === 0) { console.log(`SKIP ${key}：系統路徑已有 ${pre.stdout.trim()}，這支只驗從零安裝`); continue }
    const started = Date.now()
    const result = await cli.createRunner({ platform: 'linux', env }).run(key)
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    const binary = path.join(home, '.local', 'bin', key)
    const good = result.phase === 'succeeded' && result.action === 'install' && fs.existsSync(binary)
    if (!good) failed++
    console.log(`${good ? 'PASS' : 'FAIL'} ${key}：${result.phase} ${result.local || ''} ${result.message || ''} ${result.summary || ''}（${seconds}s）`)
    if (good) console.log(`      → ${path.relative(home, binary)}（暫存 HOME 內）`)
  }
  if (failed) process.exitCode = 1
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })
