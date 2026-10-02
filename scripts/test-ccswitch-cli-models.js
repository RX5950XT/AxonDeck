'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')
const scan = require('../src/main/ccswitch/models-scan')
const cli = require('../src/main/ccswitch/cli-version')
const credential = require('../src/main/ccswitch/gateway/credential')
const oauth = require('../src/main/ccswitch/gateway/oauth')
const home = tempDir('voiceink-cli-models-')
const originalVersion = cli.runVersion
const bag = new Map()
oauth.configure({ getStore: async () => ({ get: (key, fallback) => bag.get(key) ?? fallback, set: (key, value) => bag.set(key, value) }) })
credential.configure({ homeDir: home })
const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`
const claims = { sub: 'same-user', iss: 'https://auth.x.ai', aud: oauth.FLOWS['grok-build'].clientId, exp: Math.floor(Date.now() / 1000) + 3600 }
const scopedToken = jwt({ ...claims, scope: 'openid grok-cli:access api:access' })
const account = oauth.toAccount(oauth.FLOWS['grok-build'], { access_token: jwt({ ...claims, scope: 'openid profile email offline_access' }), refresh_token: 'app-refresh' })
function writeCli(token) {
  fs.mkdirSync(path.dirname(credential.grokAuthPath()), { recursive: true })
  fs.writeFileSync(credential.grokAuthPath(), JSON.stringify({ account: { key: token, refresh_token: 'cli-refresh', oidc_client_id: claims.aud, user_id: claims.sub } }))
  credential.invalidate('grok-build')
}
const response = (status, model = 'fresh') => ({ ok: status === 200, status, text: async () => JSON.stringify({ data: [{ id: model }] }) })
let failed = 0
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`) } catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`) }
}

async function main() {
  scan.configure({ acquire: async () => ({ token: 'test', accountId: 'account' }) })
  await check('Codex 用目前 CLI 版本查模型；找不到 CLI 才用相容版本', async () => {
    cli.runVersion = async () => '9.8.7'
    const versions = []
    const fetchImpl = async (url) => { versions.push(new URL(url).searchParams.get('client_version')); return response(200) }
    await scan.scanProviderModels({ presetId: 'codex' }, { fetchImpl })
    cli.runVersion = async () => ''
    await scan.scanProviderModels({ presetId: 'codex' }, { fetchImpl })
    assert.deepEqual(versions, ['9.8.7', '0.160.0'])
  })
  await check('Grok 新登入包含模型存取權限', () => {
    assert(oauth.FLOWS['grok-build'].scope.split(' ').includes('grok-cli:access'))
  })
  await oauth.writeAccounts([account])
  await check('Grok 舊登入沿用同一帳號 CLI，保留原帳號與憑證檔', async () => {
    writeCli(scopedToken)
    const before = fs.readFileSync(credential.grokAuthPath(), 'utf8')
    assert.equal((await credential.acquire('grok-build', { oauthAccountId: account.id })).token, scopedToken)
    assert.equal(fs.readFileSync(credential.grokAuthPath(), 'utf8'), before)
    assert.equal((await oauth.readAccounts())[0].accessToken, account.accessToken)
  })
  await check('不同帳號或缺少權限的 CLI 不可借用', async () => {
    for (const token of [jwt({ ...claims, sub: 'other-user', scope: 'grok-cli:access' }), jwt({ ...claims, scope: 'openid' })]) {
      writeCli(token)
      await assert.rejects(credential.acquire('grok-build', { oauthAccountId: account.id }), { code: 'OAUTH_SCOPE_REQUIRED' })
    }
  })
  await check('Grok 過期交給 CLI 續期，不自行輪替 CLI refresh token', async () => {
    writeCli(jwt({ ...claims, exp: 1, scope: 'grok-cli:access' }))
    let cliCalls = 0, httpCalls = 0
    credential.configure({ refreshCli: async (exe, args) => {
      cliCalls++
      assert.equal(exe, path.join(home, '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok'))
      assert.deepEqual(args, ['models'])
      writeCli(scopedToken)
    } })
    const result = await credential.acquire('grok-build', { fetchImpl: async () => { httpCalls++; throw new Error('不可自行換 CLI token') } })
    assert.equal(result.token, scopedToken)
    assert.equal(cliCalls, 1)
    assert.equal(httpCalls, 0)
  })
  await check('CLI 沒換新 token 時回報續期失敗', async () => {
    writeCli(jwt({ ...claims, exp: 1, scope: 'grok-cli:access' }))
    credential.configure({ refreshCli: async () => {} })
    await assert.rejects(credential.acquire('grok-build'), { code: 'TOKEN_REFRESH_FAILED' })
  })
  await check('CLI 模型查詢遇到 401 強制續期一次，403 不重試', async () => {
    const acquired = []
    scan.configure({ acquire: async (provider, options) => { acquired.push(Boolean(options.force)); return { token: options.force ? 'new' : 'old' } } })
    let calls = 0
    const result = await scan.scanProviderModels({ presetId: 'grok-build' }, { fetchImpl: async () => response(++calls === 1 ? 401 : 200) })
    assert(result.ok)
    assert.deepEqual(acquired, [false, true])
    acquired.length = 0
    calls = 0
    const forbidden = await scan.scanProviderModels({ presetId: 'grok-build' }, { fetchImpl: async () => { calls++; return response(403) } })
    assert.equal(forbidden.code, 'HTTP_403')
    assert.equal(calls, 1)
  })
  process.exitCode = failed ? 1 : 0
  console.log(`${7 - failed} passed, ${failed} failed`)
}
main().catch(() => { console.error('測試執行失敗'); process.exitCode = 1 }).finally(() => {
  cli.runVersion = originalVersion
  removeTree(home)
})
