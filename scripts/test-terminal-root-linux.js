'use strict'

/**
 * Linux root 終端機：提權工具偵測與指令組裝、失敗說明、分頁標記用字，
 * 以及在這台機器上真的開 pty：
 *   - 真的 sudo：有免密碼 sudo 就驗 `id -u` 印 0；沒有就驗畫面出現密碼提示
 *   - 假 sudo（scripts/fixtures/terminal/fake-sudo.sh）：密碼提示、不回顯、錯三次、不在 sudoers 的中文說明
 * 用法：node scripts/test-terminal-root-linux.js
 */

const assert = require('node:assert/strict')
const path = require('path')
const { execFileSync } = require('child_process')
const { tempDir } = require('./lib/test-temp')

if (process.platform !== 'linux') {
  console.log('SKIP terminal root linux（非 Linux）')
  process.exit(0)
}

const root = require('../src/main/terminal/root-linux')
const pty = require('../src/main/terminal/pty')
const store = require('../src/main/terminal/store')

const FAKE_SUDO = path.join(__dirname, 'fixtures', 'terminal', 'fake-sudo.sh')
const BASH = store.resolveExe('bash')

function testDetectAndCommand() {
  const has = (...list) => (p) => list.includes(p)
  assert.deepEqual(root.detect({ exists: has('/usr/bin/sudo', '/usr/bin/pkexec'), uid: () => 1000 }), { method: 'sudo', bin: '/usr/bin/sudo' })
  assert.deepEqual(root.detect({ exists: has('/usr/bin/run0', '/usr/bin/pkexec'), uid: () => 1000 }), { method: 'run0', bin: '/usr/bin/run0' })
  assert.deepEqual(root.detect({ exists: has('/bin/pkexec'), uid: () => 1000 }), { method: 'pkexec', bin: '/bin/pkexec' })
  assert.deepEqual(root.detect({ exists: has(), uid: () => 1000 }), { method: '', bin: '' })
  assert.deepEqual(root.detect({ exists: has(), uid: () => 0 }), { method: 'root', bin: '' })

  assert.deepEqual(root.rootCommand({ method: 'sudo', bin: '/usr/bin/sudo' }, '/usr/bin/bash', [], '/home/u/proj'),
    { exe: '/usr/bin/sudo', args: ['--', '/usr/bin/bash'] })
  assert.deepEqual(root.rootCommand({ method: 'run0', bin: '/usr/bin/run0' }, '/usr/bin/zsh', [], '/home/u/a b'),
    { exe: '/usr/bin/run0', args: ['--chdir=/home/u/a b', '/usr/bin/zsh'] })
  const pk = root.rootCommand({ method: 'pkexec', bin: '/usr/bin/pkexec' }, '/usr/bin/bash', [], '/srv/x')
  assert.equal(pk.exe, '/usr/bin/pkexec')
  assert.deepEqual(pk.args, ['/bin/sh', '-c', root.PKEXEC_SCRIPT, 'axondeck-root', '/srv/x', 'xterm-256color', '/usr/bin/bash'])
  assert.deepEqual(root.rootCommand({ method: 'root', bin: '' }, '/usr/bin/bash', [], '/'), { exe: '/usr/bin/bash', args: [] })
  assert.throws(() => root.rootCommand({ method: 'sudo', bin: '/usr/bin/sudo' }, 'bash', [], '/'), { code: 'ROOT_SHELL' })
  assert.throws(() => root.rootCommand({ method: '', bin: '' }, '/usr/bin/bash', [], '/'), { code: 'ROOT_UNSUPPORTED' })
  console.log('ok 偵測順序 sudo ＞ run0 ＞ pkexec（App 已是 root 就直接開），指令保留 cwd 與選的 shell')
}

function testHints() {
  assert.match(root.failureHint('box is not in the sudoers file.  This incident will be reported.\r\n', 1), /不在 sudoers/)
  assert.match(root.failureHint('Sorry, user box is not allowed to run sudo on host.\r\n', 1), /不在 sudoers/)
  assert.match(root.failureHint('sudo: 3 incorrect password attempts\r\n', 1), /密碼錯了三次/)
  assert.match(root.failureHint('Error executing command as another user: Request dismissed\r\n', 126), /授權沒有通過/)
  assert.equal(root.failureHint('exit\r\n', 0), '', '正常 exit 不補說明')
  assert.equal(root.failureHint('random\r\n', 2), '')
  assert.match(root.banner({ method: 'sudo' }), /sudo 會在下面問密碼；密碼由 sudo 直接讀，AxonDeck 不會看到也不會存/)
  console.log('ok 失敗說明：不在 sudoers／密碼錯三次／polkit 取消；正常結束不多話')
}

function testStoreAndCatalog() {
  const rows = store.sanitizeAll([{ id: 't_a_1', shell: 'bash', preset: 'shell', cwd: '/', admin: true }])
  assert.equal(rows[0].admin, true, 'Linux 也記住 root 分頁')
  const cat = pty.catalog()
  assert.equal(cat.supportsAdmin, true, '這台有 sudo')
  assert.equal(cat.adminCopy.badge, 'root')
  assert.equal(cat.adminCopy.method, 'sudo')
  assert.match(cat.adminCopy.dialog, /以 root 身分執行（sudo）/)
  assert.match(cat.adminCopy.hint, /AxonDeck 不會看到也不會存/)
  root._setDetectForTest(() => ({ method: '', bin: '' }))
  assert.equal(pty.catalog().supportsAdmin, false, '沒有提權工具就藏起勾選')
  root._setDetectForTest(null)
  console.log('ok catalog：Linux 有 sudo 才開放、介面用字改 root、分頁標記 root')
}

/** 開一個 root 分頁，收畫面輸出 */
function openRoot(id, cwd) {
  const out = []
  const exits = []
  pty.setEmitter((channel, payload) => {
    if (payload.id !== id) return
    if (channel === 'terminal:data') out.push(payload.data)
    if (channel === 'terminal:status' && payload.state === 'exited') exits.push(payload.exitCode)
  })
  const snap = pty.openSessionWithMeta({ id, shell: 'bash', preset: 'claude', cwd, admin: true }, 100, 30)
  const text = () => snap.buffer + out.join('')
  return { snap, text, exits }
}

async function waitFor(fn, ms = 8000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

async function testRealSudo() {
  let passwordless = false
  try {
    execFileSync('/usr/bin/sudo', ['-n', 'true'], { stdio: 'ignore', timeout: 5000 })
    passwordless = true
  } catch { /* 要密碼 */ }
  const cwd = tempDir('rootcwd-')
  const id = 't_root_real1'
  const s = openRoot(id, cwd)
  if (passwordless) {
    assert.ok(await waitFor(() => /\$ |# /.test(s.text())), 'root shell 出現提示字元')
    pty.writeSession(id, 'echo "uid=$(id -u) cwd=$PWD"\r')
    assert.ok(await waitFor(() => /uid=0 cwd=/.test(s.text())), `id -u 應為 0：${JSON.stringify(s.text().slice(-300))}`)
    const line = /uid=0 cwd=(\S+)/.exec(s.text())
    assert.equal(line[1], cwd, 'sudo 保留工作目錄')
    assert.doesNotMatch(s.text(), /claude/, 'root 分頁不自動送預設指令')
    pty.writeSession(id, 'exit\r')
    assert.ok(await waitFor(() => s.exits.length > 0))
    assert.doesNotMatch(s.text(), /\[AxonDeck\]/, '正常結束不補說明')
    console.log(`ok 真的 sudo（這台免密碼）：root 分頁裡 id -u＝0、工作目錄保留在 ${cwd}、沒有自動送 claude`)
  } else {
    assert.ok(await waitFor(() => /password/i.test(s.text())), '畫面出現 sudo 的密碼提示')
    pty.killSession(id)
    console.log('ok 真的 sudo（這台要密碼）：畫面出現密碼提示')
  }
  assert.match(s.text(), /root .*sudo 會在下面問密碼/)
  pty.forgetSession?.(id)
}

async function testFakeSudoPrompt() {
  root._setDetectForTest(() => ({ method: 'sudo', bin: FAKE_SUDO }))
  try {
    process.env.FAKE_SUDO_MODE = 'prompt'
    const id = 't_root_fake1'
    const s = openRoot(id, tempDir('rootcwd-'))
    assert.ok(await waitFor(() => /\[sudo\] password for/.test(s.text())), '密碼提示出現在終端機裡')
    pty.writeSession(id, 'wrong\r')
    assert.ok(await waitFor(() => /Sorry, try again/.test(s.text())))
    pty.writeSession(id, 'secret\r')
    assert.ok(await waitFor(() => /\$ $|\$ \S*$/m.test(s.text().split('Sorry, try again.').pop())))
    pty.writeSession(id, 'echo shell-$((40+2))\r')
    assert.ok(await waitFor(() => /shell-42/.test(s.text())))
    assert.doesNotMatch(s.text(), /secret|wrong/, '密碼沒有回顯、不在 scrollback 裡')
    pty.killSession(id)
    pty.forgetSession?.(id)

    // 錯三次
    const id2 = 't_root_fake2'
    const s2 = openRoot(id2, tempDir('rootcwd-'))
    for (let i = 0; i < 3; i += 1) {
      assert.ok(await waitFor(() => (s2.text().match(/password for/g) || []).length > i))
      pty.writeSession(id2, 'nope\r')
    }
    assert.ok(await waitFor(() => /\[AxonDeck\] 密碼錯了三次/.test(s2.text())), s2.text().slice(-300))
    pty.forgetSession?.(id2)

    // 不在 sudoers
    process.env.FAKE_SUDO_MODE = 'deny'
    const id3 = 't_root_fake3'
    const s3 = openRoot(id3, tempDir('rootcwd-'))
    assert.ok(await waitFor(() => /password for/.test(s3.text())))
    pty.writeSession(id3, 'whatever\r')
    assert.ok(await waitFor(() => /\[AxonDeck\] 這個帳號沒有 sudo 權限（不在 sudoers）/.test(s3.text())), s3.text().slice(-300))
    assert.ok(await waitFor(() => s3.exits.length > 0))
    pty.forgetSession?.(id3)
    console.log('ok 假 sudo：提示在終端機裡、密碼不回顯不進 scrollback、密碼對了才開 shell、錯三次／不在 sudoers 補中文說明')
  } finally {
    root._setDetectForTest(null)
    delete process.env.FAKE_SUDO_MODE
  }
}

;(async () => {
  if (!BASH) throw new Error('找不到 bash')
  testDetectAndCommand()
  testHints()
  testStoreAndCatalog()
  await testRealSudo()
  await testFakeSudoPrompt()
  pty.killAll?.()
  console.log('test-terminal-root-linux: all passed')
  process.exit(0)
})().catch((err) => {
  console.error(err)
  try { pty.killAll?.() } catch { /* ignore */ }
  process.exit(1)
})
