#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tempDir, removeTree } = require('./lib/test-temp')
const cuda = require('../src/main/cuda-env')

const dir = tempDir('linux-cuda-env-')

;(async () => {
  try {
    const files = new Set()
    const exists = (p) => files.has(p) || fs.existsSync(p)
    const env = { PATH: path.join(dir, 'bin'), HOME: path.join(dir, 'home'), CUDA_PATH: path.join(dir, 'cuda') }
    fs.mkdirSync(env.PATH, { recursive: true })
    fs.mkdirSync(env.HOME, { recursive: true })
    fs.mkdirSync(path.join(dir, 'cuda', 'lib64'), { recursive: true })

    let detected = cuda.detectLinuxCudaRuntime({ env, exists, homedir: env.HOME })
    assert.equal(detected.hasNvidiaDriver, false)
    assert.equal(detected.hasCudaRuntime, false)

    const smi = path.join(env.PATH, 'nvidia-smi')
    files.add(smi)
    detected = cuda.detectLinuxCudaRuntime({ env, exists, homedir: env.HOME })
    assert.equal(detected.hasNvidiaDriver, true)
    assert.equal(detected.hasCudaRuntime, false)
    assert.equal(detected.details.nvidiaSmi, smi)

    for (const name of ['libcudart.so.13', 'libcublas.so.13', 'libcublasLt.so.13']) {
      files.add(path.join(dir, 'cuda', 'lib64', name))
    }
    const nvcc = path.join(dir, 'cuda', 'bin', 'nvcc')
    files.add(nvcc)
    detected = cuda.detectLinuxCudaRuntime({ env, exists, homedir: env.HOME })
    assert.equal(detected.hasCudaRuntime, true)
    assert.equal(detected.details.nvcc, nvcc)
    assert.match(String(detected.details.cudart), /libcudart\.so\.13/)

    assert.equal(cuda.detectLinuxVulkan({
      env,
      exists: (p) => String(p).endsWith('libvulkan.so.1') || exists(p),
      homedir: env.HOME
    }), true)

    const hasCommand = (name) => name === 'apt-get' || name === 'pkexec'
    assert.equal(cuda.detectLinuxPackageManager({ hasCommand, env, exists }), 'apt')
    assert.equal(cuda.LINUX_CUDA_PACKAGES.apt.package, 'nvidia-cuda-toolkit')
    assert.equal(cuda.LINUX_CUDA_PACKAGES.dnf.package, 'cuda')
    assert.equal(cuda.LINUX_CUDA_PACKAGES.pacman.package, 'cuda')
    assert.equal(cuda.LINUX_CUDA_PACKAGES.zypper.package, 'cuda')

    const already = await cuda.installLinuxCudaEnv(() => {}, {
      detect: () => ({ hasNvidiaDriver: true, hasCudaRuntime: true, details: {} })
    })
    assert.equal(already.ok, true)
    assert.equal(already.method, 'already')

    const noDriver = await cuda.installLinuxCudaEnv(() => {}, {
      detect: () => ({ hasNvidiaDriver: false, hasCudaRuntime: false, details: {} })
    })
    assert.equal(noDriver.ok, false)
    assert.match(noDriver.message, /NVIDIA 驅動/)

    let elevated = null
    let afterPkg = false
    const viaApt = await cuda.installLinuxCudaEnv(() => {}, {
      requireDriver: false,
      packageManager: () => 'apt',
      pkexecPath: '/usr/bin/pkexec',
      runElevated: async (file, args) => {
        elevated = { file, args }
        afterPkg = true
        return 0
      },
      detect: () => ({ hasNvidiaDriver: true, hasCudaRuntime: afterPkg, details: {} })
    })
    assert.equal(viaApt.ok, true)
    assert.equal(viaApt.method, 'apt')
    assert.equal(elevated.file, 'apt-get')
    assert.ok(elevated.args.includes('nvidia-cuda-toolkit'))

    const runfileDest = path.join(dir, 'cache', 'cuda_13.3.1_linux.run')
    const toolkit = path.join(dir, 'home', '.local', 'cuda')
    let runArgs = null
    let downloaded = false
    const viaRunfile = await cuda.installLinuxCudaEnv(() => {}, {
      requireDriver: false,
      packageManager: () => '',
      installerCachePath: runfileDest,
      toolkitPath: toolkit,
      mkdir: async (d) => fs.mkdirSync(d, { recursive: true }),
      exists: (p) => (p === runfileDest ? downloaded : exists(p)),
      downloadFile: async ({ url, dest }) => {
        assert.equal(url, cuda.LINUX_CUDA_INSTALLER.url)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, 'runfile')
        downloaded = true
      },
      runFile: async (file, args) => {
        runArgs = { file, args }
        return 0
      },
      detect: () => ({ hasNvidiaDriver: true, hasCudaRuntime: false, details: {} }),
      assumeRunfileSuccess: true
    })
    assert.equal(viaRunfile.ok, true)
    assert.equal(viaRunfile.method, 'runfile')
    assert.equal(runArgs.file, runfileDest)
    assert.ok(runArgs.args.some((a) => String(a).startsWith('--installpath=')))
    assert.ok(runArgs.args.includes('--silent'))
    assert.ok(runArgs.args.includes('--toolkit'))

    const source = fs.readFileSync(path.join(__dirname, '../src/main/gpu-capability.js'), 'utf8')
    assert.match(source, /process\.platform === 'linux'/)
    assert.match(source, /canInstallCuda/)
    console.log('PASS Linux CUDA 偵測 nvidia-smi／nvcc／函式庫；apt／runfile 安裝路徑（不真的安裝）')
  } finally {
    removeTree(dir)
  }
})().catch((err) => {
  removeTree(dir)
  console.error(err)
  process.exit(1)
})
