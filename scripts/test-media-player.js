'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

async function main() {
  const registration = fs.readFileSync(path.join(__dirname, '../native/axondeck-probe/src/bin/axondeck-media/registration.rs'), 'utf8')
  assert.match(registration, /const PROGID_PREFIX: &str = "VoiceInk\.Media\.";/, '改名後必須保留 Windows 已雜湊的 ProgID')
  const calls = []
  const associationLaunches = []
  const storedFiles = new Map()
  const resourcesPath = path.resolve('C:/installed/AxonDeck/resources')
  const userDataPath = path.resolve('C:/users/test/AppData/Roaming/axondeck')
  const updateManifest = path.join(resourcesPath, 'app-update.yml')
  const initMarker = path.join(userDataPath, 'media-associations-initialized')
  const initExitCodes = [1, 0, 0]
  let hasUpdateManifest = true
  let markerReadFileCalls = 0
  const markerReads = []
  const context = { Buffer, module: { exports: {} }, __dirname: path.join(__dirname, '../src/main'), process: { env: {} },
    require: (name) => {
      if (name === 'path') return path
      if (name === './native-probe') return { resolveProbeExe: ({ resourcesPath: root } = {}) => path.join(root || path.resolve('C:/workspace/resources'), 'media', 'axondeck-media.exe') }
      if (name === './media-formats.json') return require('../src/main/media-formats.json')
      if (name === './raw-fs') return { promises: {
        stat: async (file) => ({ isFile: () => !file.endsWith('missing.png') }),
        access: async (file) => {
          if (file === updateManifest && !hasUpdateManifest) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        },
        mkdir: async () => {},
        readFile: async (file) => {
          markerReadFileCalls++
          if (!storedFiles.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
          return storedFiles.get(file)
        },
        open: async (file) => {
          if (!storedFiles.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
          return {
            read: async (buffer, offset, length) => {
              markerReads.push(length)
              const bytes = Buffer.from(storedFiles.get(file))
              bytes.copy(buffer, offset, 0, length)
              return { bytesRead: Math.min(bytes.length, length) }
            },
            close: async () => {}
          }
        },
        writeFile: async (file, value) => { storedFiles.set(file, String(value)) }
      } }
      if (name === 'electron') return { shell: { openPath: async (file) => { calls.push({ system: file }); return '' } } }
      if (name === 'child_process') return { spawn: (exe, args, options) => {
        calls.push({ exe, args, options }); const child = new EventEmitter(); child.unref = () => {}
        if (args[0] === '--initialize') associationLaunches.push({ exe, args, options })
        queueMicrotask(() => {
          child.emit('spawn')
          if (args[0] === '--initialize') queueMicrotask(() => child.emit('close', initExitCodes.shift(), null))
        })
        return child
      } }
      throw new Error(name)
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/media-player.js'), 'utf8'), context)
  const api = context.module.exports
  for (const [ext, kind] of [['WEBP','image'],['heic','image'],['jxl','image'],['cr3','image'],['mkv','video'],['flac','audio']]) {
    assert.equal(api.mediaKind(`C:/test.${ext}`), kind)
  }
  api.setThemeGetter(() => 'light')
  const file = path.resolve('中文 $音樂 & 圖片.webp')
  assert.equal(await api.openMedia(file), true)
  const launch = calls[0]
  assert.equal(launch.args.at(-1), file)
  assert.equal(launch.args[0], '--theme=light')
  assert.equal(launch.options.shell, false)
  assert.equal(launch.options.detached, true)
  assert.equal(launch.options.windowsHide, false, '正常開啟不可隱藏播放器視窗')
  assert.equal(launch.options.stdio, 'ignore')
  assert.ok(launch.exe.endsWith(path.join('resources', 'media', 'axondeck-media.exe')))
  await api.openMedia(file, { hidden: true })
  assert.equal(calls.at(-1).options.windowsHide, true)
  assert.ok(calls.at(-1).args.includes('--hidden'))
  context.process.env.AXONDECK_MEDIA_HIDDEN = '1'
  await api.openMedia(file)
  assert.equal(calls.at(-1).options.windowsHide, true)
  assert.ok(calls.at(-1).args.includes('--hidden'))
  delete context.process.env.AXONDECK_MEDIA_HIDDEN
  await assert.rejects(api.openMedia('relative.png'), (error) => error.code === 'MEDIA_OPEN_FAILED')
  await assert.rejects(api.openMedia(path.resolve('missing.png')), (error) => error.code === 'MEDIA_OPEN_FAILED')
  await assert.rejects(api.openMedia('https://example.com/image.png'), (error) => error.code === 'MEDIA_OPEN_FAILED')
  assert.equal(await api.openPath(path.resolve('doc.txt')), '')
  assert.equal(calls.at(-1).system, path.resolve('doc.txt'))
  for (const caller of ['explorer/index.js', 'explorer/mtp.js', 'workspace/index.js']) {
    assert.match(fs.readFileSync(path.join(__dirname, '../src/main', caller), 'utf8'), /mediaPlayer\.openPath\(/)
  }
  const initOptions = { isPackaged: true, isPreview: false, resourcesPath, userDataPath }
  assert.equal(await api.initializeAssociations({ ...initOptions, isPackaged: false }), false, 'dev 不執行')
  assert.equal(await api.initializeAssociations({ ...initOptions, isPreview: true }), false, 'preview 不執行')
  hasUpdateManifest = false
  assert.equal(await api.initializeAssociations(initOptions), false, '缺少安裝版更新清單的預覽包不執行')
  hasUpdateManifest = true
  assert.equal(associationLaunches.length, 0)
  await assert.rejects(api.initializeAssociations(initOptions), '失敗初始化不應寫成功標記')
  assert.equal(storedFiles.has(initMarker), false, '初始化失敗要能重試')
  assert.equal(await api.initializeAssociations(initOptions), true)
  assert.equal(await api.initializeAssociations(initOptions), true)
  assert.equal(associationLaunches.length, 2, '已成功的 installed 初始化只背景執行一次')
  assert.equal(Array.from(associationLaunches[1].args).join(' '), '--initialize')
  assert.equal(associationLaunches[1].options.detached, true)
  assert.equal(associationLaunches[1].options.windowsHide, true)
  assert.equal(associationLaunches[1].options.stdio, 'ignore')
  assert.equal(associationLaunches[1].options.shell, false)
  const nextLaunch = { ...context, module: { exports: {} } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/media-player.js'), 'utf8'), nextLaunch)
  assert.equal(await nextLaunch.module.exports.initializeAssociations(initOptions), true)
  assert.equal(associationLaunches.length, 2, '下次啟動讀到成功標記後不再 spawn')
  assert.equal(markerReadFileCalls, 0, '初始化標記不得無上限讀取')
  assert.ok(markerReads.length > 0 && markerReads.every((size) => size <= 16))
  storedFiles.set(initMarker, '1')
  const upgraded = { ...context, module: { exports: {} } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/media-player.js'), 'utf8'), upgraded)
  assert.equal(await upgraded.module.exports.initializeAssociations(initOptions), true)
  assert.equal(associationLaunches.length, 3, '舊成功標記也要執行改名搬移；Rust 初始化狀態仍保護使用者選擇')
  assert.equal(storedFiles.get(initMarker), '2')
  console.log('media-player：格式、路徑、獨立程序、開啟入口、初始化重試與背景 once PASS')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
