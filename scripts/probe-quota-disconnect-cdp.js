/** 隔離打包版：登入來源遺失／恢復、取消顯示、重開。只用假憑證與假 HTTP。 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { tempDir } = require('./lib/test-temp')
const { sanitizeState } = require('../src/main/usage/store')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(fn, label) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(`等待逾時：${label}`)
}

async function connect(url, awaitPromise = true) {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject) })
  let id = 0
  const pending = new Map()
  const errors = []
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data)
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text)
    const call = pending.get(msg.id)
    if (!call) return
    pending.delete(msg.id)
    clearTimeout(call.timer)
    if (msg.error || msg.result.exceptionDetails) call.reject(new Error(JSON.stringify(msg.error || msg.result.exceptionDetails)))
    else call.resolve(msg.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP 逾時：${method}`)) }, 15000)
    pending.set(requestId, { resolve, reject, timer })
    ws.send(JSON.stringify({ id: requestId, method, params }))
  })
  await send('Runtime.enable')
  return { ws, errors, eval: async (expression) => {
    try { return (await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })).result?.value }
    catch (error) { throw new Error(`${error.message} (${expression.slice(0, 120)})`) }
  } }
}

async function main() {
  const dir = tempDir('quota-disconnect-cdp-')
  const homeDir = path.join(dir, 'fake-home')
  fs.mkdirSync(homeDir)
  fs.mkdirSync(path.join(dir, 'project'))
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ sysmonSensors: false, dictationEnabled: false, closeToTray: false }))
  fs.writeFileSync(path.join(dir, 'workspaces.json'), JSON.stringify({ projects: [{ id: 'w_quota_test', name: '額度測試', path: path.join(dir, 'project'), createdAt: Date.now() }] }))
  fs.mkdirSync(path.join(homeDir, '.claude'))
  fs.writeFileSync(path.join(homeDir, '.claude', '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0, subscriptionType: 'pro' }
  }))
  const state = sanitizeState({ accounts: [{ provider: 'claude-code', status: 'disconnected', lastUpdated: new Date().toISOString(), windows: [] }],
    diagnostics: ['[2026-09-29T07:18:27.383Z] claude: API OK windows=2'], lastSyncedAt: Date.now() + 3600_000 })
  state.accounts[0].hasConnected = false // 模擬本機：升級前已失效，舊版不知道曾經連線
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ state }))
  const exe = process.env.AXONDECK_EXE || path.join(__dirname, '../dist/win-unpacked/AxonDeck.exe')
  let child, renderer, mainCdp
  const stop = () => {
    renderer?.ws.close(); mainCdp?.ws.close()
    if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  }
  const start = async () => {
    child = spawn(exe, ['--hidden', `--user-data-dir=${dir}`, '--remote-debugging-port=9262', '--inspect=127.0.0.1:9263'], { stdio: 'ignore' })
    const target = async (port, predicate) => waitFor(async () => {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => [])
      return pages.find(predicate)
    }, `CDP ${port}`)
    mainCdp = await connect((await target(9263, () => true)).webSocketDebuggerUrl, false)
    await mainCdp.eval(`(() => {
      globalThis.__quotaRequire = process.mainModule.require('node:module').createRequire(process.mainModule.require('electron').app.getAppPath() + '/src/main/main.js');
      process.env.USERPROFILE = ${JSON.stringify(homeDir)};
      process.env.HOME = ${JSON.stringify(homeDir)};
      delete process.env.CLAUDE_CONFIG_DIR;
      for (const name of ['CODEX_HOME', 'XDG_DATA_HOME', 'OPENCODE_AUTH_CONTENT', 'OPENCODE_API_KEY', 'OLLAMA_API_KEY']) delete process.env[name];
      const shared = __quotaRequire('./usage/shared');
      for (const [file, method, index] of [['antigravity','syncAntigravity',2], ['grok','syncGrok',4], ['commandcode','syncCommandCode',6]]) {
        __quotaRequire('./usage/' + file)[method] = async () => shared.createInitialAccounts()[index];
      }
      for (const [file, method, key, payload] of [
        ['codex','syncCodex','fake-codex', { rate_limit: { primary_window: { used_percent: 20, reset_at: 1800000000 } } }],
        ['opencode','syncOpenCode','fake-go', { usage: { weekly: { status: 'ok', percent: 40 } } }],
        ['ollama','syncOllama','fake-ollama', { limits: { monthly: { usage: 0.5 } } }]
      ]) {
        const provider = __quotaRequire('./usage/' + file);
        const original = provider[method];
        provider[method] = args => original({ ...args, fetchImpl: async (_url, options) => {
          if (options.headers.Authorization !== 'Bearer ' + key) throw new Error('wrong fixture credential');
          return globalThis.__quotaRejectKeys ? new Response('{}', { status: 401 }) : new Response(JSON.stringify(payload));
        } });
      }
      const claude = __quotaRequire('./usage/claude');
      const original = claude.syncClaude;
      claude.syncClaude = (args) => original({ ...args, fetchImpl: async (_url, options) => {
        if (options.headers.Authorization !== 'Bearer fake-custom') throw new Error('wrong fixture credential');
        return new Response(JSON.stringify({ five_hour: { utilization: 30, resets_at: new Date(Date.now() + 3600_000).toISOString() } }));
      } });
    })()`)
    renderer = await connect((await target(9262, p => p.type === 'page' && /index\.html/.test(p.url))).webSocketDebuggerUrl)
    await waitFor(() => renderer.eval(`document.readyState === 'complete' && !!window.electronAPI`), 'preload')
    await renderer.eval(`document.getElementById('sidebarModeProjects').click()`)
    await waitFor(() => renderer.eval(`!!document.querySelector('#projList [data-id="w_quota_test"] .chat-list-open')`), '測試專案')
    await renderer.eval(`document.querySelector('#projList [data-id="w_quota_test"] .chat-list-open').click()`)
  }
  const claudeState = () => renderer.eval(`(async () => (await window.electronAPI.usage.load()).data.accounts.find(a => a.provider === 'claude-code'))()`)
  const hasChip = () => renderer.eval(`(document.querySelector('#quotaItems .quota-item[data-id="claude-code"]')?.offsetHeight || 0) > 0`)
  const sync = async () => {
    await renderer.eval(`document.getElementById('quotaSyncBtn').click()`)
    await waitFor(() => renderer.eval(`!document.getElementById('quotaSyncBtn').hasAttribute('aria-busy')`), '同步完成')
  }
  try {
    await start()
    await waitFor(hasChip, '升級前已失去登入的舊卡片')
    await sync()
    const lost = await claudeState()
    assert.equal(lost.status, 'disconnected'); assert.equal(lost.hasConnected, true); assert.deepEqual(lost.windows, [])
    assert.equal(await hasChip(), true)
    await renderer.eval(`document.querySelector('#quotaItems .quota-item[data-id="claude-code"] .quota-item-open').click()`)
    assert.match(await renderer.eval(`document.getElementById('quotaPopover').textContent`), /未登入 OAuth/)
    console.log('PASS 升級前登入已清空：依成功歷史恢復卡片、顯示未登入且沒有假額度')
    const toggle = async (enabled) => {
      await renderer.eval(`document.getElementById('quotaSettingsBtn').click(); document.querySelector('#usageProviderToggles input[value="claude-code"]').checked = ${enabled}; document.getElementById('usageSettingsSave').click()`)
      await waitFor(() => renderer.eval(`!document.getElementById('usageSettingsDialog').open`), '設定存檔')
    }
    await toggle(false); assert.equal(await hasChip(), false)
    await toggle(true); assert.equal(await hasChip(), true)
    console.log('PASS 明確取消顯示仍會隱藏，重新勾選即出現')
    assert.equal(await mainCdp.eval(`__quotaRequire('electron').BrowserWindow.getAllWindows().every(w => !w.isVisible())`), true)
    stop(); await start()
    await waitFor(hasChip, '重開後保留卡片')
    await sync(); assert.equal(await hasChip(), true)
    console.log('PASS 重開與再次同步失敗，卡片持續保留')
    const customDir = path.join(homeDir, 'custom')
    fs.mkdirSync(customDir)
    fs.writeFileSync(path.join(customDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-custom', subscriptionType: 'max' } }))
    await mainCdp.eval(`process.env.CLAUDE_CONFIG_DIR = ${JSON.stringify(customDir)}`)
    await sync()
    const restored = await claudeState()
    assert.equal(restored.status, 'available'); assert.equal(restored.planName, 'Claude Max'); assert.equal(restored.windows[0].used, 30)
    assert.equal(await renderer.eval(`document.querySelector('#quotaItems .quota-item[data-id="claude-code"] .quota-meter-value').textContent`), '30%')
    assert.equal(await renderer.eval(`document.querySelectorAll('#quotaItems .quota-item').length`), 1)
    assert.deepEqual(renderer.errors, []); assert.deepEqual(mainCdp.errors, [])
    console.log('PASS 自訂登入來源恢復後畫出 30%，從未連線工具維持隱藏，無未處理例外')
    const codexDir = path.join(homeDir, 'codex-custom')
    const dataDir = path.join(homeDir, 'data-custom')
    fs.mkdirSync(codexDir)
    fs.mkdirSync(path.join(dataDir, 'opencode'), { recursive: true })
    fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fake-codex' } }))
    const auth = { 'opencode-go': { type: 'api', key: 'fake-go' }, 'ollama-cloud': { type: 'api', key: 'fake-ollama' } }
    fs.writeFileSync(path.join(dataDir, 'opencode', 'auth.json'), JSON.stringify(auth))
    await mainCdp.eval(`process.env.CODEX_HOME = ${JSON.stringify(codexDir)}; process.env.XDG_DATA_HOME = ${JSON.stringify(dataDir)}`)
    await sync()
    const meter = provider => renderer.eval(`document.querySelector('#quotaItems .quota-item[data-id="${provider}"] .quota-meter-value')?.textContent`)
    assert.equal(await meter('codex'), '20%'); assert.equal(await meter('opencode-go'), '40%'); assert.equal(await meter('ollama'), '50%')
    console.log('PASS Codex／OpenCode／Ollama 自訂登入資料夾經真 IPC 正確顯示額度')
    fs.unlinkSync(path.join(dataDir, 'opencode', 'auth.json'))
    await mainCdp.eval(`process.env.OPENCODE_AUTH_CONTENT = ${JSON.stringify(JSON.stringify(auth))}`)
    await sync()
    assert.equal(await meter('opencode-go'), '40%'); assert.equal(await meter('ollama'), '50%')
    console.log('PASS OpenCode／Ollama 從環境登入資料取得額度，不需要預設登入檔')
    fs.unlinkSync(path.join(codexDir, 'auth.json'))
    await mainCdp.eval(`globalThis.__quotaRejectKeys = true`)
    await sync()
    const disconnected = await renderer.eval(`(async () => (await window.electronAPI.usage.load()).data.accounts.filter(a => ['codex', 'opencode-go', 'ollama'].includes(a.provider)))()`)
    assert.ok(disconnected.every(a => a.status === 'disconnected' && a.hasConnected && a.windows.length === 0))
    assert.equal(await renderer.eval(`document.querySelectorAll('#quotaItems .quota-item').length`), 4)
    assert.deepEqual(renderer.errors, []); assert.deepEqual(mainCdp.errors, [])
    console.log('PASS Codex 登入檔消失與兩家金鑰被拒絕時，卡片保留且不顯示舊額度')
    console.log('7 passed, 0 failed')
  } finally { stop() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
