'use strict'
// 編譯真正 NSIS 安裝／解除掛勾；不安裝、不發布、不覆蓋使用者安裝版。
const fs = require('fs')
const path = require('path')
const assert = require('assert/strict')
const { spawnSync } = require('child_process')
const { tempDir, removeTree } = require('./lib/test-temp')
const root = path.join(__dirname, '..')
const preview = path.join(root, 'dist/win-unpacked')
const output = tempDir('media-nsis-')
try {
  assert.ok(fs.existsSync(path.join(preview, 'resources/media/axondeck-media.exe')))
  const result = spawnSync(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), '--prepackaged', preview, '--win', 'nsis', `--config.directories.output=${output}`, '--publish', 'never'], { cwd: root, windowsHide: true, stdio: 'inherit' })
  assert.equal(result.status, 0, 'NSIS 編譯失敗')
  const installer = fs.readdirSync(output).find((file) => /^AxonDeck-Setup-.*\.exe$/.test(file))
  assert.ok(installer && fs.statSync(path.join(output, installer)).size > 10 * 1024 * 1024)
  assert.ok(fs.existsSync(path.join(output, `${installer}.blockmap`)))
  assert.ok(fs.readFileSync(path.join(output, 'latest.yml'), 'utf8').includes(installer))
  console.log('PASS NSIS 安裝／解除掛勾編譯、exe／blockmap／latest.yml；未執行安裝')
} finally { removeTree(output) }
