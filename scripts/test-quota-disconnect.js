const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { tempDir } = require('./lib/test-temp')
const { syncClaude } = require('../src/main/usage/claude')
const { syncCodex } = require('../src/main/usage/codex')
const { readOpenCodeAuthKey } = require('../src/main/usage/api-key')
const { mergeAccountState } = require('../src/main/usage')
const { createInitialAccounts, normalizeAccount } = require('../src/main/usage/shared')
const { sanitizeState } = require('../src/main/usage/store')

const tests = []
const test = (name, fn) => tests.push({ name, fn })

function visibleProviders(state) {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/quota-bar.js'), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '')
  const sandbox = { createListReorder: () => ({}) }
  vm.createContext(sandbox)
  vm.runInContext(`${source}\nglobalThis.pick = (next) => { state = next; return visibleAccounts().map(a => a.provider) }`, sandbox)
  return Array.from(sandbox.pick(state))
}

test('曾經連線的 Claude 登入檔消失，卡片仍在而且不顯示假額度', async () => {
  const homeDir = tempDir('quota-disconnect-')
  const previous = normalizeAccount({ ...createInitialAccounts()[0], status: 'available',
    windows: [{ id: 'claude-5h', kind: 'rolling-5h', used: 25, limit: 100 }] })
  const disconnected = await syncClaude({ homeDir, env: {} })
  const merged = mergeAccountState(disconnected, previous)
  assert.equal(merged.status, 'disconnected')
  assert.deepEqual(merged.windows, [])
  assert.match(merged.notes, /憑證/)
  const saved = sanitizeState({ accounts: [merged] })
  assert.deepEqual(visibleProviders(saved), ['claude-code'])
  const again = sanitizeState({ accounts: [mergeAccountState(disconnected, saved.accounts[0])] })
  assert.deepEqual(visibleProviders(again), ['claude-code'], '重開與再次失敗不能讓卡片消失')
  assert.deepEqual(visibleProviders({ ...again, settings: { ...again.settings, visibleProviders: [] } }), [])
})

test('從未連線的工具仍可隱藏；關閉隱藏時全部顯示', () => {
  const initial = sanitizeState(null)
  assert.deepEqual(visibleProviders(initial), [])
  const all = { ...initial, settings: { ...initial.settings, bar: { ...initial.settings.bar, hideDisconnected: false } } }
  assert.equal(visibleProviders(all).length, 7)
})

test('升級前已失去 Claude 登入，依成功診斷恢復曾連線狀態而不補假額度', async () => {
  const homeDir = tempDir('quota-upgrade-')
  fs.mkdirSync(path.join(homeDir, '.claude'))
  fs.writeFileSync(path.join(homeDir, '.claude', '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0, subscriptionType: 'pro' }
  }))
  const disconnected = await syncClaude({ homeDir, env: {}, fetchImpl: async () => { throw new Error('未登入不能打 API') } })
  for (const hasConnected of [undefined, false]) {
    const raw = { accounts: [{ ...disconnected, hasConnected }], diagnostics: [
      '[2026-09-29T07:18:27.383Z] claude: API OK windows=2'
    ] }
    const before = JSON.stringify(raw)
    const saved = sanitizeState(raw)
    assert.equal(JSON.stringify(raw), before, '不修改輸入資料')
    assert.equal(saved.accounts[0].hasConnected, true)
    assert.equal(saved.accounts[0].status, 'disconnected')
    assert.deepEqual(saved.accounts[0].windows, [])
    assert.deepEqual(visibleProviders(saved), ['claude-code'])
    const next = sanitizeState({ ...saved, accounts: [mergeAccountState(disconnected, saved.accounts[0])], diagnostics: [] })
    assert.deepEqual(visibleProviders(next), ['claude-code'], '診斷輪替後仍保留卡片')
    assert.deepEqual(visibleProviders({ ...next, settings: { ...next.settings, visibleProviders: [] } }), [])
  }
  for (const diagnostics of [null, [123], ['[2026-09-29] claude: API failed HTTP 401'], ['[2026-09-29] codex: API OK windows=2']]) {
    const saved = sanitizeState({ accounts: [disconnected], diagnostics })
    assert.deepEqual(visibleProviders(saved), [], '失敗或其他工具的診斷不能算 Claude 曾連線')
  }
})

test('七家工具登入失效後都保留卡片，明確取消勾選仍隱藏', () => {
  const accounts = createInitialAccounts().map(account => mergeAccountState(account, { ...account, status: 'available' }))
  const saved = sanitizeState({ accounts })
  assert.equal(visibleProviders(saved).length, 7)
  assert.ok(saved.accounts.every(account => account.status === 'disconnected' && account.windows.length === 0))
  assert.deepEqual(visibleProviders({ ...saved, settings: { ...saved.settings, visibleProviders: ['codex'] } }), ['codex'])
})

test('Codex 額度跟隨 CODEX_HOME，不讀另一個預設帳號，也不修改憑證', async () => {
  const homeDir = tempDir('quota-codex-home-')
  const customDir = path.join(homeDir, 'custom')
  fs.mkdirSync(path.join(homeDir, '.codex'))
  fs.mkdirSync(customDir)
  const files = [path.join(homeDir, '.codex', 'auth.json'), path.join(customDir, 'auth.json')]
  for (const [index, file] of files.entries()) fs.writeFileSync(file, JSON.stringify({ tokens: { access_token: index ? 'custom-codex' : 'default-codex' } }))
  const before = files.map(file => fs.readFileSync(file, 'utf8'))
  let calls = 0
  const fetchImpl = async (_url, options) => {
    calls++
    assert.equal(options.headers.Authorization, 'Bearer custom-codex')
    return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 20, reset_at: 1800000000 } } }))
  }
  const account = await syncCodex({ homeDir, env: { CODEX_HOME: customDir }, fetchImpl })
  assert.equal(account.windows[0]?.used, 20)
  const missing = await syncCodex({ homeDir, env: { CODEX_HOME: path.join(homeDir, 'missing') }, fetchImpl })
  assert.equal(missing.status, 'disconnected')
  assert.equal(calls, 1)
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), before)
})

test('OpenCode 與 Ollama 跟隨 XDG_DATA_HOME，不讀另一份預設金鑰', async () => {
  const homeDir = tempDir('quota-opencode-home-')
  const dataDir = path.join(homeDir, 'custom-data')
  for (const dir of [path.join(homeDir, '.local', 'share', 'opencode'), path.join(dataDir, 'opencode')]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
      'opencode-go': { type: 'api', key: dir.startsWith(dataDir) ? 'custom-go' : 'default-go' },
      'ollama-cloud': { type: 'api', key: dir.startsWith(dataDir) ? 'custom-ollama' : 'default-ollama' }
    }))
  }
  assert.equal(await readOpenCodeAuthKey(homeDir, 'opencode-go', { XDG_DATA_HOME: dataDir }), 'custom-go')
  assert.equal(await readOpenCodeAuthKey(homeDir, 'ollama-cloud', { XDG_DATA_HOME: dataDir }), 'custom-ollama')
  assert.equal(await readOpenCodeAuthKey(homeDir, 'opencode-go', { XDG_DATA_HOME: path.join(homeDir, 'missing') }), '')
  assert.equal(await readOpenCodeAuthKey(homeDir, 'opencode-go', { XDG_DATA_HOME: 'relative' }), 'default-go')
  for (const [module, method, key, payload] of [
    ['opencode', 'syncOpenCode', 'custom-go', { usage: { weekly: { status: 'ok', percent: 40 } } }],
    ['ollama', 'syncOllama', 'custom-ollama', { limits: { monthly: { usage: 0.4 } } }]
  ]) {
    const account = await require(`../src/main/usage/${module}`)[method]({ homeDir, env: { XDG_DATA_HOME: dataDir },
      fetchImpl: async (_url, options) => {
        assert.equal(options.headers.Authorization, `Bearer ${key}`)
        return new Response(JSON.stringify(payload))
      }
    })
    assert.equal(account.windows[0]?.used, 40)
  }
})

test('OpenCode 提供的環境登入資料優先於檔案，空表不拿舊金鑰', async () => {
  const homeDir = tempDir('quota-opencode-env-')
  const dir = path.join(homeDir, '.local', 'share', 'opencode')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ 'opencode-go': { key: 'old-file' } }))
  assert.equal(await readOpenCodeAuthKey(homeDir, 'opencode-go', { OPENCODE_AUTH_CONTENT: JSON.stringify({ 'opencode-go': { type: 'api', key: 'env-go' } }) }), 'env-go')
  assert.equal(await readOpenCodeAuthKey(homeDir, 'opencode-go', { OPENCODE_AUTH_CONTENT: '{}' }), '')
  assert.equal(await readOpenCodeAuthKey(homeDir, 'opencode-go', { OPENCODE_AUTH_CONTENT: 'bad-json' }), 'old-file')
  for (const content of ['null', '[]', '"text"', ' '.repeat(require('../src/main/usage/constants').FILE_MAX_BYTES + 1)]) {
    assert.equal(await readOpenCodeAuthKey(homeDir, 'opencode-go', { OPENCODE_AUTH_CONTENT: content }), '')
  }
})

test('CLAUDE_CONFIG_DIR 的登入與續期使用同一份檔案和鎖，不碰預設帳號', async () => {
  const homeDir = tempDir('quota-config-')
  const configDir = path.join(homeDir, 'custom-claude')
  fs.mkdirSync(configDir)
  fs.mkdirSync(path.join(homeDir, '.claude'))
  const defaultFile = path.join(homeDir, '.claude', '.credentials.json')
  fs.writeFileSync(defaultFile, JSON.stringify({ claudeAiOauth: { accessToken: 'default-account' } }))
  const original = fs.readFileSync(defaultFile, 'utf8')
  const customFile = path.join(configDir, '.credentials.json')
  fs.writeFileSync(customFile, JSON.stringify({ mcpOAuth: { keep: true }, claudeAiOauth: {
    accessToken: 'custom-old', refreshToken: 'custom-refresh', expiresAt: Date.now() - 1000,
    scopes: ['user:profile', 'user:inference'], subscriptionType: 'max'
  } }))
  let requests = 0
  let refreshes = 0
  const account = await syncClaude({ homeDir, env: { CLAUDE_CONFIG_DIR: configDir },
    authFetchImpl: async (_url, options) => {
      refreshes++
      assert.equal(JSON.parse(options.body).refresh_token, 'custom-refresh')
      assert.ok(fs.existsSync(path.join(configDir, '.oauth_refresh.lock')))
      assert.ok(fs.existsSync(`${fs.realpathSync(configDir)}.lock`))
      return new Response(JSON.stringify({ access_token: 'custom-new', refresh_token: 'custom-next', expires_in: 28800 }))
    },
    fetchImpl: async (_url, options) => {
      requests++
      assert.equal(options.headers.Authorization, 'Bearer custom-new')
      return new Response(JSON.stringify({ five_hour: { utilization: 30, resets_at: new Date(Date.now() + 3600_000).toISOString() } }))
    }
  })
  assert.equal(refreshes, 1)
  assert.equal(requests, 1)
  assert.equal(account.planName, 'Claude Max')
  assert.equal(account.windows[0].used, 30)
  assert.equal(fs.readFileSync(defaultFile, 'utf8'), original)
  const updated = JSON.parse(fs.readFileSync(customFile, 'utf8'))
  assert.equal(updated.claudeAiOauth.refreshToken, 'custom-next')
  assert.deepEqual(updated.mcpOAuth, { keep: true })
  assert.ok(!fs.existsSync(path.join(configDir, '.oauth_refresh.lock')))
  assert.ok(!fs.existsSync(`${fs.realpathSync(configDir)}.lock`))
})

test('自訂登入資料夾未登入時，不誤用預設資料夾的另一個帳號', async () => {
  const homeDir = tempDir('quota-config-missing-')
  fs.mkdirSync(path.join(homeDir, '.claude'))
  fs.writeFileSync(path.join(homeDir, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'other-account' } }))
  let requests = 0
  const account = await syncClaude({ homeDir, env: { CLAUDE_CONFIG_DIR: path.join(homeDir, 'missing') },
    fetchImpl: async () => { requests++; return new Response('{}') }
  })
  assert.equal(account.status, 'disconnected')
  assert.equal(requests, 0)
})

;(async () => {
  let passed = 0
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log(`PASS ${name}`) }
    catch (error) { console.error(`FAIL ${name}: ${error.stack}`) }
  }
  console.log(`${passed}/${tests.length} passed`)
  process.exitCode = passed === tests.length ? 0 : 1
})()
