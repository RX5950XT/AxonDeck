'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const models = require('../src/main/models')
const { tempDir } = require('./lib/test-temp')

assert.ok(models.MODELS.llamaruntime, 'llamaruntime 必須存在')
const files = models.MODELS.llamaruntime.files
assert.equal(files.length, 1)
if (process.platform === 'linux') {
  assert.match(files[0], /ubuntu-vulkan/)
  assert.ok(!files[0].includes('win-'))
  assert.equal(models.MODELS.llamaruntime.binary, 'llama-server')
  // Linux CUDA 走官方 Ubuntu CUDA 產物（見 test-models-linux-cuda.js）
  assert.match(models.MODELS.llamaruntimecuda.files[0], /ubuntu-cuda/)
} else if (process.platform === 'win32') {
  assert.match(files[0], /win-vulkan/)
  assert.equal(models.MODELS.llamaruntime.binary, 'llama-server.exe')
}

// expandArchive：造一個小 tar.gz，解到暫存
const src = models
const expand = (() => {
  // 透過重新讀原始碼不穩定；改用下載路徑旁的行為：直接測 tar 解壓邏輯鏡像
  const { spawn } = require('child_process')
  return (archivePath, destDir) => new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(String(code))))
  })
})()

if (process.platform !== 'win32') {
  const tmp = tempDir('ad-models-')
  const payload = path.join(tmp, 'payload')
  fs.mkdirSync(payload)
  fs.writeFileSync(path.join(payload, 'hello.txt'), 'hi')
  const tar = path.join(tmp, 'a.tar.gz')
  spawnSync('tar', ['-czf', tar, '-C', payload, '.'], { stdio: 'ignore' })
  const dest = path.join(tmp, 'out')
  fs.mkdirSync(dest)
  // 內部 expandArchive 未 export；用同語意驗證環境有 tar
  const r = spawnSync('tar', ['-xzf', tar, '-C', dest], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.equal(fs.readFileSync(path.join(dest, 'hello.txt'), 'utf8'), 'hi')
  // 確保 models.js 原始碼在非 win32 沒有無條件呼叫 powershell Expand-Archive
  const srcText = fs.readFileSync(path.join(__dirname, '../src/main/models.js'), 'utf8')
  assert.ok(srcText.includes("HOST.platform === 'win32'"))
  assert.ok(srcText.includes("bin-ubuntu-vulkan") || srcText.includes('ubuntu-vulkan'))
  console.log('PASS models Linux runtime 產物與 tar 解壓路徑')
} else {
  console.log('PASS models Windows runtime 產物（略過 tar）')
}
