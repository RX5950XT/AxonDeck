'use strict'

/**
 * Local SI 的 Linux CUDA 執行環境（不連網）：
 * - Linux x64／arm64 的 CUDA 產物＝官方 b10988 Ubuntu CUDA 13.3 兩包、解壓剝掉外層資料夾；Vulkan 仍是 b10666 預設
 * - Windows 的 Vulkan／CUDA 產物跟原本一字不差
 * - expandArchive 的 --strip-components（官方 tar.gz 外面包一層 llama-bXXXX/）
 * - NVIDIA 驅動偵測：nvidia-smi 失敗時 Linux 讀 /proc/driver/nvidia/version
 * 真的下載與執行另見 scripts/probe-local-si-cuda-linux.js。
 *
 * 用法：node scripts/test-models-linux-cuda.js
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const { tempDir } = require('./lib/test-temp')
const hardware = require('../src/main/hfmodels/hardware')

let failed = 0
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`) } catch (error) { failed++; console.log(`FAIL ${name}: ${error.message}`) }
}

/** 用指定的 platform／arch 重新載入 models.js（HOST 在模組載入時決定） */
function loadModels(platform, arch) {
  const file = path.join(__dirname, '../src/main/models.js')
  const realRequire = createRequire(file)
  const context = { module: { exports: {} }, process: { platform, arch, env: {} }, console,
    require: (id) => id === 'electron' ? { app: { getPath: () => '/nonexistent' } } : realRequire(id) }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file })
  // vm 另一個 realm 的陣列 deepStrictEqual 會因原型不同而失敗：轉成本 realm 的普通物件
  const { MODELS, LLAMA_BUILD_LINUX_CUDA } = context.module.exports
  return { MODELS: JSON.parse(JSON.stringify(MODELS)), LLAMA_BUILD_LINUX_CUDA }
}

async function main() {
  await check('Linux x64：CUDA＝b10988 官方 Ubuntu CUDA 13.3 兩包，剝外層、RUNPATH 同層', () => {
    const m = loadModels('linux', 'x64')
    const cuda = m.MODELS.llamaruntimecuda
    assert.equal(m.LLAMA_BUILD_LINUX_CUDA, 'b10988')
    assert.equal(cuda.base, 'https://github.com/ggml-org/llama.cpp/releases/download/b10988/')
    assert.deepEqual(cuda.files, ['llama-b10988-bin-ubuntu-cuda-13.3-x64.tar.gz', 'cudart-llama-b10988-bin-ubuntu-cuda-13.3-x64.tar.gz'])
    assert.equal(cuda.binary, 'llama-server')
    assert.deepEqual(cuda.check, ['llama-server', 'libggml-cuda.so', 'libcudart.so.13'])
    assert.equal(cuda.stripComponents, 1)
    assert.equal(cuda.archive, true)
    assert.equal(cuda.totalBytes, 149_162_456 + 410_248_850)
  })
  await check('Linux arm64：CUDA 用 arm64 產物', () => {
    const cuda = loadModels('linux', 'arm64').MODELS.llamaruntimecuda
    assert.deepEqual(cuda.files, ['llama-b10988-bin-ubuntu-cuda-13.3-arm64.tar.gz', 'cudart-llama-b10988-bin-ubuntu-cuda-13.3-arm64.tar.gz'])
  })
  await check('Linux Vulkan 仍是 b10666 預設，也剝外層', () => {
    const vk = loadModels('linux', 'x64').MODELS.llamaruntime
    assert.deepEqual(vk.files, ['llama-b10666-bin-ubuntu-vulkan-x64.tar.gz'])
    assert.equal(vk.stripComponents, 1)
    assert.match(vk.label, /Vulkan（b10666）/)
  })
  await check('Windows 產物不變（Vulkan＋CUDA 13.3 zip、無 stripComponents）', () => {
    const m = loadModels('win32', 'x64')
    assert.deepEqual(m.MODELS.llamaruntime.files, ['llama-b10666-bin-win-vulkan-x64.zip'])
    assert.equal(m.MODELS.llamaruntime.stripComponents, undefined)
    assert.deepEqual(m.MODELS.llamaruntimecuda.files, ['llama-b10666-bin-win-cuda-13.3-x64.zip', 'cudart-llama-bin-win-cuda-13.3-x64.zip'])
    assert.deepEqual(m.MODELS.llamaruntimecuda.check, ['llama-server.exe', 'ggml-cuda.dll'])
    assert.equal(m.MODELS.llamaruntimecuda.stripComponents, undefined)
    assert.equal(m.MODELS.llamaruntimecuda.base, 'https://github.com/ggml-org/llama.cpp/releases/download/b10666/')
  })
  await check('macOS 不提供 CUDA', () => {
    assert.equal(loadModels('darwin', 'arm64').MODELS.llamaruntimecuda, undefined)
  })

  await check('expandArchive：--strip-components 把 llama-bXXXX/ 剝掉；沒指定就照原樣', async () => {
    if (process.platform === 'win32') return
    const models = require('../src/main/models')
    const tmp = tempDir('cuda-tar-')
    fs.mkdirSync(path.join(tmp, 'src', 'llama-b1'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'src', 'llama-b1', 'llama-server'), '#!/bin/sh\n', { mode: 0o755 })
    const tar = path.join(tmp, 'a.tar.gz')
    assert.equal(spawnSync('tar', ['-czf', tar, '-C', path.join(tmp, 'src'), 'llama-b1']).status, 0)
    const flat = path.join(tmp, 'flat'); fs.mkdirSync(flat)
    await models.expandArchive(tar, flat, { stripComponents: 1 })
    assert.ok(fs.existsSync(path.join(flat, 'llama-server')))
    assert.ok(fs.statSync(path.join(flat, 'llama-server')).mode & 0o100, '執行權限保留')
    const nested = path.join(tmp, 'nested'); fs.mkdirSync(nested)
    await models.expandArchive(tar, nested)
    assert.ok(fs.existsSync(path.join(nested, 'llama-b1', 'llama-server')))
  })

  await check('NVIDIA 驅動：/proc/driver/nvidia/version 解析', () => {
    assert.equal(hardware.parseProcNvidiaVersion('NVRM version: NVIDIA UNIX x86_64 Kernel Module  580.82.07  Wed Aug 27 2026\nGCC version:  gcc 13'), '580.82.07')
    assert.equal(hardware.parseProcNvidiaVersion('NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  575.64.03  Release Build'), '575.64.03')
    assert.equal(hardware.parseProcNvidiaVersion(''), '')
  })
  await check('NVIDIA 驅動：nvidia-smi 失敗 → Linux 退回 /proc；Windows 照舊回沒有', async () => {
    const fail = (cmd, args, opts, cb) => cb(new Error('ENOENT'))
    const proc = () => 'NVRM version: NVIDIA UNIX x86_64 Kernel Module  580.82.07  Wed Aug 27 2026'
    assert.deepEqual(await hardware.nvidiaDriver({ execFileFn: fail, platform: 'linux', readProc: proc }), { hasNvidia: true, driver: '580.82.07', cudaReady: true })
    const old = () => 'NVRM version: NVIDIA UNIX x86_64 Kernel Module  550.120  Fri Sep 13 2024'
    assert.deepEqual(await hardware.nvidiaDriver({ execFileFn: fail, platform: 'linux', readProc: old }), { hasNvidia: true, driver: '550.120', cudaReady: false })
    const none = () => { throw new Error('ENOENT') }
    assert.deepEqual(await hardware.nvidiaDriver({ execFileFn: fail, platform: 'linux', readProc: none }), { hasNvidia: false, driver: '', cudaReady: false })
    assert.deepEqual(await hardware.nvidiaDriver({ execFileFn: fail, platform: 'win32', readProc: proc }), { hasNvidia: false, driver: '', cudaReady: false })
    const smi = (cmd, args, opts, cb) => cb(null, '580.95.05\n')
    assert.deepEqual(await hardware.nvidiaDriver({ execFileFn: smi, platform: 'linux', readProc: none }), { hasNvidia: true, driver: '580.95.05', cudaReady: true })
  })

  if (failed) { console.log(`\n${failed} 項失敗`); process.exit(1) }
  console.log('\n全部通過')
}

main().catch((error) => { console.error(error); process.exit(1) })
