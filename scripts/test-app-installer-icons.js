'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { tempDir } = require('./lib/test-temp')
const { iconLocation, parseIcons, mainExe, sameIcon } = require('../src/main/app-installer/icons')

async function main() {
  assert.deepEqual(iconLocation('"C:\\Program Files\\App\\icon.dll",-42'), { file: 'C:\\Program Files\\App\\icon.dll', index: -42 })
  assert.deepEqual(iconLocation('C:\\App\\icon.dll,3'), { file: 'C:\\App\\icon.dll', index: 3 })
  const root = tempDir('installer-icons-'), nested = path.join(root, 'Launcher', 'Portal', 'Binaries')
  fs.mkdirSync(nested, { recursive: true })
  const exe = path.join(nested, 'EpicGamesLauncher.exe'), ico = path.join(root, 'product.ico'), dll = path.join(root, 'product.dll')
  for (const file of [exe, ico, dll, path.join(root, 'uninstall.exe')]) fs.writeFileSync(file, '')
  assert.deepEqual(await mainExe(root, 'Epic Games Launcher'), [exe])
  const lookup = await parseIcons([
    `R\tEpic Games Launcher\tproduct\tC:\\Missing\\icon.exe\t${root}`,
    `R\tEpic Games Launcher\t\t${ico}`,
    `R\tIndexed\tindex\t"${dll}",-42`,
    'R\tGeneric\t\tC:\\Windows\\System32\\msiexec.exe',
  ].join('\n'))
  assert.deepEqual(lookup({ name: 'Epic Games Launcher' }), [ico, exe])
  assert.deepEqual(lookup({ name: 'Different name', productCode: 'product' }), [])
  assert.deepEqual(lookup({ name: 'Indexed' }), [`${dll},-42`])
  assert.deepEqual(lookup({ name: 'Generic' }), [])
  assert.deepEqual(lookup({ name: 'Missing' }), [])
  const image = (bytes) => ({ isEmpty: () => false, resize() { return this }, toBitmap: () => Buffer.from(bytes) })
  assert.equal(sameIcon(image([10, 20, 30, 255]), image([12, 22, 32, 255])), true)
  assert.equal(sameIcon(image([10, 20, 30, 255]), image([40, 20, 30, 255])), false)
  assert.equal(sameIcon(image([10, 20, 30, 0]), image([200, 80, 90, 0])), true)
  const good = image([120, 10, 80, 255]), generic = image([1, 2, 3, 255]), decoded = [], extracted = []
  let decodedImage = good
  const sandbox = { module: { exports: {} }, process, Buffer, require: (id) => {
    if (id === '../raw-fs') return fs
    if (id === './winget') return {}
    if (id === '../explorer/shell') return { genericIconOf: async () => 'generic', extractIconOf: async (file, index) => { extracted.push({ file, index }); return 'good' } }
    if (id === 'electron') return { app: { getFileIcon: async () => generic }, nativeImage: {
      createFromPath: (file) => { decoded.push(file); return decodedImage }, createFromDataURL: (url) => url === 'good' ? good : generic,
    } }
    return require(id)
  } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/app-installer/icons.js'), 'utf8'), sandbox)
  assert.equal(await sandbox.module.exports.readIcon(ico), good)
  assert.deepEqual(decoded, [ico])
  assert.equal(await sandbox.module.exports.readIcon(`${dll},-42`), good)
  assert.deepEqual(extracted, [{ file: dll, index: -42 }])
  assert.equal(await sandbox.module.exports.readIcon(path.join(root, 'missing.ico')), null)
  decodedImage = generic
  assert.equal(await sandbox.module.exports.readIcon(ico), null)
  decodedImage = image([10, 10, 10, 0])
  assert.equal(await sandbox.module.exports.readIcon(ico), null)
  console.log('PASS app-installer icons: index, missing fallback, nested executable, MSI candidate, generic rejection and pixel comparison')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
