#!/usr/bin/env node
'use strict'

/**
 * Linux 套件的 GPG 簽章（選用）。沒設 LINUX_SIGNING_KEY 就印一行「略過」並 exit 0，什麼都不改。
 *
 * 有金鑰時（CI 從 repo secrets 帶進來）：
 *   1. 在 dist/ 底下開一個暫時的 GNUPGHOME（0700），匯入私鑰；結束一定關 agent、刪掉整個資料夾
 *   2. rpmsign --addsign：rpm 內嵌簽章（dnf／zypper 用 rpm --import 公鑰後可驗）
 *      rpm 內容變了 → 同步改 latest-linux*.yml 裡 rpm 的 sha512／size（不然自動更新驗證會失敗）
 *   3. AppImage、deb、rpm 各出一個分離式 `.asc`；SHA256SUMS-linux-<arch>.txt 與它的 `.asc`
 *   4. 匯出公鑰 AxonDeck-linux-signing-key.asc
 *   5. 自己驗一次：gpg --verify 每個 .asc、rpmkeys -K（用暫時 rpmdb）
 * deb 不做內嵌簽章（dpkg-sig 已淘汰、dpkg 預設也不驗），靠 .asc／SHA256SUMS；APT 套件庫簽章不在這個範圍。
 *
 *   LINUX_SIGNING_KEY='-----BEGIN PGP PRIVATE KEY BLOCK-----…' LINUX_SIGNING_PASSPHRASE=… \
 *     node scripts/sign-linux-artifacts.js --arch x64 --version 1.43.0 [--dist dist]
 */

const { spawnSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { removeTreeSync } = require('../src/main/safe-rm')
const lib = require('./lib/linux-artifacts')

function args(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
  }
  return {
    arch: get('--arch', process.arch),
    version: get('--version', require('../package.json').version),
    dist: path.resolve(get('--dist', path.join(__dirname, '..', 'dist')))
  }
}

/** 有沒有要簽（金鑰是空白也算沒有） */
function signingKey(env = process.env) {
  const key = String(env.LINUX_SIGNING_KEY || '').trim()
  return key ? key : ''
}

/** gpg 共用參數；有密碼就走 loopback＋密碼檔（不放在命令列） */
function gpgBase(home, passFile) {
  const base = ['--homedir', home, '--batch', '--yes', '--no-tty']
  return passFile ? [...base, '--pinentry-mode', 'loopback', '--passphrase-file', passFile] : base
}

function rpmsignArgs(fingerprint, home, passFile, file) {
  const extra = ['--batch', '--no-tty', ...(passFile ? ['--pinentry-mode', 'loopback', '--passphrase-file', passFile] : [])].join(' ')
  return [
    '--define', `_gpg_name ${fingerprint}`,
    '--define', `_gpg_path ${home}`,
    '--define', `_gpg_sign_cmd_extra_args ${extra}`,
    '--addsign', file
  ]
}

/** `sha256sum -c` 吃的格式 */
function sha256sumsText(entries) {
  return entries.map(({ name, hex }) => `${hex}  ${name}`).join('\n') + '\n'
}

function digest(file, algo, encoding) {
  const hash = crypto.createHash(algo)
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(1 << 20)
    let n
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n))
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest(encoding)
}

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', shell: false, ...opts })
  if (r.error) throw new Error(`${cmd} 無法執行：${r.error.code || r.error.message}`)
  if (r.status !== 0) throw new Error(`${cmd} ${argv.filter((a) => !a.startsWith('/')).slice(-3).join(' ')} 失敗（exit ${r.status}）：${String(r.stderr || '').trim().split('\n').slice(-3).join(' ')}`)
  return String(r.stdout || '')
}

function fingerprintOf(home) {
  const out = run('gpg', ['--homedir', home, '--batch', '--with-colons', '--list-secret-keys'])
  const lines = out.split('\n')
  const sec = lines.findIndex((l) => l.startsWith('sec:'))
  const fpr = lines.slice(sec + 1).find((l) => l.startsWith('fpr:'))
  const value = fpr ? fpr.split(':')[9] : ''
  if (!/^[0-9A-F]{40,64}$/i.test(value)) throw new Error('LINUX_SIGNING_KEY 裡找不到私鑰（要 ASCII-armored 的 PRIVATE KEY BLOCK）')
  return value
}

function sign(opts, key, passphrase) {
  const names = lib.packageNames(opts.version, opts.arch)
  const sig = lib.signatureNames(opts.version, opts.arch)
  const at = (n) => path.join(opts.dist, n)
  for (const n of [names.appImage, names.deb, names.rpm, names.manifest]) {
    if (!fs.existsSync(at(n))) throw new Error(`缺產物 ${n}，先打包再簽`)
  }
  const work = path.join(opts.dist, `.sign-${process.pid}`)
  const home = path.join(work, 'gnupg')
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.chmodSync(home, 0o700)
  const env = { ...process.env, GNUPGHOME: home }
  delete env.LINUX_SIGNING_KEY
  delete env.LINUX_SIGNING_PASSPHRASE
  try {
    let passFile = ''
    if (passphrase) {
      passFile = path.join(work, 'passphrase')
      fs.writeFileSync(passFile, passphrase, { mode: 0o600 })
    }
    run('gpg', ['--homedir', home, '--batch', '--import'], { input: key, env })
    const fpr = fingerprintOf(home)
    console.log(`[sign-linux] 金鑰 ${fpr.slice(-16)}`)

    run('rpmsign', rpmsignArgs(fpr, home, passFile, at(names.rpm)), { env })
    const manifest = at(names.manifest)
    const patched = lib.patchManifest(fs.readFileSync(manifest, 'utf8'), names.rpm, digest(at(names.rpm), 'sha512', 'base64'), fs.statSync(at(names.rpm)).size)
    fs.writeFileSync(manifest, patched)

    const detach = (file) => run('gpg', [...gpgBase(home, passFile), '--local-user', fpr, '--armor', '--detach-sign', '--output', `${file}.asc`, file], { env })
    for (const n of [names.appImage, names.deb, names.rpm]) detach(at(n))
    const sums = [names.appImage, names.deb, names.rpm].map((name) => ({ name, hex: digest(at(name), 'sha256', 'hex') }))
    fs.writeFileSync(at(sig.sums), sha256sumsText(sums))
    detach(at(sig.sums))
    fs.writeFileSync(at(sig.publicKey), run('gpg', ['--homedir', home, '--batch', '--armor', '--export', fpr], { env }))

    // 自己驗：分離簽章＋rpm 內嵌簽章（暫時 rpmdb，不碰系統的）
    for (const n of [...sig.detached, sig.sumsSig]) {
      const file = at(n)
      run('gpg', ['--homedir', home, '--batch', '--verify', file, file.replace(/\.asc$/, '')], { env })
    }
    const rpmdb = path.join(work, 'rpmdb')
    fs.mkdirSync(rpmdb, { recursive: true })
    run('rpmkeys', ['--dbpath', rpmdb, '--import', at(sig.publicKey)])
    const checked = run('rpmkeys', ['--dbpath', rpmdb, '--checksig', at(names.rpm)])
    if (!/signatures OK|pgp.*OK/i.test(checked)) throw new Error(`rpm 簽章驗證沒過：${checked.trim()}`)
    console.log(`[sign-linux] ✓ 已簽：${[names.rpm + '（內嵌）', ...sig.detached, sig.sumsSig].join('、')}；公鑰 ${sig.publicKey}`)
  } finally {
    spawnSync('gpgconf', ['--homedir', home, '--kill', 'all'], { stdio: 'ignore', shell: false, env })
    removeTreeSync(work)
  }
}

function main(argv, env = process.env) {
  const opts = args(argv)
  const key = signingKey(env)
  if (!key) {
    console.log('[sign-linux] 沒有 LINUX_SIGNING_KEY，略過簽章（產物照常上傳、不附 .asc）')
    return { signed: false }
  }
  if (process.platform !== 'linux') throw new Error('簽章只在 Linux 上跑')
  sign(opts, key, String(env.LINUX_SIGNING_PASSPHRASE || ''))
  return { signed: true }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`[sign-linux] ${error.message}`)
    process.exit(1)
  }
}

module.exports = { main, signingKey, gpgBase, rpmsignArgs, sha256sumsText }
