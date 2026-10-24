'use strict'

/**
 * CLI 安裝器的 Linux 路徑（不連網、不碰真的家目錄）：
 * - 固定指令表：三家官方 install.sh、兩家 npm、沒有 sudo
 * - 真的跑 /bin/bash：PATH 只放假的 curl／npm，HOME 指到暫存資料夾
 *   ・缺 curl／npm → 固定訊息（MISSING_TOOL）
 *   ・假 curl 回一支「安裝腳本」→ 安裝 → 驗版本 → 再按一次走 updater
 *   ・npm 全域 prefix 不可寫 → 改裝到 ~/.local；可寫 → 照官方 npm install -g
 * - 逾時整個 process group 停掉
 *
 * 用法：node scripts/test-cli-install-linux.js
 */

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { tempDir } = require('./lib/test-temp')
const cli = require('../src/main/ccswitch/cli-install')
const linux = require('../src/main/ccswitch/cli-install-linux')

let passed = 0
function ok(name, value) { assert.ok(value, name); passed++; console.log(`PASS ${name}`) }

function writeExe(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`)
  fs.chmodSync(file, 0o755)
}

/** 真的 spawn，但 PATH 換成測試指定的（withPathLinux 會補 /usr/bin，這裡要能模擬「沒有 curl」） */
const spawnWithPath = (pathValue) => (exe, args, options) => spawn(exe, args, { ...options, env: { ...options.env, PATH: pathValue } })

async function main() {
  if (process.platform !== 'linux') { console.log('SKIP 非 Linux'); return }
  const table = linux.INSTALLERS_LINUX
  ok('五家 key 與 Windows 一致', JSON.stringify(Object.keys(table)) === JSON.stringify(Object.keys(cli.INSTALLERS)))
  ok('三家官方 install.sh', table.claude.includes('https://claude.ai/install.sh') && table.grok.includes('https://x.ai/cli/install.sh') && table.agy.includes('https://antigravity.google/cli/install.sh'))
  ok('Codex／OpenCode 官方 npm 套件', table.codex.includes('@openai/codex@latest') && table.opencode.includes('opencode-ai@latest'))
  ok('沒有任何 sudo', Object.values(table).every((cmd) => !/\bsudo\b/.test(cmd)) && !/\bsudo\b/.test(linux.NODE_CHECK))
  ok('bash 不讀 rc 且 pipefail', JSON.stringify(linux.bashCommand('x').args.slice(0, 3)) === '["--noprofile","--norc","-c"]' && linux.bashCommand('x').args[3].startsWith('set -o pipefail;'))

  const fakeNvm = { readdirSync: () => ['v18.20.0', 'v22.3.0', 'v20.1.0', 'system'] }
  const env = linux.withPathLinux({ HOME: '/home/u', PATH: '/usr/bin:/home/u/.local/bin' }, fakeNvm)
  const parts = env.PATH.split(':')
  ok('PATH 補三家原生位置與 npm 使用者 prefix', ['/home/u/.local/bin', '/home/u/.grok/bin', '/home/u/.opencode/bin', '/home/u/.npm-global/bin'].every((p) => parts.includes(p)))
  ok('PATH 補最新一版 nvm 與 volta、不重複', parts.includes('/home/u/.nvm/versions/node/v22.3.0/bin') && !env.PATH.includes('v18.20.0') && parts.includes('/home/u/.volta/bin') && parts.filter((p) => p === '/usr/bin').length === 1)

  // 缺 curl：PATH 只有空資料夾（command -v、echo 都是 bash 內建）
  const empty = tempDir('cli-empty-')
  const noCurl = cli.createRunner({ platform: 'linux', env: { HOME: tempDir('cli-home-') }, spawnImpl: spawnWithPath(empty) })
  const missingCurl = await noCurl.run('claude')
  ok('缺 curl → 固定訊息、不 sudo', missingCurl.phase === 'failed' && missingCurl.code === 'MISSING_TOOL' && missingCurl.missing === 'curl' && missingCurl.message.includes('curl') && !missingCurl.message.includes('sudo apt'))
  const missingNpm = await noCurl.run('codex')
  ok('缺 node／npm → 固定訊息', missingNpm.code === 'MISSING_TOOL' && ['node', 'npm'].includes(missingNpm.missing) && missingNpm.message.includes('Node.js'))

  // 假 curl：記下網址、吐一支會在 ~/.local/bin 放 claude 的安裝腳本
  const home = tempDir('cli-home-')
  const bin = tempDir('cli-bin-')
  const log = path.join(home, 'calls.log')
  writeExe(path.join(bin, 'curl'), `echo "curl $*" >> "${log}"
cat <<'SCRIPT'
mkdir -p "$HOME/.local/bin"
printf '#!/bin/bash\\nif [ "$1" = update ]; then echo "update" >> "$HOME/calls.log"; exit 0; fi\\necho "2.1.300 (Claude Code)"\\n' > "$HOME/.local/bin/claude"
chmod +x "$HOME/.local/bin/claude"
SCRIPT`)
  const fakePath = `${bin}:${home}/.local/bin:/usr/bin:/bin`
  const runner = cli.createRunner({ platform: 'linux', env: { HOME: home }, spawnImpl: spawnWithPath(fakePath) })
  const installed = await runner.run('claude')
  ok('官方腳本安裝後驗版本', installed.phase === 'succeeded' && installed.action === 'install' && installed.local === '2.1.300')
  ok('curl -fsSL 抓的是官方網址', fs.readFileSync(log, 'utf8').includes('curl -fsSL https://claude.ai/install.sh'))
  const updated = await runner.run('claude')
  ok('已安裝改走工具自己的 updater', updated.phase === 'succeeded' && updated.action === 'update' && fs.readFileSync(log, 'utf8').includes('update'))

  // 下載失敗（curl exit 22）：pipefail 讓整條失敗，不會把空腳本當成功
  const badBin = tempDir('cli-bin-')
  writeExe(path.join(badBin, 'curl'), 'echo "curl: (22) The requested URL returned error: 403" >&2; exit 22')
  const bad = cli.createRunner({ platform: 'linux', env: { HOME: tempDir('cli-home-') }, spawnImpl: spawnWithPath(`${badBin}:/usr/bin:/bin`) })
  const badResult = await bad.run('grok')
  ok('curl 失敗 → 安裝失敗、固定摘要', badResult.phase === 'failed' && badResult.code === 'EXIT_FAILED' && badResult.summary === '下載來源拒絕存取')

  // npm：全域 prefix 不可寫 → --prefix ~/.local；可寫 → npm install -g
  for (const writable of [false, true]) {
    const npmHome = tempDir('cli-home-')
    const npmBin = tempDir('cli-bin-')
    const globalPrefix = writable ? tempDir('cli-prefix-') : '/proc'
    const npmLog = path.join(npmHome, 'npm.log')
    writeExe(path.join(npmBin, 'node'), 'echo v22.0.0')
    writeExe(path.join(npmBin, 'npm'), `echo "npm $*" >> "${npmLog}"
case "$1" in
  --version) echo 10.0.0 ;;
  prefix) echo "${globalPrefix}" ;;
  install)
    dest="${globalPrefix}"
    for a in "$@"; do [ "$prev" = "--prefix" ] && dest="$a"; prev="$a"; done
    mkdir -p "$dest/bin" && printf '#!/bin/bash\\necho codex-cli 0.200.0\\n' > "$dest/bin/codex" && chmod +x "$dest/bin/codex" ;;
esac`)
    const npmRunner = cli.createRunner({ platform: 'linux', env: { HOME: npmHome }, spawnImpl: spawnWithPath(`${npmBin}:${npmHome}/.local/bin:${globalPrefix}/bin:/usr/bin:/bin`) })
    const result = await npmRunner.run('codex')
    const calls = fs.readFileSync(npmLog, 'utf8')
    if (writable) ok('全域 prefix 可寫 → 官方 npm install -g', result.phase === 'succeeded' && /npm install --global @openai\/codex@latest/.test(calls) && !calls.includes('--prefix'))
    else ok('全域 prefix 不可寫 → 裝到 ~/.local、不 sudo', result.phase === 'succeeded' && result.local === '0.200.0' && calls.includes(`--prefix ${npmHome}/.local`) && fs.existsSync(path.join(npmHome, '.local', 'bin', 'codex')))
  }

  // 逾時：整個 process group（含 curl | bash 的子孫）停掉
  const hangBin = tempDir('cli-bin-')
  const pidFile = path.join(hangBin, 'child.pid')
  writeExe(path.join(hangBin, 'curl'), `echo 'sleep 30 & echo $! > "${pidFile}"; wait'`)
  const hang = cli.createRunner({ platform: 'linux', timeoutMs: 1500, env: { HOME: tempDir('cli-home-') }, spawnImpl: spawnWithPath(`${hangBin}:/usr/bin:/bin`) })
  const hung = await hang.run('agy')
  const sleeper = Number(fs.readFileSync(pidFile, 'utf8'))
  let alive = true
  try { process.kill(sleeper, 0) } catch { alive = false }
  ok('逾時回 TIMEOUT 且子孫程序一起停', hung.code === 'TIMEOUT' && !alive)

  console.log(`${passed} passed`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
