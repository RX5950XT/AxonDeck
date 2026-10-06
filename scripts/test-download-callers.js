'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createHash } = require('node:crypto')
const { tempDir, removeTree } = require('./lib/test-temp')

async function main() {
  const root = tempDir('download-callers-')
  try {
    let failDownload = true
    const context = { module: { exports: {} }, AbortController, Date, setTimeout,
      fetch: async () => { throw new Error('中斷') },
      require: (name) => {
        if (name === 'electron') return { app: { getPath: () => root } }
        if (name === './safe-rm') return require('../src/main/safe-rm')
        if (name === './hfmodels/download') return { downloadFile: async (options) => {
          if (failDownload) throw new Error('中斷')
          const bytes = options.dest.endsWith('first') ? 3 : 4
          options.onProgress({ received: 1, total: bytes })
          options.onProgress({ received: bytes, total: bytes })
          fs.writeFileSync(options.dest, Buffer.alloc(bytes))
          return { bytes }
        } }
        return require(name)
      } }
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/models.js'), 'utf8'), context)
    const models = context.module.exports
    models.MODELS.test = { files: ['first', 'second'], base: 'https://example.test/', totalBytes: 7 }
    const dir = models.modelDir('test')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'first.part'), 'a')
    await assert.rejects(models.download('test', () => {}), /中斷/)
    assert.equal(fs.readFileSync(path.join(dir, 'first.part'), 'utf8'), 'a', '中斷留下續傳檔')
    failDownload = false
    const progress = []
    await models.download('test', info => progress.push(info.receivedBytes))
    assert.equal(progress.at(-1), 7, '累計進度不可重複加上同一檔案的已收位元組')
    assert.ok(progress.every(value => value <= 7))

    const source = fs.readFileSync(path.join(__dirname, '../src/main/explorer/uffs.js'), 'utf8')
    const start = source.indexOf('async function download(onProgress)')
    const end = source.indexOf('\n/**', source.indexOf('function cancelDownload()', start))
    const zipPath = path.join(root, 'uffs.zip')
    const zip = Buffer.from('archive')
    const expected = createHash('sha256').update(zip).digest('hex')
    let expectedHash = expected
    let pending = false
    let verified = false
    let cancelled = false
    const uffsContext = { fs, path, AbortController, downloadCtl: null,
      ZIP_NAME: 'uffs.zip', ZIP_URL: 'https://example.test/archive', SUMS_URL: 'https://example.test/CHECKSUMS.txt',
      MAX_ZIP_BYTES: 64 * 1024 * 1024, installDir: () => root,
      fail: (code, message) => Object.assign(new Error(message), { code }),
      downloadFile: async options => {
        assert.equal(options.dest, zipPath)
        assert.equal(options.maxBytes, 64 * 1024 * 1024)
        if (pending) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
          cancelled = true
          reject(new Error('cancelled'))
        }, { once: true }))
        fs.writeFileSync(options.dest, zip)
      },
      fetch: async (url) => {
        assert.equal(url, uffsContext.SUMS_URL, 'checksum 只從官方取得')
        return { ok: true, text: async () => expectedHash }
      },
      verifyZipHash: (file, hash) => {
        assert.equal(file, zipPath)
        if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== hash) {
          throw Object.assign(new Error('hash mismatch'), { code: 'UFFS_INSTALL' })
        }
        verified = true
      },
      unzip: async () => { assert.equal(verified, true, '先驗 hash 才解壓') },
      findExeIn: () => path.join(root, 'uffs.exe'), realOf: file => file, status: () => ({ installed: true }) }
    vm.createContext(uffsContext)
    vm.runInContext(source.slice(start, end), uffsContext)
    await uffsContext.download()
    assert.equal(fs.existsSync(zipPath), false)
    expectedHash = 'wrong'
    verified = false
    await assert.rejects(uffsContext.download(), /hash mismatch/)
    assert.equal(fs.existsSync(zipPath), false, '壞 ZIP 要清掉')
    pending = true
    const downloading = uffsContext.download()
    await assert.rejects(uffsContext.download(), /進行中/)
    uffsContext.cancelDownload()
    await assert.rejects(downloading)
    assert.equal(cancelled, true)
    assert.equal(uffsContext.downloadCtl, null)

    const cuda = fs.readFileSync(path.join(__dirname, '../src/main/cuda-env.js'), 'utf8')
    const cudaStart = cuda.indexOf('async function downloadInstaller(')
    const cudaContext = { fs, fsp: fs.promises, path, Date,
      CUDA_INSTALLER: { url: 'https://developer.download.nvidia.com/test.exe' },
      installerCachePath: () => path.join(root, 'cuda.exe'),
      downloadFile: async ({ url, dest, onProgress }) => {
        assert.equal(url, cudaContext.CUDA_INSTALLER.url)
        onProgress({ received: 20, total: 40 })
        fs.writeFileSync(dest, 'installer')
      } }
    vm.createContext(cudaContext)
    vm.runInContext(cuda.slice(cudaStart, cuda.indexOf('\n}', cudaStart) + 2), cudaContext)
    const cudaProgress = []
    assert.equal(await cudaContext.downloadInstaller(info => cudaProgress.push(info.percent)), path.join(root, 'cuda.exe'))
    assert.deepEqual(cudaProgress, [0, 50, 100])

    const media = fs.readFileSync(path.join(__dirname, 'build-media.js'), 'utf8')
    const mediaStart = media.indexOf("      const archive = path.join(tmp, 'runtime.7z')")
    const mediaEnd = media.indexOf("      run(sevenZip,", mediaStart)
    const mediaContext = { fs, path, createHash, AbortSignal, tmp: root, name: 'mpv',
      item: { url: 'https://example.test/runtime.7z', sha256: expected },
      downloadFile: async ({ url, dest, signal }) => {
        assert.equal(url, mediaContext.item.url)
        assert.equal(signal.aborted, false)
        fs.writeFileSync(dest, zip)
      } }
    vm.createContext(mediaContext)
    const verifyMedia = () => vm.runInContext(`(async () => { ${media.slice(mediaStart, mediaEnd)} })()`, mediaContext)
    await verifyMedia()
    mediaContext.item.sha256 = 'wrong'
    await assert.rejects(verifyMedia(), /SHA-256 不符/)
    console.log('PASS: 模型續傳與累計進度；UFFS 上限、官方 hash、壞檔清理與取消互斥；CUDA 進度；媒體流式 hash')
  } finally { removeTree(root) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
