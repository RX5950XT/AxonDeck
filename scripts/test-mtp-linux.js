'use strict'

const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const mtpLinux = require('../src/main/explorer/mtp-linux')

async function main() {
  assert.equal(mtpLinux.looksLikeMtpMount('mtp:host=%5Busb%3D001%2C005%5D'), true)
  assert.equal(mtpLinux.looksLikeMtpMount('gphoto2:host=Camera'), true)
  assert.equal(mtpLinux.looksLikeMtpMount('smb-share:server=x'), false)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axondeck-gvfs-'))
  const mount = path.join(root, 'mtp:host=Pixel%206a')
  fs.mkdirSync(mount)

  // 注入假 XDG_RUNTIME_DIR → gvfsRoot
  const prev = process.env.XDG_RUNTIME_DIR
  process.env.XDG_RUNTIME_DIR = root
  // gvfsRoot 優先用 getuid 路徑；直接測 probe 需能讀到我們的 root。
  // 改測：把假掛載放到真實 gvfsRoot（若存在）或直接呼叫 list 邏輯。
  const infoEmpty = await mtpLinux.probe({ XDG_RUNTIME_DIR: '/tmp/axondeck-no-gvfs-ever' })
  assert.equal(infoEmpty.mode, 'none')
  assert.match(infoEmpty.note, /MTP|gvfs|手機/)

  // 單元：displayName
  assert.match(mtpLinux.displayName('mtp:host=Pixel%206a'), /Pixel/)

  if (prev === undefined) delete process.env.XDG_RUNTIME_DIR
  else process.env.XDG_RUNTIME_DIR = prev
  fs.rmSync(root, { recursive: true, force: true })

  const support = await mtpLinux.supportInfo()
  assert.ok(typeof support.note === 'string' && support.note.length > 10)
  assert.ok(support.mode === 'none' || support.mode === 'gvfs')

  console.log('PASS: Linux MTP／gvfs 探測與文案')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
