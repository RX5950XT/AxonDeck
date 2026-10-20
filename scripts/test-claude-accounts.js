#!/usr/bin/env node
/**
 * Claude 官方訂閱多帳號（`src/main/usage/claude-accounts.js`）：`node scripts/test-claude-accounts.js`
 *
 * 全部在暫存的假家目錄裡跑，store／spawn／fetch 一律 mock——**不碰使用者真的 `~/.claude`**。
 *
 *  [A] 清單會把使用中的登入抄進來；CLI 換登入另一個人，兩個都留著、使用中跟著換
 *  [B] 切換：先抄回使用中的最新 token，再寫目標；`mcpOAuth` 與 `.claude.json` 其他欄位原樣保留
 *  [C] 使用中的不能移除，沒在用的可以
 *  [D] 額度：沒在用的帳號快過期就自己續、寫回快照、拿新 token 查；使用中的沿用 syncClaude 的結果
 *  [E] 新增帳號：在暫存 CLAUDE_CONFIG_DIR 跑 `claude auth login`，登完抄進來，使用中的登入不動
 */

'use strict'

const assert = require('assert/strict')
const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const { tempDir } = require('./lib/test-temp')

const accounts = require('../src/main/usage/claude-accounts')
const auth = require('../src/main/usage/claude-auth')

let passed = 0
let failed = 0
async function test(name, fn) {
  accounts.resetForTests()
  auth._resetForTests()
  const data = {}
  accounts.configure({ getStore: async () => ({ get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v } }) })
  try {
    await fn(data)
    passed++
    console.log(`  PASS ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${name} — ${error.stack}`)
  }
}

const env = {}
const oauth = (who, extra = {}) => ({
  accessToken: `${who}-access`, refreshToken: `${who}-refresh`, expiresAt: Date.now() + 3600_000,
  scopes: ['user:inference'], subscriptionType: who === 'a' ? 'pro' : 'max', ...extra
})
const identity = (who) => ({ accountUuid: `uuid-${who}`, emailAddress: `${who}@x.com`, organizationName: `${who} org` })

function makeHome() {
  const home = tempDir('claude-accounts-')
  fs.mkdirSync(path.join(home, '.claude'))
  return home
}
function login(home, who, extra) {
  const credsFile = path.join(home, '.claude', '.credentials.json')
  const creds = fs.existsSync(credsFile) ? JSON.parse(fs.readFileSync(credsFile, 'utf8')) : { mcpOAuth: { keep: 'me' } }
  fs.writeFileSync(credsFile, JSON.stringify({ ...creds, claudeAiOauth: oauth(who, extra) }))
  const configFile = path.join(home, '.claude.json')
  const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : { projects: { keep: true } }
  fs.writeFileSync(configFile, JSON.stringify({ ...config, oauthAccount: identity(who) }))
}
const readCreds = (home) => JSON.parse(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8'))
const readConfig = (home) => JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))

;(async () => {
  console.log('claude-accounts')

  await test('[A] 清單抄進使用中的登入，換人後兩個都在', async () => {
    const home = makeHome()
    login(home, 'a')
    let list = await accounts.list({ homeDir: home, env })
    assert.deepEqual(list.map((x) => [x.email, x.active]), [['a@x.com', true]])
    assert.equal(list[0].planName, 'Claude Pro')
    assert.equal(JSON.stringify(list).includes('access'), false, '清單不能帶 token')
    login(home, 'b')
    list = await accounts.list({ homeDir: home, env })
    assert.deepEqual(list.map((x) => [x.email, x.active]), [['b@x.com', true], ['a@x.com', false]])
  })

  await test('[B] 切換寫回目標、保留其他欄位、先抄回最新 token', async (data) => {
    const home = makeHome()
    login(home, 'a')
    await accounts.list({ homeDir: home, env })
    login(home, 'b')
    await accounts.list({ homeDir: home, env })
    // CLI 在背景把 b 續期了（refresh token 輪替），我們還沒抄
    login(home, 'b', { accessToken: 'b-access-2', refreshToken: 'b-refresh-2' })
    const result = await accounts.switchTo('uuid-a', { homeDir: home, env })
    assert.equal(result.active, true)
    assert.equal(readCreds(home).claudeAiOauth.accessToken, 'a-access')
    assert.deepEqual(readCreds(home).mcpOAuth, { keep: 'me' })
    assert.equal(readConfig(home).oauthAccount.accountUuid, 'uuid-a')
    assert.deepEqual(readConfig(home).projects, { keep: true })
    const b = data.accounts.find((x) => x.id === 'uuid-b')
    assert.equal(b.oauth.refreshToken, 'b-refresh-2', '切走前要抄回最新那一代')
    // 鎖要放掉
    assert.equal(fs.existsSync(path.join(home, '.claude', '.oauth_refresh.lock')), false)
    await assert.rejects(accounts.switchTo('nope', { homeDir: home, env }), { code: 'NO_ACCOUNT' })
  })

  await test('[C] 使用中的不能移除', async () => {
    const home = makeHome()
    login(home, 'a')
    await accounts.list({ homeDir: home, env })
    login(home, 'b')
    await accounts.list({ homeDir: home, env })
    await assert.rejects(accounts.remove('uuid-b', { homeDir: home, env }), { code: 'ACTIVE_ACCOUNT' })
    await accounts.remove('uuid-a', { homeDir: home, env })
    assert.deepEqual((await accounts.list({ homeDir: home, env })).map((x) => x.id), ['uuid-b'])
  })

  await test('[D] 沒在用的帳號快過期就自己續，拿新 token 查額度', async (data) => {
    const home = makeHome()
    login(home, 'a', { expiresAt: Date.now() + 60_000 })
    await accounts.list({ homeDir: home, env })
    login(home, 'b')
    const refreshBodies = []
    const authFetchImpl = async (url, init) => {
      refreshBodies.push(JSON.parse(init.body))
      return { ok: true, status: 200, json: async () => ({ access_token: 'a-new', refresh_token: 'a-refresh-new', expires_in: 3600 }) }
    }
    const seen = []
    const fetchImpl = async (url, init) => {
      seen.push(init.headers.Authorization)
      return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3600_000).toISOString() } }) }
    }
    const active = { provider: 'claude-code', planName: 'Claude Max', status: 'available', windows: [{ id: 'claude-5h', kind: 'rolling-5h', used: 7, limit: 100 }], notes: '', lastUpdated: new Date().toISOString() }
    const out = await accounts.withProfiles(active, { homeDir: home, env, nowMs: Date.now(), fetchImpl, authFetchImpl })
    assert.equal(out.profiles.length, 2)
    const [b, a] = out.profiles
    assert.equal(a.active, false)
    assert.equal(a.windows[0].used, 42)
    assert.equal(b.active, true)
    assert.equal(b.windows[0].used, 7)
    assert.equal(refreshBodies[0].refresh_token, 'a-refresh')
    assert.deepEqual(seen, ['Bearer a-new'])
    assert.equal(data.accounts.find((x) => x.id === 'uuid-a').oauth.refreshToken, 'a-refresh-new', '續完要寫回快照')
    assert.equal(readCreds(home).claudeAiOauth.accessToken, 'b-access', '使用中的檔案不能動')
    // 只有一個帳號：卡片原樣不掛 profiles
    const single = makeHome()
    login(single, 'a')
    accounts.resetForTests()
    const solo = {}
    accounts.configure({ getStore: async () => ({ get: (k, d) => (k in solo ? solo[k] : d), set: (k, v) => { solo[k] = v } }) })
    assert.equal((await accounts.withProfiles(active, { homeDir: single, env, nowMs: Date.now() })).profiles, undefined)
  })

  await test('[E] 新增帳號走隔離資料夾的 claude auth login', async () => {
    const home = makeHome()
    login(home, 'a')
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(home, '.local', 'bin', 'claude.exe'), '')
    let spawned = null
    accounts.configure({
      spawnImpl: (exe, args, options) => {
        spawned = { exe, args, options }
        const child = new EventEmitter()
        child.kill = () => child.emit('exit', 1)
        setImmediate(() => {
          const dir = options.env.CLAUDE_CONFIG_DIR
          fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth('c') }))
          fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: identity('c') }))
          child.emit('exit', 0)
        })
        return child
      }
    })
    const added = await accounts.beginLogin({ homeDir: home, env })
    assert.deepEqual(spawned.args, ['auth', 'login', '--claudeai'])
    assert.equal(spawned.options.stdio, 'ignore')
    assert.equal(added.email, 'c@x.com')
    assert.equal(added.active, false)
    assert.equal(fs.existsSync(spawned.options.env.CLAUDE_CONFIG_DIR), false, '暫存資料夾要刪掉')
    assert.equal(readCreds(home).claudeAiOauth.accessToken, 'a-access', '使用中的登入不動')
    assert.deepEqual((await accounts.list({ homeDir: home, env })).map((x) => x.email).sort(), ['a@x.com', 'c@x.com'])
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
