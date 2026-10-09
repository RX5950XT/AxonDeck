/**
 * `npm run electron:pack`：更新免安裝預覽 `dist/win-unpacked`，**專案外不留任何東西**。
 *
 * 為什麼不直接打進 `dist/`（見 CLAUDE.md「打包／建置」）：`app.asar` 被別的程式抓著時，
 * electron-builder 產出的 asar 會安靜錯位（exit 0、整頁 SyntaxError），打到 `D:\Workspace` 之外才乾淨。
 * 所以流程是：
 *   1. 打到磁碟根目錄的 `vi-build-<時間>`
 *   2. 逐檔比對 asar 裡的 `src/` 與原始碼（打包途中改到檔案、或 asar 錯位都會在這裡擋下）
 *   3. robocopy 同步進 `dist/win-unpacked`；asar 就地覆寫（抓著它的程式擋刪除但不擋寫入），exe 一定要一起換
 *   4. 不管成功失敗，刪掉步驟 1 的資料夾
 *
 * 其餘參數原樣轉給 electron-builder（例如 `npm run electron:pack -- --config.npmRebuild=false`）。
 * `--release`（electron:build）走完整 NSIS 建置，另外驗證／同步正式安裝檔與兩份更新設定。
 */
const fs = require('fs')
const path = require('path')
const { removeTree, tempDir } = require('./lib/test-temp')
const crypto = require('crypto')
const { spawnSync } = require('child_process')
const asar = require('@electron/asar')

const ROOT = path.join(__dirname, '..')
const PREVIEW = path.join(ROOT, 'dist', 'win-unpacked')
const OUT = path.join(path.parse(ROOT).root, `vi-build-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`)

// vite／electron-builder 自己的暫存也收進來：@electron/get 每次取 Electron 都在 %TEMP% 留一個空的
// `electron-download-*`（實測累積 183 個），指到這裡就跟著 test-temp.js 在結束時一起刪
const BUILD_TMP = tempDir('pack-tmp-')

function run(command, args) {
  const env = { ...process.env, TEMP: BUILD_TMP, TMP: BUILD_TMP }
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: true, windowsHide: true, env })
  if (result.status !== 0) throw new Error(`${command} ${args[0] || ''} 失敗（exit ${result.status}）`)
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** asar 裡每一支 src/ 檔案都要跟原始碼逐位元組相同 @returns {number} 比對了幾支 */
function verifyAsar(archive) {
  const entries = asar.listPackage(archive, { isPack: false })
    .map((entry) => entry.replace(/^[\\/]/, ''))
    .filter((entry) => /^src[\\/]/.test(entry))
  let checked = 0
  for (const entry of entries) {
    const source = path.join(ROOT, entry)
    if (!fs.existsSync(source) || fs.statSync(source).isDirectory()) continue
    const packed = asar.extractFile(archive, entry)
    if (sha(packed) !== sha(fs.readFileSync(source))) throw new Error(`asar 內容跟原始碼對不上：${entry}（打包途中改過檔案，或 asar 錯位）`)
    checked += 1
  }
  if (checked < 50) throw new Error(`asar 裡只比對到 ${checked} 支 src 檔案，產物不完整`)
  return checked
}

/** 就地覆寫：抓著 app.asar 的程式擋得住刪除，擋不住寫入 */
function overwriteInPlace(from, to) {
  const data = fs.readFileSync(from)
  if (!fs.existsSync(to)) {
    fs.writeFileSync(to, data)
    return
  }
  const fd = fs.openSync(to, 'r+')
  try {
    fs.writeSync(fd, data, 0, data.length, 0)
    fs.ftruncateSync(fd, data.length)
  } finally {
    fs.closeSync(fd)
  }
}

function syncPreview(built) {
  fs.mkdirSync(PREVIEW, { recursive: true })
  // robocopy：0–7 是成功（有沒有複製到東西），8 以上才是失敗
  // 預覽資料可能就在輸出底下，且 models 是 junction；MIR 不得清掉它或連結對面的真資料。
  const copy = spawnSync('robocopy', [built, PREVIEW, '/MIR', '/XJ', '/XD', path.join(PREVIEW, 'user-data'), '/XF', 'app.asar', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'inherit', windowsHide: true })
  if (copy.status === null || copy.status >= 8) throw new Error(`同步 dist/win-unpacked 失敗（robocopy exit ${copy.status}）；預覽版還開著的話先關掉`)
  const from = path.join(built, 'resources', 'app.asar')
  const to = path.join(PREVIEW, 'resources', 'app.asar')
  overwriteInPlace(from, to)
  if (sha(fs.readFileSync(from)) !== sha(fs.readFileSync(to))) throw new Error('dist/win-unpacked 的 app.asar 覆寫後內容不一致')
}

/** 正式安裝包必須包含更新來源，且 latest.yml 的大小與雜湊要對得上實際安裝檔。 */
function verifyRelease(built, outputDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const load = require('js-yaml').load
  const config = load(fs.readFileSync(path.join(built, 'resources', 'app-update.yml'), 'utf8'))
  const publish = pkg.build.publish[0]
  if (!['provider', 'owner', 'repo'].every((key) => config?.[key] === publish[key]) ||
      config?.updaterCacheDirName !== `${pkg.name}-updater`) throw new Error('app-update.yml 的更新來源不正確')
  const packed = JSON.parse(asar.extractFile(path.join(built, 'resources', 'app.asar'), 'package.json'))
  if (packed.version !== pkg.version) throw new Error('安裝包版本與 package.json 不同')
  const name = `${pkg.build.productName}-Setup-${pkg.version}.exe`
  const installer = path.join(outputDir, name)
  const info = load(fs.readFileSync(path.join(outputDir, 'latest.yml'), 'utf8'))
  const record = info?.files?.find((file) => file.url === name)
  const size = fs.statSync(installer).size
  const hash = crypto.createHash('sha512').update(fs.readFileSync(installer)).digest('base64')
  if (info?.version !== pkg.version || info?.path !== name || info?.sha512 !== hash ||
      record?.sha512 !== hash || record?.size !== size) throw new Error('latest.yml 與正式安裝檔不符')
  if (!fs.statSync(`${installer}.blockmap`).size) throw new Error('安裝檔 blockmap 是空的')
  return [name, `${name}.blockmap`, 'latest.yml']
}

function main() {
  const release = process.argv.includes('--release')
  const extra = process.argv.slice(2).filter((arg) => arg !== '--release' && !arg.startsWith('--config.directories.output'))
  let exitCode = 0
  try {
    if (release && extra.some((arg) => arg.startsWith('--prepackaged'))) throw new Error('正式建置不可使用 --prepackaged，會跳過更新設定的產生')
    run('npx', ['vite', 'build'])
    run('npx', ['electron-builder', '--win', release ? 'nsis' : 'dir', '--publish', 'never', `--config.directories.output=${OUT}`, ...extra])
    const built = path.join(OUT, 'win-unpacked')
    const checked = verifyAsar(path.join(built, 'resources', 'app.asar'))
    const artifacts = release ? verifyRelease(built, OUT) : []
    console.log(`\n[pack-preview] asar 驗證通過（${checked} 支 src 檔案與原始碼相同）`)
    syncPreview(built)
    for (const file of artifacts) fs.copyFileSync(path.join(OUT, file), path.join(ROOT, 'dist', file))
    if (release) console.log('[pack-preview] 正式安裝檔、app-update.yml、latest.yml 驗證通過並已同步')
    console.log(`[pack-preview] 已更新 ${path.relative(ROOT, PREVIEW)}`)
  } catch (error) {
    console.error(`\n[pack-preview] ${error.message}`)
    exitCode = 1
  } finally {
    try {
      removeTree(OUT)
    } catch {
      console.error(`[pack-preview] 暫存輸出刪不掉（被占用），請之後手動刪：${OUT}`)
      exitCode = exitCode || 1
    }
  }
  process.exit(exitCode)
}

if (require.main === module) main()

module.exports = { verifyAsar, verifyRelease }
