#!/usr/bin/env node
'use strict'

/**
 * 假的 `gio`：給 test-mtp-linux.js 走真的子程序路徑用。
 * mtp://Fake_Phone/ 對應到 $FAKE_PHONE_ROOT；語意照 gio：copy 不收資料夾、remove 刪不掉非空資料夾、目的地已存在就失敗。
 * 呼叫紀錄一行一筆寫到 $FAKE_GIO_LOG。
 */

const fs = require('fs')
const path = require('path')

const ROOT = process.env.FAKE_PHONE_ROOT
const URI = 'mtp://Fake_Phone/'
const args = process.argv.slice(2)
if (process.env.FAKE_GIO_LOG) fs.appendFileSync(process.env.FAKE_GIO_LOG, JSON.stringify(args) + '\n')

function toLocal(arg) {
  if (!arg.startsWith(URI)) return arg
  const rel = arg.slice(URI.length).split('/').filter(Boolean).map(decodeURIComponent)
  return path.join(ROOT, ...rel)
}

function die(msg, code = 1) {
  process.stderr.write(`gio: ${msg}\n`)
  process.exit(code)
}

const [cmd, ...rest] = args
const operands = rest.slice(rest.indexOf('--') + 1)
if (cmd === 'mount' && rest[0] === '-li') {
  const mounted = fs.existsSync(path.join(ROOT, '..', 'mounted'))
  process.stdout.write([
    'Drive(0): Samsung SSD 980',
    '  Type: GProxyDrive (GProxyVolumeMonitorUDisks2)',
    '  Volume(0): Data',
    '    Type: GProxyVolume (GProxyVolumeMonitorUDisks2)',
    '    activation_root=file:///media/data/',
    'Volume(0): Pixel 6a',
    '  Type: GProxyVolume (GProxyVolumeMonitorMTP)',
    '  ids:',
    "   unix-device: '/dev/bus/usb/003/007'",
    `  activation_root=${URI}`,
    '  can_mount=1',
    ...(mounted ? [`Mount(0): Pixel 6a -> ${URI}`, '  Type: GProxyShadowMount (GProxyVolumeMonitorMTP)'] : []),
    ''
  ].join('\n'))
  process.exit(0)
}
if (cmd === 'mount') {
  fs.writeFileSync(path.join(ROOT, '..', 'mounted'), '1')
  process.exit(0)
}
if (cmd === 'list') {
  const dir = toLocal(operands[0])
  let names
  try { names = fs.readdirSync(dir) } catch { die('No such file or directory') }
  const base = operands[0].endsWith('/') ? operands[0] : `${operands[0]}/`
  for (const name of names) {
    const st = fs.statSync(path.join(dir, name))
    const type = st.isDirectory() ? 'directory' : 'regular'
    process.stdout.write(`${base}${encodeURIComponent(name)}\t${st.isDirectory() ? 0 : st.size}\t(${type})\ttime::modified=${Math.floor(st.mtimeMs / 1000)}\n`)
  }
  process.exit(0)
}
if (cmd === 'copy') {
  const [src, dst] = operands.map(toLocal)
  if (!fs.existsSync(src)) die('No such file or directory')
  if (fs.statSync(src).isDirectory()) die("Can't recursively copy directory")
  if (fs.existsSync(dst)) die('Target file exists')
  fs.copyFileSync(src, dst)
  process.exit(0)
}
if (cmd === 'mkdir') {
  const dir = toLocal(operands[0])
  if (fs.existsSync(dir)) die('File exists')
  fs.mkdirSync(dir)
  process.exit(0)
}
if (cmd === 'remove') {
  const p = toLocal(operands[0])
  if (!fs.existsSync(p)) die('No such file or directory')
  if (fs.statSync(p).isDirectory()) {
    if (fs.readdirSync(p).length) die('Directory not empty')
    fs.rmdirSync(p)
  } else {
    fs.unlinkSync(p)
  }
  process.exit(0)
}
die(`unknown command ${cmd}`, 2)
