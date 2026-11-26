'use strict'

/**
 * Linux 發行產物的檔名與檢查（release-linux.js、check-linux-artifacts.js、workflow 共用）。
 *
 * electron-builder 對同一個 `${arch}` 在不同格式給的名字不一樣（實測 26.x）：
 *   x64：AppImage → x86_64、deb → amd64、rpm → x86_64
 *   arm64：AppImage → arm64、deb → arm64、rpm → aarch64
 * 更新清單：x64 是 `latest-linux.yml`，arm64 是 `latest-linux-arm64.yml`（electron-updater 依執行架構挑）。
 */

const fs = require('fs')
const path = require('path')

const ARCHES = Object.freeze(['x64', 'arm64'])
const ELF_MACHINE = Object.freeze({ x64: 0x3e, arm64: 0xb7 })

function assertArch(arch) {
  if (!ARCHES.includes(arch)) throw new Error(`不支援的架構：${arch}（只有 x64、arm64）`)
}

/** @param {string} version @param {'x64'|'arm64'} arch */
function packageNames(version, arch) {
  assertArch(arch)
  const x64 = arch === 'x64'
  return {
    appImage: `AxonDeck-${version}-linux-${x64 ? 'x86_64' : 'arm64'}.AppImage`,
    deb: `AxonDeck-${version}-linux-${x64 ? 'amd64' : 'arm64'}.deb`,
    rpm: `AxonDeck-${version}-linux-${x64 ? 'x86_64' : 'aarch64'}.rpm`,
    manifest: x64 ? 'latest-linux.yml' : 'latest-linux-arm64.yml'
  }
}

/** dpkg／rpm 的架構字串 */
function packageArch(arch) {
  assertArch(arch)
  return arch === 'x64' ? { deb: 'amd64', rpm: 'x86_64' } : { deb: 'arm64', rpm: 'aarch64' }
}

/** electron-builder 的 unpacked 資料夾 */
function unpackedDir(distDir, arch) {
  assertArch(arch)
  return path.join(distDir, arch === 'x64' ? 'linux-unpacked' : 'linux-arm64-unpacked')
}

/** 簽章產物（有 LINUX_SIGNING_KEY 才會有） */
function signatureNames(version, arch) {
  const names = packageNames(version, arch)
  return {
    detached: [names.appImage, names.deb, names.rpm].map((n) => `${n}.asc`),
    sums: `SHA256SUMS-linux-${arch}.txt`,
    sumsSig: `SHA256SUMS-linux-${arch}.txt.asc`,
    publicKey: 'AxonDeck-linux-signing-key.asc'
  }
}

/**
 * 要上傳到 Release 的檔案：三個套件＋更新清單；有簽章就連 .asc／SHA256SUMS／公鑰一起。
 * @param {string} version @param {'x64'|'arm64'} arch @param {string} distDir
 */
function uploadList(version, arch, distDir) {
  const names = packageNames(version, arch)
  const list = [names.appImage, names.deb, names.rpm, names.manifest].map((n) => path.join(distDir, n))
  const sig = signatureNames(version, arch)
  const extra = [...sig.detached, sig.sums, sig.sumsSig, sig.publicKey].map((n) => path.join(distDir, n))
  return list.concat(extra.filter((file) => fs.existsSync(file)))
}

/**
 * ELF 的 e_machine（0x3e＝x86-64、0xb7＝AArch64）；不是 ELF 回 -1。
 * @param {Buffer} head 至少前 20 bytes
 */
function elfMachine(head) {
  if (!head || head.length < 20 || head.readUInt32BE(0) !== 0x7f454c46) return -1
  const little = head[5] === 1
  return little ? head.readUInt16LE(18) : head.readUInt16BE(18)
}

function readHead(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(20)
    fs.readSync(fd, head, 0, 20, 0)
    return head
  } finally {
    fs.closeSync(fd)
  }
}

/** 這個 .node 的路徑寫明是別的平台／架構用的（uiohook 的 prebuilds、@scope/pkg-linux-x64 這種），不檢查 */
function labeledForOther(rel, arch) {
  const other = arch === 'x64' ? ['arm64', 'aarch64', 'armv7l', 'arm', 'loong64', 'ia32'] : ['x64', 'x86_64', 'armv7l', 'loong64', 'ia32']
  const parts = rel.split(/[\\/]/)
  return parts.some((part) => /(^|-)(darwin|win32|win)(-|$)/.test(part) || other.some((a) => new RegExp(`(^|[-_.])${a}([-_.]|$)`).test(part)))
}

/**
 * 掃 unpacked 資料夾：主程式與 asar.unpacked 裡每個 ELF `.node` 都要是目標架構；必要的原生模組要在。
 * @param {string} dir unpacked 資料夾
 * @param {'x64'|'arm64'} arch
 * @returns {{ errors: string[], warnings: string[], checked: string[] }}
 */
function checkNativeArch(dir, arch) {
  assertArch(arch)
  const want = ELF_MACHINE[arch]
  const errors = []
  const warnings = []
  const checked = []
  const exe = path.join(dir, 'axondeck')
  if (!fs.existsSync(exe)) errors.push(`缺主程式 ${exe}`)
  else if (elfMachine(readHead(exe)) !== want) errors.push(`主程式架構不對：${exe}`)
  else checked.push('axondeck')

  const unpacked = path.join(dir, 'resources', 'app.asar.unpacked', 'node_modules')
  const tag = arch === 'x64' ? 'x64' : 'arm64'
  const required = [
    `@lydell/node-pty-linux-${tag}/prebuilds/linux-${tag}/pty.node`,
    `sherpa-onnx-linux-${tag}/sherpa-onnx.node`,
    // uiohook-napi 1.5.5 附的 prebuilds/linux-arm64 其實是 x86-64（上游打包錯誤），
    // 一定要有 @electron/rebuild 在原生架構上編出來的 build/Release（node-gyp-build 先找它）
    'uiohook-napi/build/Release/uiohook_napi.node',
    `@reflink/reflink-linux-${tag}-gnu/reflink.linux-${tag}-gnu.node`
  ]
  for (const rel of required) {
    const file = path.join(unpacked, rel)
    if (!fs.existsSync(file)) errors.push(`缺原生模組 ${rel}`)
  }
  const walk = (cur) => {
    let entries = []
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(cur, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.node')) {
        const rel = path.relative(unpacked, full)
        if (labeledForOther(rel, arch)) continue
        const machine = elfMachine(readHead(full))
        if (machine === -1) continue
        const bad = `原生模組架構不對（e_machine=0x${machine.toString(16)}）：${rel}`
        // prebuilds/ 只是 node-gyp-build 找不到 build/Release 時的退路；錯的記警告，build/Release 由 required 把關
        if (machine !== want) (rel.split(/[\\/]/).includes('prebuilds') ? warnings : errors).push(bad)
        else checked.push(rel)
      }
    }
  }
  walk(unpacked)
  return { errors, warnings, checked }
}

/**
 * app.asar 有沒有打壞：package.json 讀得出來且版號對、main 進入點在，裡面每個 .json 都 parse 得過。
 * （打包途中有檔案被改——例如 README、scripts 被編輯——asar header 的大小跟寫進去的內容對不上，
 * 後面每個檔都錯位，打開就 exit 1、什麼都不印；實際踩過）
 * @param {string} dir unpacked 資料夾 @param {string} version
 * @returns {{ errors: string[], files: number }}
 */
function checkAsar(dir, version) {
  const errors = []
  let asar
  try {
    asar = require('@electron/asar')
  } catch {
    return { errors: ['找不到 @electron/asar（electron-builder 的相依），無法檢查 app.asar'], files: 0 }
  }
  const file = path.join(dir, 'resources', 'app.asar')
  if (!fs.existsSync(file)) return { errors: [`缺 ${file}`], files: 0 }
  let meta = null
  try {
    meta = JSON.parse(asar.extractFile(file, 'package.json').toString('utf8'))
  } catch (error) {
    return { errors: [`app.asar 的 package.json 讀不出來（asar 打壞了，重打一次）：${error.message.slice(0, 80)}`], files: 0 }
  }
  if (meta.version !== version) errors.push(`app.asar 的版號是 ${meta.version}，要 ${version}`)
  const entries = asar.listPackage(file)
  const main = `/${String(meta.main || 'index.js').replace(/^\.?\//, '')}`
  if (!entries.includes(main)) errors.push(`app.asar 裡沒有 main 進入點 ${main}`)
  let files = 0
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const rel = entry.slice(1)
    let stat
    try { stat = asar.statFile(file, rel) } catch { continue }
    if (!stat || stat.unpacked || stat.files || stat.link || !('size' in stat)) continue
    files++
    try {
      JSON.parse(asar.extractFile(file, rel).toString('utf8').replace(/^\uFEFF/, ''))
    } catch {
      errors.push(`app.asar 內容壞掉：${rel} 不是合法 JSON`)
      if (errors.length > 5) break
    }
  }
  return { errors, files }
}

/** latest-linux*.yml 裡某個檔的 sha512／size；沒列回 null */
function manifestEntry(text, file) {
  const lines = String(text).split('\n')
  const i = lines.findIndex((line) => line.trim() === `- url: ${file}`)
  if (i < 0) return null
  const entry = { sha512: '', size: NaN }
  for (let j = i + 1; j < lines.length && !/^\s*- url:/.test(lines[j]) && /^\s{4,}\S/.test(lines[j]); j++) {
    const m = /^\s+(sha512|size):\s*(\S+)/.exec(lines[j])
    if (m) entry[m[1]] = m[1] === 'size' ? Number(m[2]) : m[2]
  }
  return entry
}

/** latest-linux*.yml 裡某個檔的 sha512／size 換成新值（簽章改了 rpm 之後用） */
function patchManifest(text, file, sha512, size) {
  const lines = String(text).split('\n')
  let hit = false
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== `- url: ${file}`) continue
    hit = true
    for (let j = i + 1; j < lines.length && !/^\s*- url:/.test(lines[j]) && /^\s{4,}\S/.test(lines[j]); j++) {
      if (/^\s+sha512:/.test(lines[j])) lines[j] = lines[j].replace(/sha512:.*/, `sha512: ${sha512}`)
      else if (/^\s+size:/.test(lines[j])) lines[j] = lines[j].replace(/size:.*/, `size: ${size}`)
    }
  }
  if (!hit) throw new Error(`更新清單裡沒有 ${file}`)
  const out = lines.join('\n')
  // 頂層的 path／sha512 指的是同一個檔時也要換
  if (new RegExp(`^path: ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(out)) return out.replace(/^sha512: .*$/m, `sha512: ${sha512}`)
  return out
}

module.exports = { ARCHES, ELF_MACHINE, packageNames, packageArch, unpackedDir, signatureNames, uploadList, elfMachine, labeledForOther, checkNativeArch, checkAsar, manifestEntry, patchManifest }
