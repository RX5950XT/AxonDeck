'use strict'

/**
 * 真的下載（Linux）：用 models.js 的 download() 把 Local SI 的 Vulkan 與 CUDA 執行環境裝進暫存 userData，
 * 驗證「下載 → 解壓（剝外層資料夾）→ isDownloaded → llama-server 跑得起來 → cudart 從同層載得到」。
 * 會下載約 590 MB；結束後暫存整個刪掉。沒有 NVIDIA 驅動時 CUDA 後端載不起來是預期（libcuda.so.1 來自驅動）。
 *
 * 用法：npx electron scripts/probe-local-si-cuda-linux.js [llamaruntime] [llamaruntimecuda]
 */

const { app } = require('electron')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { tempDir } = require('./lib/test-temp')

app.setPath('userData', tempDir('probe-cuda-ud-'))

async function main() {
  const models = require('../src/main/models')
  const hardware = require('../src/main/hfmodels/hardware')
  const keys = process.argv.slice(2).filter((a) => /^llamaruntime/.test(a))
  let failed = 0
  for (const key of keys.length ? keys : ['llamaruntime', 'llamaruntimecuda']) {
    const def = models.MODELS[key]
    if (!def) { console.log(`SKIP ${key}：這個平台沒有`); continue }
    const started = Date.now()
    let last = 0
    try {
      await models.download(key, (p) => { last = p.receivedBytes })
    } catch (error) {
      failed++
      console.log(`FAIL ${key} 下載／解壓：${error.message}`)
      continue
    }
    const exe = models.filePath(key, 'binary')
    const ok = models.isDownloaded(key)
    const version = spawnSync(exe, ['--version'], { encoding: 'utf8' })
    const line = `${version.stdout}${version.stderr}`.split('\n').find((l) => l.startsWith('version:')) || ''
    const good = ok && version.status === 0 && line
    if (!good) failed++
    console.log(`${good ? 'PASS' : 'FAIL'} ${key}：${(last / 1e6).toFixed(0)} MB、${((Date.now() - started) / 1000).toFixed(0)}s、isDownloaded=${ok}、${line.trim()}`)
    if (key === 'llamaruntimecuda') {
      const ldd = spawnSync('ldd', [path.join(path.dirname(exe), 'libggml-cuda.so')], { encoding: 'utf8' }).stdout || ''
      const local = ['libcudart.so.13', 'libcublas.so.13', 'libcublasLt.so.13'].every((lib) => new RegExp(`${lib.replace(/\./g, '\\.')} => ${path.dirname(exe).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`).test(ldd))
      if (!local) failed++
      console.log(`${local ? 'PASS' : 'FAIL'} cudart／cublas 由 $ORIGIN（同層）解析；libcuda.so.1：${/libcuda\.so\.1 => not found/.test(ldd) ? '找不到（這台沒有 NVIDIA 驅動，預期）' : '有'}`)
    }
    const devices = await hardware.listDevices(exe)
    console.log(`      --list-devices：${devices.length ? devices.map((d) => `${d.id} ${d.name}`).join('、') : '（沒有 GPU 裝置）'}`)
  }
  const nvidia = await hardware.nvidiaDriver()
  console.log(`      nvidiaDriver：${JSON.stringify(nvidia)}`)
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
