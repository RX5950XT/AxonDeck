#!/usr/bin/env node
'use strict'

/**
 * Linux 終端機「＋」選單的 distrobox／toolbox：解析清單、組 enter 參數、
 * 加進 availableShells；Windows 行為不變（不列出、不解析容器 key）。
 */

const assert = require('assert/strict')
const { parseNames, parseKey, commandFor, listContainersSync } = require('../src/main/terminal/linux-containers')

const distroboxOut = `ID           | NAME                 | STATUS             | IMAGE
3b0c5fabc123 | ubuntu               | Up 2 days          | ubuntu:22.04
aa11bb22cc33 | fedora-dev           | Created            | fedora:40
`
const toolboxOut = `CONTAINER ID  CONTAINER NAME        CREATED         STATUS    IMAGE NAME
d9e8f7a6b5c4  fedora-toolbox-40     2 weeks ago     running   registry.fedoraproject.org/fedora-toolbox:40
`

assert.deepEqual(parseNames(distroboxOut), ['ubuntu', 'fedora-dev'])
assert.deepEqual(parseNames(toolboxOut), ['fedora-toolbox-40'])
assert.deepEqual(parseNames(''), [])
assert.deepEqual(parseNames('ID | NAME | STATUS\n'), [])
assert.equal(parseKey('distrobox:ubuntu')?.name, 'ubuntu')
assert.equal(parseKey('toolbox:fedora-toolbox-40')?.kind, 'toolbox')
assert.equal(parseKey('bash'), null)
assert.equal(parseKey('distrobox:../x'), null)
assert.equal(parseKey('distrobox:bad name'), null)
assert.deepEqual(commandFor('distrobox:ubuntu'), {
  exe: 'distrobox', args: ['enter', '--name', 'ubuntu'], label: 'Distrobox：ubuntu'
})
assert.deepEqual(commandFor('toolbox:fedora-toolbox-40'), {
  exe: 'toolbox', args: ['enter', 'fedora-toolbox-40'], label: 'Toolbox：fedora-toolbox-40'
})

const listed = listContainersSync({
  hasCommand: (name) => name === 'distrobox' || name === 'toolbox',
  spawnSyncFn: (cmd) => {
    if (cmd === 'distrobox') return { status: 0, stdout: distroboxOut }
    if (cmd === 'toolbox') return { status: 0, stdout: toolboxOut }
    return { status: 1, stdout: '' }
  }
})
assert.deepEqual(listed.map((row) => row.key), ['distrobox:ubuntu', 'distrobox:fedora-dev', 'toolbox:fedora-toolbox-40'])

const store = require('../src/main/terminal/store')
if (process.platform !== 'win32') {
  store.setListLinuxContainers(() => listed)
  const shells = store.availableShells()
  assert.ok(shells.some((s) => s.key === 'bash'))
  assert.ok(shells.some((s) => s.key === 'distrobox:ubuntu' && s.label === 'Distrobox：ubuntu'))
  assert.equal(store.normalizeShell('distrobox:ubuntu'), 'distrobox:ubuntu')
  assert.deepEqual(store.shellDef('distrobox:ubuntu').args, ['enter', '--name', 'ubuntu'])
} else {
  const shells = store.availableShells()
  assert.ok(!shells.some((s) => String(s.key).startsWith('distrobox:')))
  assert.equal(store.normalizeShell('distrobox:ubuntu'), store.DEFAULT_SHELL)
}

const pty = require('../src/main/terminal/pty')
const cmd = pty.shellCommand('distrobox:ubuntu')
if (process.platform !== 'win32') {
  assert.equal(cmd.exe === 'distrobox' || /distrobox$/.test(cmd.exe), true)
  assert.deepEqual(cmd.args, ['enter', '--name', 'ubuntu'])
  assert.equal(cmd.integrated, false)
}
const pwsh = pty.shellCommand('pwsh')
if (process.platform === 'win32') {
  assert.ok(pwsh.args.includes('-NoLogo'))
} else {
  // Linux 沒有 pwsh 時會落到預設 bash，參數必須是空的（不是 PowerShell 那串）
  const bash = pty.shellCommand('bash')
  assert.deepEqual(bash.args, [])
}

console.log('test-linux-containers: all passed')
