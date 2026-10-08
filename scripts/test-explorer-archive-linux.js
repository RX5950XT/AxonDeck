'use strict'

/**
 * Linux 右鍵：壓縮／解壓縮（archive-linux.js）、開啟方式／終端機（open-with-linux.js）、
 * 內容視窗（properties-linux.js）、shell-linux.js 的選單與 invoke、operations.js 的 runner 模式。
 *
 * 純函式全平台跑；真的壓縮／解壓縮只在 Linux 跑，**這台有哪些工具就逐一強制用那支工具測**
 * （7-Zip、zip、unzip、bsdtar、tar），沒有的印 SKIP。全部在 test-temp 底下；
 * 「取代」丟回收筒時把 XDG_DATA_HOME 指到暫存資料夾，不碰使用者真的垃圾桶。
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { tempDir } = require('./lib/test-temp')

const isLinux = process.platform === 'linux'
let passed = 0
let skipped = 0
function ok(name) { passed += 1; console.log(`PASS ${name}`) }
function skip(name) { skipped += 1; console.log(`SKIP ${name}`) }

const sandbox = tempDir('lx-shell-')
// 回收筒（gio trash 與手動那條都看 XDG_DATA_HOME）指到暫存
process.env.XDG_DATA_HOME = path.join(sandbox, 'xdg-data')

const archive = require('../src/main/explorer/archive-linux')
const openWith = require('../src/main/explorer/open-with-linux')
const props = require('../src/main/explorer/properties-linux')

function pure() {
  assert.equal(archive.archiveKind('a.tar.gz'), 'tar.gz')
  assert.equal(archive.archiveKind('A.TGZ'), 'tar.gz')
  assert.equal(archive.archiveKind('x.tar.zst'), 'tar.zst')
  assert.equal(archive.archiveKind('x.7z'), '7z')
  assert.equal(archive.archiveKind('x.txt'), '')
  assert.equal(archive.stripArchiveExt('專案 v2.tar.xz'), '專案 v2')
  assert.equal(archive.stripArchiveExt('a.zip'), 'a')
  ok('archiveKind／stripArchiveExt')

  const none = { sevenZip: '', bsdtar: '', tar: '', zip: '', unzip: '' }
  assert.equal(archive.compressTool('zip', none), '')
  assert.equal(archive.compressTool('zip', { ...none, zip: '/z' }), 'zip')
  assert.equal(archive.compressTool('zip', { ...none, zip: '/z', sevenZip: '/7' }), 'sevenZip')
  assert.equal(archive.compressTool('7z', { ...none, bsdtar: '/b' }), 'bsdtar')
  assert.equal(archive.compressTool('7z', { ...none, zip: '/z', tar: '/t' }), '')
  assert.equal(archive.compressTool('tar.gz', { ...none, tar: '/t' }), 'tar')
  assert.equal(archive.extractTool('zip', { ...none, unzip: '/u' }), 'unzip')
  assert.equal(archive.extractTool('rar', { ...none, unzip: '/u', tar: '/t' }), '')
  assert.equal(archive.extractTool('tar.xz', { ...none, tar: '/t' }), 'tar')
  assert.match(archive.missingHint({ ...none, tar: '/t', unzip: '/u' }), /7z 格式、ZIP 壓縮/)
  assert.equal(archive.missingHint({ ...none, sevenZip: '/7', tar: '/t' }), '')
  ok('依工具挑壓縮／解壓縮方式、缺工具提示')

  const dir = tempDir('uniq-')
  fs.writeFileSync(path.join(dir, 'a.tar.gz'), '')
  fs.writeFileSync(path.join(dir, 'a (2).tar.gz'), '')
  assert.equal(path.basename(archive.uniquePath(dir, 'a', '.tar.gz')), 'a (3).tar.gz')
  assert.equal(path.basename(archive.uniquePath(dir, 'b', '.zip')), 'b.zip')
  ok('uniquePath 不覆寫、複合副檔名留在尾巴')

  const seven = 'Listing archive: x.7z\n--\nPath = x.7z\nType = 7z\n----------\nPath = dir\nFolder = +\n\nPath = dir/a.txt\nSize = 3\n'
  assert.deepEqual(archive.parseSevenList(seven), ['dir', 'dir/a.txt'])
  assert.deepEqual(archive.topLevel(['dir/', 'dir/a', 'b.txt', '../evil']), ['dir', 'b.txt'])
  const fractions = []
  const parse7 = archive.progressParser('sevenZip', 0, (f) => fractions.push(f))
  parse7(' 42% 3 + a.txt')
  parse7('100%')
  assert.deepEqual(fractions, [0.42, 1])
  const lines = []
  const parseTar = archive.progressParser('tar', 4, (f) => lines.push(f))
  parseTar('dir/')
  parseTar('dir/a.txt')
  assert.deepEqual(lines, [0.25, 0.5])
  ok('7-Zip 清單解析、進度解析')

  assert.deepEqual(openWith.splitExec('foo "a b" \'c\' "x\\"y" %U'), ['foo', 'a b', "'c'", 'x"y', '%U'])
  assert.deepEqual(openWith.expandExec('gedit %U', ['/t/a b#1.txt']), ['gedit', 'file:///t/a%20b%231.txt'])
  assert.deepEqual(openWith.expandExec('vlc --started-from-file %F', ['/a', '/b']), ['vlc', '--started-from-file', '/a', '/b'])
  assert.deepEqual(openWith.expandExec('app --icon %i %f', ['/a', '/b']), ['app', '--icon', '/a'])
  assert.deepEqual(openWith.expandExec('app', ['/a']), ['app', '/a'])
  assert.deepEqual(openWith.expandExec('app --name=%f 100%%', ['/a']), ['app', '--name=/a', '100%'])
  ok('Exec 欄位解析（引號、%f/%F/%u/%U、丟掉 %i）')

  const entry = openWith.parseDesktop('[Desktop Entry]\nName=Text Editor\nName[zh_TW]=文字編輯器\nExec=gedit %U\nNoDisplay=false\nTerminal=true\n[Desktop Action new]\nName=New\nExec=bad', 'zh_TW.UTF-8')
  assert.equal(entry.name, '文字編輯器')
  assert.equal(entry.exec, 'gedit %U')
  assert.equal(entry.terminal, true)
  assert.equal(entry.hidden, false)
  const gio = openWith.parseGioMime('Default application for “text/plain”: org.gnome.TextEditor.desktop\nRegistered applications:\n\torg.gnome.TextEditor.desktop\n\tvim.desktop\nRecommended applications:\n\tvim.desktop\n')
  assert.equal(gio.defaultId, 'org.gnome.TextEditor.desktop')
  assert.deepEqual(gio.ids, ['org.gnome.TextEditor.desktop', 'vim.desktop'])
  ok('.desktop 在地化名稱、gio mime 解析')

  assert.equal(props.modeString(0o755), 'rwxr-xr-x')
  assert.equal(props.modeString(0o4755), 'rwsr-xr-x')
  assert.equal(props.modeString(0o1777), 'rwxrwxrwt')
  assert.equal(props.modeString(0o2644), 'rw-r-Sr--')
  assert.deepEqual(props.parseGioInfo('uri: file:///a\nattributes:\n  standard::content-type: text/plain\n  standard::description: 純文字文件\n'), { mime: 'text/plain', description: '純文字文件' })
  ok('權限字串（含 setuid／sticky）、gio info 解析')
}

async function appsFromFakeXdg() {
  const root = tempDir('xdg-apps-')
  const apps = path.join(root, 'share', 'applications')
  fs.mkdirSync(apps, { recursive: true })
  fs.writeFileSync(path.join(apps, 'fake-editor.desktop'), '[Desktop Entry]\nType=Application\nName=Fake Editor\nName[zh_TW]=假編輯器\nExec=fake-editor %F\n')
  fs.writeFileSync(path.join(apps, 'hidden.desktop'), '[Desktop Entry]\nType=Application\nName=Hidden\nExec=hidden %f\nNoDisplay=true\n')
  fs.writeFileSync(path.join(apps, 'gone.desktop'), '[Desktop Entry]\nType=Application\nName=Gone\nExec=gone %f\n')
  fs.writeFileSync(path.join(apps, 'mimeinfo.cache'), '[MIME Cache]\ntext/x-axd=fake-editor.desktop;hidden.desktop;gone.desktop;\n')
  const config = path.join(root, 'config')
  fs.mkdirSync(config)
  fs.writeFileSync(path.join(config, 'mimeapps.list'), '[Removed Associations]\ntext/x-axd=gone.desktop;\n')
  const env = { HOME: root, XDG_CONFIG_HOME: config }
  const list = await openWith.appsFor('text/x-axd', { dirs: [apps], env, skipGio: true, locale: 'zh_TW.UTF-8' })
  assert.deepEqual(list.map((a) => a.name), ['假編輯器'])
  const launched = []
  const okLaunch = await openWith.launch('fake-editor.desktop', ['/x/a.txt'], {
    skipGio: true, dirs: [apps], spawnDetached: async (file, args) => { launched.push([file, ...args]); return true }
  })
  assert.equal(okLaunch, true)
  assert.deepEqual(launched, [['fake-editor', '/x/a.txt']])
  assert.equal(await openWith.launch('../../etc/passwd', ['/x']), false)
  ok('開啟方式：mimeinfo.cache＋mimeapps.list（Removed）、NoDisplay 隱藏、Exec 啟動不經 shell')

  const bin = tempDir('fake-bin-')
  for (const name of ['konsole', 'xterm']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n')
    fs.chmodSync(path.join(bin, name), 0o755)
  }
  const kde = openWith.terminalCandidates({ PATH: bin, XDG_CURRENT_DESKTOP: 'KDE' }).map((t) => t.exe)
  assert.deepEqual(kde, ['konsole', 'xterm'])
  const calls = []
  const used = await openWith.openTerminal('/srv/資料 夾', { env: { PATH: bin, XDG_CURRENT_DESKTOP: 'KDE' }, spawnDetached: async (file, args, cwd) => { calls.push({ file, args, cwd }); return file === 'konsole' } })
  assert.equal(used, 'konsole')
  assert.deepEqual(calls[0], { file: 'konsole', args: ['--workdir', '/srv/資料 夾'], cwd: '/srv/資料 夾' })
  assert.equal(await openWith.openTerminal('/x', { env: { PATH: tempDir('empty-bin-') } }), '')
  ok('開啟終端機：依桌面排序、工作目錄參數、找不到回空字串')
}

function makeTree(dir) {
  const src = path.join(dir, 'src')
  fs.mkdirSync(path.join(src, '專案 資料夾', 'sub'), { recursive: true })
  fs.writeFileSync(path.join(src, '專案 資料夾', 'a.txt'), 'hello 世界')
  fs.writeFileSync(path.join(src, '專案 資料夾', 'sub', '-dash.txt'), 'dash')
  fs.writeFileSync(path.join(src, '專案 資料夾', 'sub', 'big.bin'), Buffer.alloc(200_000, 7))
  fs.writeFileSync(path.join(src, 'note.md'), '# note')
  return src
}

function readTree(root) {
  const out = {}
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      const key = rel ? `${rel}/${name}` : name
      const st = fs.lstatSync(full)
      if (st.isDirectory()) { out[`${key}/`] = true; walk(full, key) } else out[key] = fs.readFileSync(full).length
    }
  }
  walk(root, '')
  return out
}

function only(tools, key) {
  const none = { sevenZip: '', bsdtar: '', tar: '', zip: '', unzip: '', gnuTar: false }
  return { ...none, [key]: tools[key], gnuTar: key === 'tar' && tools.gnuTar }
}

async function roundTrip(tools, format, compressKey, extractKey) {
  const dir = tempDir(`rt-${format.replace('.', '')}-`)
  const src = makeTree(dir)
  const sources = [path.join(src, '專案 資料夾'), path.join(src, 'note.md')]
  let total = 0
  let last = 0
  const made = await archive.compress({ sources, format, tools: only(tools, compressKey), onTotal: (t) => { total = t }, onProgress: (b) => { last = b } })
  assert.equal(path.basename(made.path), `src.${format}`)
  assert.ok(total > 200_000 && last === total, `進度要走到總量 ${last}/${total}`)
  assert.deepEqual(fs.readdirSync(src).filter((n) => n.startsWith('.axd-')), [])
  // 再壓一次不覆寫
  const again = await archive.compress({ sources, format, tools: only(tools, compressKey) })
  assert.equal(path.basename(again.path), `src (2).${format}`)

  const xtools = only(tools, extractKey)
  const plan = await archive.planExtract(made.path, src, { tools: xtools })
  assert.deepEqual(plan.top.sort(), ['note.md', '專案 資料夾'].sort())
  assert.deepEqual(plan.conflicts.sort(), ['note.md', '專案 資料夾'].sort())
  const folder = await archive.extract({ archive: made.path, mode: 'folder', plan })
  assert.equal(path.basename(folder.path), 'src')
  assert.deepEqual(readTree(folder.path), filterTree(readTree(src), ['note.md', '專案 資料夾']))
  return { dir, src, made, xtools }
}

function filterTree(tree, tops) {
  return Object.fromEntries(Object.entries(tree).filter(([k]) => tops.includes(k.split('/')[0])))
}

async function extractHereSemantics(made, xtools) {
  const dest = tempDir('here-')
  const archivePath = path.join(dest, path.basename(made.path))
  fs.copyFileSync(made.path, archivePath)
  fs.writeFileSync(path.join(dest, 'note.md'), 'OLD')
  const plan = await archive.planExtract(archivePath, dest, { tools: xtools })
  assert.deepEqual(plan.conflicts, ['note.md'])
  // 沒確認：不覆寫，新的變 note (2).md
  const kept = await archive.extract({ archive: archivePath, mode: 'here', plan, trash: async () => { throw new Error('不該丟回收筒') } })
  assert.equal(fs.readFileSync(path.join(dest, 'note.md'), 'utf8'), 'OLD')
  assert.equal(fs.readFileSync(path.join(dest, 'note (2).md'), 'utf8'), '# note')
  assert.ok(kept.items.some((p) => p.endsWith('專案 資料夾')))
  // 確認取代：舊的交給 trash（這裡記錄下來，不真的丟）
  const trashed = []
  const plan2 = await archive.planExtract(archivePath, dest, { tools: xtools })
  await archive.extract({ archive: archivePath, mode: 'here', plan: plan2, replace: ['note.md'], trash: async (full) => { trashed.push(path.basename(full)); fs.renameSync(full, `${full}.trashed`) } })
  assert.deepEqual(trashed, ['note.md'])
  assert.equal(fs.readFileSync(path.join(dest, 'note.md'), 'utf8'), '# note')
  assert.ok(fs.existsSync(path.join(dest, '專案 資料夾 (2)')), '沒列在 replace 的同名資料夾要改名')
  assert.deepEqual(fs.readdirSync(dest).filter((n) => n.startsWith('.axd-')), [])
}

async function realArchives() {
  const tools = archive.detectTools({ fresh: true })
  console.log(`  工具：${Object.entries(tools).map(([k, v]) => `${k}=${v || '無'}`).join(' ')}`)
  const combos = [
    ['zip', 'sevenZip', 'sevenZip'], ['zip', 'zip', 'unzip'], ['zip', 'bsdtar', 'bsdtar'], ['zip', 'zip', 'bsdtar'],
    ['7z', 'sevenZip', 'sevenZip'], ['7z', 'bsdtar', 'bsdtar'], ['7z', 'bsdtar', 'sevenZip'],
    ['tar.gz', 'tar', 'tar'], ['tar.gz', 'bsdtar', 'bsdtar'], ['tar.gz', 'tar', 'bsdtar']
  ]
  let hereDone = false
  for (const [format, ck, xk] of combos) {
    const label = `${format}：${ck} 壓縮 → ${xk} 解壓縮（含中文／空白／- 開頭檔名、不覆寫、解到資料夾）`
    if (!tools[ck] || !tools[xk]) { skip(`${label}（缺 ${!tools[ck] ? ck : xk}）`); continue }
    const { made, xtools } = await roundTrip(tools, format, ck, xk)
    ok(label)
    if (!hereDone || format === 'zip') {
      await extractHereSemantics(made, xtools)
      ok(`解壓縮到這裡（${xk}）：沒確認不覆寫（note (2).md）、確認後舊的交給回收筒`)
      hereDone = true
    }
  }
  await cancelCompress(tools)
}

async function cancelCompress(tools) {
  const format = archive.compressTool('7z', tools) ? '7z' : archive.compressTool('zip', tools) ? 'zip' : 'tar.gz'
  if (!archive.compressTool(format, tools)) { skip('取消壓縮（沒有任何壓縮工具）'); return }
  const dir = tempDir('cancel-')
  const big = path.join(dir, 'big')
  fs.mkdirSync(big)
  const chunk = require('crypto').randomBytes(4 * 1024 * 1024)
  for (let i = 0; i < 24; i++) fs.writeFileSync(path.join(big, `r${i}.bin`), chunk.map((b, j) => b ^ (i + j) & 0xff))
  const controller = new AbortController()
  const started = Date.now()
  const pending = archive.compress({ sources: [big], format, signal: controller.signal, onProgress: () => {} })
  setTimeout(() => controller.abort(), 150)
  await assert.rejects(pending, (e) => e.code === 'CANCELLED')
  assert.deepEqual(fs.readdirSync(dir).sort(), ['big'], '取消後不能留下半個壓縮檔')
  ok(`取消壓縮（${format}，${Date.now() - started}ms）：子程序結束、暫存檔清掉、沒有產生壓縮檔`)

  if (!tools.tar) { skip('取消解壓縮（沒有 tar）'); return }
  require('child_process').execFileSync(tools.tar, ['-cf', path.join(dir, 'big.tar'), 'big'], { cwd: dir })
  const out = tempDir('cancel-x-')
  fs.renameSync(path.join(dir, 'big.tar'), path.join(out, 'big.tar'))
  const xc = new AbortController()
  const extracting = archive.extract({ archive: path.join(out, 'big.tar'), mode: 'folder', signal: xc.signal, onProgress: (b) => { if (b > 0) xc.abort() } })
  await assert.rejects(extracting, (e) => e.code === 'CANCELLED')
  assert.deepEqual(fs.readdirSync(out), ['big.tar'], '取消解壓縮後不能留下暫存資料夾或半套結果')
  ok('取消解壓縮：子程序結束、.axd-extract-* 暫存資料夾清掉、沒有產生資料夾')
}

async function properties() {
  const dir = tempDir('props-')
  const file = path.join(dir, '報告.txt')
  fs.writeFileSync(file, 'x'.repeat(1234))
  fs.chmodSync(file, 0o640)
  fs.mkdirSync(path.join(dir, 'd', 'e'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'd', 'one'), Buffer.alloc(1000))
  fs.writeFileSync(path.join(dir, 'd', 'e', 'two'), Buffer.alloc(2000))
  fs.symlinkSync(file, path.join(dir, 'd', 'link-to-file'))
  fs.symlinkSync('/nonexistent/axd', path.join(dir, 'broken'))

  const info = await props.info(file)
  assert.equal(info.name, '報告.txt')
  assert.equal(info.size, 1234)
  assert.equal(info.octal, '0640')
  assert.equal(info.modeText, 'rw-r-----')
  assert.equal(info.location, dir)
  assert.equal(info.mime, 'text/plain')
  assert.equal(info.description, '純文字文件', '類型要有給人看的說明，MIME 當次要資訊')
  assert.equal(props.describeMime('application/x-unknown-thing', 'Foo document'), 'Foo document', '表裡沒有就用 gio 的說明')
  assert.equal(props.describeMime('image/x-weird'), '圖片', '再沒有就用大類')
  assert.equal(props.describeMime('application/x-weird'), '')
  assert.ok(info.owner && info.group && info.modified && info.accessed)
  assert.equal(info.canChmod, true)
  const link = await props.info(path.join(dir, 'd', 'link-to-file'))
  assert.equal(link.isLink, true)
  assert.equal(link.linkTarget, file)
  assert.equal(link.canChmod, false)
  const broken = await props.info(path.join(dir, 'broken'))
  assert.equal(broken.linkBroken, true)
  assert.equal(broken.linkTarget, '/nonexistent/axd')
  const folder = await props.info(path.join(dir, 'd'))
  assert.equal(folder.isDir, true)
  assert.equal(folder.mime, 'inode/directory')
  assert.equal(folder.description, '資料夾')
  assert.equal(broken.description, '損壞的連結')
  ok(`內容：檔案（MIME ${info.mime}，來源 ${(await props.mimeOf(file, fs.statSync(file))).source}）、資料夾、符號連結與損壞連結`)

  const changed = await props.chmod(file, '0755')
  assert.equal(changed.octal, '0755')
  assert.equal(fs.statSync(file).mode & 0o777, 0o755)
  await props.chmod(file, 0o600)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  await assert.rejects(props.chmod(file, '0999'), (e) => e.code === 'BAD_PATH')
  await assert.rejects(props.chmod(file, 0o17777), (e) => e.code === 'BAD_PATH')
  await assert.rejects(props.chmod(path.join(dir, 'd', 'link-to-file'), '0777'), (e) => e.code === 'BAD_PATH')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, '對連結 chmod 不能改到目標')
  if (fs.existsSync('/etc/hostname') && process.getuid() !== 0) {
    await assert.rejects(props.chmod('/etc/hostname', '0666'), (e) => e.code === 'PROTECTED')
  }
  ok('chmod：八進位字串／數字、拒絕不合法值、不穿過符號連結、別人的檔案回 PROTECTED')

  const progress = []
  const total = await props.totalSize([path.join(dir, 'd')], 'tok-1', { onProgress: (p) => progress.push(p) })
  assert.equal(total.bytes, 3000 + fs.lstatSync(path.join(dir, 'd', 'link-to-file')).size)
  assert.equal(total.files, 3)
  assert.equal(total.dirs, 2)
  assert.equal(progress[progress.length - 1].done, true)
  const many = path.join(dir, 'many')
  fs.mkdirSync(many)
  for (let i = 0; i < 3000; i++) fs.writeFileSync(path.join(many, `f${i}`), 'z')
  const pendingSize = props.totalSize([many], 'tok-2')
  props.cancelSize('tok-2')
  const cancelled = await pendingSize
  assert.equal(cancelled.cancelled, true)
  assert.ok(cancelled.files < 3000)
  ok('資料夾大小：遞迴、不跟隨符號連結、可取消')
}

async function shellAndOperations() {
  const operations = require('../src/main/explorer/operations')
  await assert.rejects(operations.run({ mode: 'compress', sources: ['/x'] }), (e) => e.code === 'BAD_PATH')
  await assert.rejects(operations.run({ mode: 'extract', sources: ['/x'], runner: 'nope' }), (e) => e.code === 'BAD_PATH')
  ok('operations：compress／extract 沒有 main 端 runner 函式一律拒絕（renderer 無法要求）')

  const shellLinux = require('../src/main/explorer/shell-linux')
  const events = []
  operations.configure({ emit: (channel, event) => { if (channel === 'explorer:operation') events.push(event) } })
  const dir = tempDir('shell-')
  const src = makeTree(dir)
  const tools = archive.detectTools({ fresh: true })
  const menu = await shellLinux.menu({ paths: [path.join(src, '專案 資料夾'), path.join(src, 'note.md')] })
  const compress = menu.items.find((i) => i.verb === 'compress')
  const formats = archive.FORMATS.filter((f) => archive.compressTool(f, tools))
  assert.deepEqual(compress ? compress.children.map((c) => c.verb) : [], formats.map((f) => `compress-${f}`))
  assert.ok(menu.items.some((i) => i.verb === 'properties'))
  assert.ok(menu.items.some((i) => i.verb === 'terminal'))
  assert.equal(Boolean(menu.items.find((i) => i.verb === 'archive-hint')), Boolean(archive.missingHint(tools)))
  ok(`選單：只列有工具的格式（${formats.join('、') || '無'}）${archive.missingHint(tools) ? '＋缺工具提示' : ''}、終端機、隱藏的內容動詞`)

  const format = formats.includes('zip') ? 'zip' : formats[0]
  if (!format) { skip('shell-linux 壓縮／解壓縮 invoke（沒有工具）'); return }
  const res = await shellLinux.invoke(menu.token, shellLinux.CMD_COMPRESS_BASE + archive.FORMATS.indexOf(format))
  assert.equal(res.invoked, true)
  assert.match(res.operation, /^op-/)
  await waitFinished(events, res.operation)
  const finished = events.find((e) => e.id === res.operation && e.type === 'finished')
  assert.equal(finished.result.status, 'completed')
  assert.equal(finished.mode, 'compress')
  assert.ok(events.some((e) => e.id === res.operation && e.type === 'progress' && Number.isFinite(e.totalBytes) && e.totalBytes > 0))
  const made = path.join(src, `src.${format}`)
  assert.ok(fs.existsSync(made))
  ok(`invoke 壓縮成 ${format}：走檔案操作面板（started→progress→finished，有 totalBytes）`)

  const m2 = await shellLinux.menu({ paths: [made] })
  assert.ok(m2.items.some((i) => i.verb === 'extract-here'))
  assert.ok(m2.items.some((i) => i.verb === 'extract-folder' && i.label === '解壓縮到「src/」'))
  const here = await shellLinux.invoke(m2.token, shellLinux.CMD_EXTRACT_HERE)
  assert.equal(here.invoked, false)
  assert.match(here.confirm.title, /取代 2 個同名項目/)
  assert.deepEqual((await shellLinux.confirm(here.confirm.id, false)), { invoked: false, cancelled: true })
  assert.match((await shellLinux.confirm(here.confirm.id, true)).error, /過期/)
  assert.equal(fs.readFileSync(path.join(src, 'note.md'), 'utf8'), '# note')
  const here2 = await shellLinux.invoke(m2.token, shellLinux.CMD_EXTRACT_HERE)
  fs.writeFileSync(path.join(src, 'note.md'), 'OLD')
  const accepted = await shellLinux.confirm(here2.confirm.id, true)
  await waitFinished(events, accepted.operation)
  assert.equal(fs.readFileSync(path.join(src, 'note.md'), 'utf8'), '# note')
  const trashFiles = path.join(process.env.XDG_DATA_HOME, 'Trash', 'files')
  assert.ok(fs.readdirSync(trashFiles).includes('note.md'), '舊的 note.md 要在（暫存的）垃圾桶裡')
  ok('解壓縮到這裡：同名先問、取消不動、確認只能用一次、確認後舊的進垃圾桶（暫存 XDG_DATA_HOME）')

  const folder = await shellLinux.invoke(m2.token, shellLinux.CMD_EXTRACT_FOLDER)
  await waitFinished(events, folder.operation)
  assert.ok(fs.existsSync(path.join(src, 'src', '專案 資料夾', 'sub', '-dash.txt')))
  const propsRes = await shellLinux.invoke(m2.token, shellLinux.CMD_PROPERTIES)
  assert.deepEqual(propsRes, { invoked: true, linuxProperties: { paths: [made] } })
  await shellLinux.release(m2.token)
  await shellLinux.release(menu.token)
  shellLinux.shutdown()
  ok('解壓縮到資料夾、內容動詞回傳 linuxProperties')
}

function waitFinished(events, id) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (events.some((e) => e.id === id && e.type === 'finished')) resolve()
      else if (Date.now() - started > 20_000) reject(new Error(`操作 ${id} 沒有結束`))
      else setTimeout(tick, 20)
    }
    tick()
  })
}

function wiring() {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
  const index = read('src/main/explorer/index.js')
  for (const name of ['linuxShellConfirm', 'linuxProperties', 'linuxPropertiesSize', 'linuxPropertiesCancel', 'linuxChmod']) {
    assert.match(index, new RegExp(`function ${name}\\([^)]*\\) \\{\\n  linuxOnly\\(\\)`), `${name} 要先 linuxOnly()`)
    assert.match(read('src/main/explorer/ipc.js'), new RegExp(`'explorer:${name}'`))
    assert.match(read('src/preload/preload.js'), new RegExp(`${name}: `))
    assert.match(read('src/main/main.js'), new RegExp(`${name}: \\(\\.\\.\\.args\\) => loadExplorer\\(\\)\\.${name}`))
  }
  assert.match(index, /if \(platform\.isWindows\) throw paths\.fail\('UNSUPPORTED'/)
  const page = read('src/renderer/scripts/explorer-page.js')
  assert.match(page, /isLinuxShellResult\(result\)\) void handleLinuxShellResult/)
  const linux = read('src/renderer/scripts/explorer-linux.js')
  assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|window\.(confirm|prompt|alert)\(/.test(linux), 'explorer-linux.js 不能用 innerHTML／原生對話框')
  for (const file of ['archive-linux.js', 'open-with-linux.js', 'properties-linux.js', 'shell-linux.js']) {
    assert.ok(!/shell:\s*true|[^.\w]exec\(/.test(read(`src/main/explorer/${file}`)), `${file} 不能經過 shell`)
  }
  ok('接線：IPC／preload／main 列舉、Windows 回 UNSUPPORTED、renderer 零 innerHTML、外部程序不經 shell')
}

async function main() {
  pure()
  wiring()
  if (!isLinux) { skip('Linux 實測（不是 Linux）'); return }
  await appsFromFakeXdg()
  await realArchives()
  await properties()
  await shellAndOperations()
}

main().then(() => {
  console.log(`\n${passed} passed, ${skipped} skipped`)
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
