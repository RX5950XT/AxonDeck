#!/usr/bin/env node
'use strict'

/**
 * Linux：Office 版面檢視改找 LibreOffice（PATH、/usr/lib/libreoffice、/opt、snap），
 * 不跑 reg.exe／PowerShell COM。有裝 soffice 時實際轉一份 odt → pdf。
 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { tempDir, removeTree } = require('./lib/test-temp')
const office = require('../src/main/workspace/office-convert')

async function main() {
  if (process.platform === 'win32') {
    console.log('test-workspace-office-convert-linux: skipped on Windows')
    return
  }
  const seen = []
  const hit = office.findLinuxSoffice({ PATH: '/nope:/usr/local/bin' }, (file) => { seen.push(file); return file === '/usr/local/bin/libreoffice' })
  assert.equal(hit, '/usr/local/bin/libreoffice')
  assert.ok(seen.every((file) => !file.endsWith('.exe')), '不找 .exe')
  assert.equal(office.findLinuxSoffice({ PATH: '' }, () => false), '', '沒裝回空字串')

  const soffice = office.findLinuxSoffice()
  const work = tempDir('office-linux-')
  try {
    office.setCacheDir(path.join(work, 'cache'))
    const tools = await office.detect()
    assert.equal(tools.office.size, 0, 'Linux 沒有 Office COM')
    assert.equal(tools.soffice, soffice)
    if (!soffice) {
      await assert.rejects(office.convert(path.join(work, 'missing.docx'), 'pdf'))
      console.log('test-workspace-office-convert-linux: passed (no LibreOffice, conversion skipped)')
      return
    }
    // 先用 soffice 自己把純文字轉成 odt，再走 convert() 轉 pdf
    const txt = path.join(work, 'note.txt')
    fs.writeFileSync(txt, 'AxonDeck Linux office preview\n')
    execFileSync(soffice, [`-env:UserInstallation=${require('url').pathToFileURL(path.join(work, 'lo')).href}`,
      '--headless', '--convert-to', 'odt', '--outdir', work, txt], { stdio: 'ignore', timeout: 120000 })
    const odt = path.join(work, 'note.odt')
    assert.ok(fs.existsSync(odt), 'odt 準備好')
    const name = await office.convert(odt, 'pdf')
    assert.match(name, /^[0-9a-f]{40}\.pdf$/)
    const pdf = office.cachedPath(name)
    assert.equal(fs.readFileSync(pdf).subarray(0, 5).toString(), '%PDF-')
    assert.ok(fs.existsSync(path.join(work, 'cache', 'lo-profile')), 'LibreOffice 設定檔放在快取裡（file:// 網址正確）')
    assert.equal(await office.convert(odt, 'pdf'), name, '第二次直接用快取')
  } finally {
    removeTree(work)
  }
  console.log('test-workspace-office-convert-linux: all passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
