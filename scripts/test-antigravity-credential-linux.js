'use strict'

/**
 * Linux Antigravity 憑證退路：secret-tool／檔案；不碰 powershell／CredManager。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { tempDir, removeTree } = require('./lib/test-temp')

const {
  normalizeCredentialBlob,
  parseCredential,
  readAntigravityCredentialLinux
} = require('../src/main/usage/antigravity')
const credential = require('../src/main/agy/credential')

async function main() {
  const canon = JSON.stringify({
    token: {
      access_token: 'AT',
      refresh_token: 'RT',
      expiry: '2099-01-01T00:00:00Z'
    }
  })
  assert.equal(normalizeCredentialBlob(canon), canon)
  const camel = normalizeCredentialBlob(JSON.stringify({
    accessToken: 'AT2',
    refreshToken: 'RT2',
    expiry: '2099-06-01T00:00:00Z'
  }))
  assert.ok(parseCredential(camel))
  assert.equal(parseCredential(camel).accessToken, 'AT2')
  assert.equal(normalizeCredentialBlob('not-json'), null)
  assert.equal(normalizeCredentialBlob('{"auth_method":"consumer"}'), null)

  const home = tempDir('agy-cred-linux')
  try {
    const tokenFile = path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true })
    fs.writeFileSync(tokenFile, canon)

    // secret-tool 失敗 → 讀檔案
    const fromFile = await readAntigravityCredentialLinux({
      homeDir: home,
      execFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
    })
    assert.ok(fromFile)
    assert.equal(parseCredential(fromFile).accessToken, 'AT')

    // secret-tool 成功優先
    const fromSecret = await readAntigravityCredentialLinux({
      homeDir: path.join(home, 'empty-home'),
      execFile: async () => ({ stdout: canon, stderr: '' })
    })
    assert.equal(parseCredential(fromSecret).accessToken, 'AT')

    // 都沒有 → null（明確 disconnected）
    const missing = await readAntigravityCredentialLinux({
      homeDir: path.join(home, 'empty-home'),
      execFile: async () => { throw new Error('missing') }
    })
    assert.equal(missing, null)

    if (process.platform === 'linux') {
      // 真實入口不可呼叫 powershell
      const spawnSync = require('node:child_process').spawnSync
      // 用空 HOME 讓檔案／secret 都失敗；只要不炸、回 null 即可
      const prev = process.env.HOME
      process.env.HOME = path.join(home, 'empty-home')
      try {
        const raw = await require('../src/main/usage/antigravity').readAntigravityCredential()
        assert.equal(raw, null)
      } finally {
        process.env.HOME = prev
      }

      const bin = path.join(home, '.local', 'bin')
      fs.mkdirSync(bin, { recursive: true })
      fs.writeFileSync(path.join(bin, 'agy'), '#!/bin/sh\n', { mode: 0o755 })
      const sources = credential.detectSources({ HOME: home, PATH: '/usr/bin' })
      assert.equal(sources.cli, true)
      assert.equal(sources.ide, false)
      assert.equal(credential.agyCliPath({ HOME: home, PATH: '' }).endsWith(`${path.sep}agy`), true)
      assert.equal(credential.agyCliPath({ HOME: path.join(home, 'nope'), PATH: '' }), '')

      credential.reset()
      const st = await credential.status({
        env: { HOME: path.join(home, 'empty-home') },
        readCredential: async () => null
      })
      assert.equal(st.connected, false)
      assert.equal(st.code, 'NO_CREDENTIAL')
      assert.match(st.message, /Linux|金鑰環|agy/)
    }

    console.log('PASS: Linux Antigravity 憑證退路（secret-tool／檔案／disconnected UI）')
  } finally {
    removeTree(home)
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
