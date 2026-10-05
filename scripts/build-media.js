'use strict'

const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { spawnSync } = require('child_process')
const { tempDir, removeTree } = require('./lib/test-temp')
const { downloadFile } = require('../src/main/hfmodels/download')
const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'resources/media')
const manifest = require('../resources/media-runtime.json')

function run(exe, args) {
  const result = spawnSync(exe, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(`build:media 失敗：${exe}`)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe')
  const vs = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { windowsHide: true, encoding: 'utf8' })
  if (vs.status !== 0 || !vs.stdout.trim()) throw new Error('build:media 需要 Visual Studio C++ build tools')
  const choiceSource = path.join(ROOT, 'native/axondeck-probe/user-choice')
  const choiceTmp = tempDir('media-choice-')
  try {
    const sources = ['choice-main.cpp', 'HashTables.cpp', 'HashCodec.cpp', 'RegistryContext.cpp', 'Classic.cpp'].map(file => `"${path.join(choiceSource, file)}"`).join(' ')
    const batch = path.join(choiceTmp, 'build.cmd')
    fs.writeFileSync(batch, `@echo off\r\ncall "${path.join(vs.stdout.trim(), 'VC/Auxiliary/Build/vcvars64.bat')}" >nul\r\nif errorlevel 1 exit /b %errorlevel%\r\ncl /nologo /EHsc /W4 /O2 /MT /Fe:axondeck-association.exe ${sources}\r\n`)
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${batch}""`], { cwd: choiceTmp, windowsHide: true, windowsVerbatimArguments: true, stdio: 'inherit' })
    if (result.status !== 0) throw new Error('原生關聯工具編譯失敗')
    fs.copyFileSync(path.join(choiceTmp, 'axondeck-association.exe'), path.join(OUT, 'axondeck-association.exe'))
    fs.copyFileSync(path.join(choiceSource, 'LICENSE'), path.join(OUT, 'UserChoiceLatestHash-LICENSE.txt'))
    fs.copyFileSync(path.join(choiceSource, 'MPL-2.0.txt'), path.join(OUT, 'Classic-MPL-2.0.txt'))
    fs.copyFileSync(path.join(choiceSource, 'Classic.cpp'), path.join(OUT, 'Classic.cpp'))
  } finally { removeTree(choiceTmp) }
  const installed7z = path.join(process.env.ProgramFiles || 'C:/Program Files', '7-Zip/7z.exe')
  const sevenZip = fs.existsSync(installed7z) ? installed7z : '7z'
  for (const [name, item] of Object.entries(manifest)) {
    const stamp = path.join(OUT, `${name}.sha256`)
    const executable = path.join(OUT, name === 'mpv' ? 'mpv.exe' : 'magick.exe')
    if (fs.existsSync(executable) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === `${item.sha256}:2`) continue
    const tmp = tempDir('media-runtime-')
    try {
      const archive = path.join(tmp, 'runtime.7z')
      await downloadFile({ url: item.url, dest: archive, signal: AbortSignal.timeout(180000) })
      const hash = createHash('sha256')
      for await (const chunk of fs.createReadStream(archive)) hash.update(chunk)
      if (hash.digest('hex') !== item.sha256) throw new Error(`${name} SHA-256 不符`)
      run(sevenZip, ['x', '-y', `-o${tmp}/unpacked`, archive])
      const files = fs.readdirSync(path.join(tmp, 'unpacked'))
      for (const file of files) {
        // 不攜帶 upstream 安裝／更新腳本；只有真正使用的原生解碼器及授權文件。
        if (/^doc$/i.test(file)) {
          fs.cpSync(path.join(tmp, 'unpacked', file), path.join(OUT, `${name}-docs`), { recursive: true })
          continue
        }
        if (!/^(mpv|magick)\.exe$|\.dll$|\.xml$|\.txt$/i.test(file)) continue
        const source = path.join(tmp, 'unpacked', file)
        const destination = /license|copyright/i.test(file) ? `${name}-${file}` : file
        if (fs.statSync(source).isFile()) fs.copyFileSync(source, path.join(OUT, destination))
      }
      if (!fs.existsSync(executable)) throw new Error(`${name} archive 沒有執行檔`)
      fs.writeFileSync(stamp, `${item.sha256}:2`)
    } finally { removeTree(tmp) }
  }
  run('cargo', ['build', '--locked', '--release', '--manifest-path', 'native/axondeck-probe/Cargo.toml', '--bin', 'axondeck-media'])
  fs.copyFileSync(path.join(ROOT, 'native/axondeck-probe/target/release/axondeck-media.exe'), path.join(OUT, 'axondeck-media.exe'))
  fs.copyFileSync(path.join(ROOT, 'assets/icon.ico'), path.join(OUT, 'icon.ico'))
  fs.copyFileSync(path.join(ROOT, 'resources/media-policy.xml'), path.join(OUT, 'policy.xml'))
  fs.copyFileSync(path.join(ROOT, 'resources/media-runtime.json'), path.join(OUT, 'runtime.json'))
  fs.copyFileSync(path.join(ROOT, 'resources/media-LICENSE-GPL.txt'), path.join(OUT, 'mpv-LICENSE-GPL.txt'))
  fs.copyFileSync(path.join(ROOT, 'resources/media-NOTICE.txt'), path.join(OUT, 'AxonDeck-NOTICE.txt'))
  console.log('[build:media] 原生播放器與固定版本解碼器就緒')
}
main().catch((error) => { console.error(error.message); process.exitCode = 1 })
