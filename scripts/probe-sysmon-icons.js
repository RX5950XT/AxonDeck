'use strict'
const assert = require('node:assert/strict')
const { tempDir } = require('./lib/test-temp')

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const run = spawnSync(require('electron'), [__filename], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
  process.stdout.write(run.stdout || '')
  process.stderr.write(run.stderr || '')
  process.exitCode = run.status === 0 ? 0 : 1
} else {
  const { app } = require('electron')
  app.setPath('userData', tempDir('sysmon-icons-'))
  app.whenReady().then(async () => {
    const { createProcessIcons } = require('../src/main/sysmon/process-icons')
    const cache = createProcessIcons()
    cache.read(process.execPath)
    const end = Date.now() + 4000
    let icon = ''
    while (!icon && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      icon = cache.read(process.execPath)
    }
    assert.match(icon, /^data:image\/png;base64,/)
    console.log(`PASS Electron app.getFileIcon（small），data URI ${icon.length} 字元；無視窗、獨立 userData`)
    app.exit(0)
  }).catch(() => { console.error('FAIL Electron 處理程序圖示'); app.exit(1) })
}
