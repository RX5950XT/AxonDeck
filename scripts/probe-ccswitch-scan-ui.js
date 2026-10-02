#!/usr/bin/env node
/**
 * VoiceInk — 打包版五家模型每日自動更新的實機 probe（背景 CDP）
 *
 * 唯讀複製已存供應商到隔離 profile，清掉副本掃描時間；進 CC代理後讓 main 自動
 * 打真實 GET /models，再逐家開編輯窗確認四格下拉保留完整清單、lab 分組與排序。不啟用供應商、
 * 不改 ~/.claude/settings.json、不改使用中的 profile。暫存憑證隨 profile 收掉。
 *
 *     node scripts/probe-ccswitch-scan-ui.js
 */

'use strict'

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')
const http = require('http')
const assert = require('assert/strict')

const PORT = 9253
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = tempDir('voiceink-probe-scan-')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    request.setTimeout(2_000, () => request.destroy(new Error('CDP HTTP 逾時')))
    request.on('error', reject)
  })
}

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
  }

  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', () => reject(new Error('CDP WebSocket 連不上')))
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    await this.send('Runtime.enable')
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result?.value
  }

  close() {
    try { this.ws.close() } catch { /* 已斷線 */ }
  }
}

function stopTestApp(child) {
  if (child?.pid) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ }
  }
  try {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='VoiceInk.exe'" |` +
      ` Where-Object { $_.CommandLine -like '*${USER_DATA_DIR}*' } |` +
      ' ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
    ], { stdio: 'ignore' })
  } catch { /* 沒有殘留 */ }
}

async function checkGroups(cdp, item, models) {
  const snapshot = await cdp.eval(`(() => {
    const ids = ['ccModelSelect', 'ccHaikuSelect', 'ccSonnetSelect', 'ccOpusSelect'];
    return { values: ids.map(id => [...document.getElementById(id).options].map(option => option.value).filter(Boolean)),
      drafts: ['ccModelInput', 'ccHaikuInput', 'ccSonnetInput', 'ccOpusInput'].map(id => document.getElementById(id).value),
      groups: [...document.getElementById('ccModelSelect').querySelectorAll('optgroup')]
        .map(group => ({ label: group.label, values: [...group.children].map(option => option.value) })) };
  })()`)
  for (const values of snapshot.values) {
    assert.deepEqual([...values].sort(), [...models].sort(), `${item.presetId} 保留全部 API 模型 ID`)
    assert.deepEqual(values, snapshot.values[0], '四格順序一致')
  }
  assert.deepEqual(snapshot.drafts, ['model', 'haikuModel', 'sonnetModel', 'opusModel'].map(key => item[key] || ''), '保留原本設定')
  if (!['commandcode', 'ollama-cloud', 'opencode-go'].includes(item.presetId)) return
  assert(snapshot.groups.length > 1, '多 lab 清單必須分組')
  assert.equal(snapshot.groups[0].label, item.presetId === 'commandcode' ? 'Anthropic' : 'OpenAI', '主流 lab 在前')
  for (const [newer, older] of [['gpt-6.1-sol', 'gpt-5.6-luna'], ['claude-sonnet-5-5', 'claude-opus-4-8'],
    ['Qwen/Qwen3.8-Max', 'Qwen/Qwen3.7-Max'], ['qwen3.8-max', 'qwen3.7-max'], ['kimi-k3', 'kimi-k2.6'],
    ['moonshotai/Kimi-K3', 'moonshotai/Kimi-K2.6'], ['minimax-m3', 'minimax-m2.7'], ['glm-5.3', 'glm-5.2']]) {
    if (models.includes(newer) && models.includes(older)) assert(snapshot.values[0].indexOf(newer) < snapshot.values[0].indexOf(older), `${newer} 在 ${older} 前面`)
  }
  await checkMenu(cdp, item.presetId, snapshot.groups)
  console.log(`PASS ${item.presetId}: ${snapshot.groups.length} 個 lab 分組、世代排序、深淺色、跨組鍵盤選取`)
}

async function checkMenu(cdp, presetId, groups) {
  await cdp.eval(`(() => {
    if (document.querySelector('.custom-select[data-select-id="ccModelSelect"]').classList.contains('hidden')) document.getElementById('ccManualModelsBtn').click();
    const select = document.getElementById('ccModelSelect'); select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('.custom-select-trigger[data-select-id="ccModelSelect"]').click();
  })()`)
  const menu = await cdp.eval(`(() => {
    const menu = document.getElementById('ccModelSelectMenu'); const rect = menu.getBoundingClientRect();
    return { labels: [...menu.querySelectorAll('[role="group"]')].map(group => group.getAttribute('aria-label')),
      values: [...menu.querySelectorAll('[role="option"]')].map(option => option.dataset.value).filter(Boolean),
      inside: !menu.hidden && rect.width > 0 && rect.top >= 0 && rect.bottom <= innerHeight };
  })()`)
  assert.deepEqual(menu.labels, groups.map(group => group.label), '畫面分組與原生 optgroup 相同')
  assert.deepEqual(menu.values, groups.flatMap(group => group.values), '畫面模型順序完整')
  assert(menu.inside, '選單可見且未超出視窗')
  const output = path.join(__dirname, '..', 'dist', 'qa')
  fs.mkdirSync(output, { recursive: true })
  for (const theme of ['dark', 'light']) {
    await cdp.eval(`document.documentElement.setAttribute('data-theme', '${theme}')`)
    await sleep(200)
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(output, `cc-model-groups-${presetId}-${theme}.png`), Buffer.from(screenshot.data, 'base64'))
  }
  const selected = await cdp.eval(`(() => {
    const trigger = document.querySelector('.custom-select-trigger[data-select-id="ccModelSelect"]');
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const select = document.getElementById('ccModelSelect'); select.value = ${JSON.stringify(groups[0].values.at(-1))};
    select.dispatchEvent(new Event('change', { bubbles: true })); trigger.click();
    for (const key of ['ArrowDown', 'Enter']) trigger.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    return select.value;
  })()`)
  assert.equal(selected, groups[1].values[0], '鍵盤跳過分組標題，選到下一組第一個模型')
}

async function main() {
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'voiceink', 'cc-providers.json'), 'utf8'))
  const ids = ['codex', 'grok-build', 'commandcode', 'ollama-cloud', 'opencode-go']
  const providers = saved.providers.filter((item) => ids.includes(item.presetId))
    .map((item) => ({ ...item, availableModels: null, modelsCheckedAt: 0 }))
  if (!ids.every((id) => providers.some((item) => item.presetId === id))) throw new Error('已存供應商缺少待驗證項目')
  fs.writeFileSync(path.join(USER_DATA_DIR, 'cc-providers.json'), JSON.stringify({ providers, oauthAccounts: saved.oauthAccounts }))
  const child = spawn(EXE, ['--hidden', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], {
    stdio: 'ignore', detached: false, windowsHide: true
  })
  let cdp = null
  try {
    let target
    for (let i = 0; i < 60; i++) {
      await sleep(500)
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => [])
      target = list.find((item) => item.type === 'page' && item.url.includes('index.html'))
      if (target) break
    }
    if (!target) throw new Error('等不到主視窗')
    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.eval('document.querySelector(\'[data-page="ccswitch"]\').click()')
    let snapshot = []
    for (let i = 0; i < 80; i++) {
      const result = await cdp.eval('window.electronAPI.ccswitch.listProviders()')
      snapshot = result.data?.providers || []
      if (providers.every((item) => snapshot.find((entry) => entry.id === item.id)?.availableModels?.length > 0)) break
      await sleep(500)
    }
    // 等 renderer 自己讀到更新，不用手動掃描補救；poll 僅在記憶體裡比對。
    await cdp.eval('document.querySelector(\'[data-page="chat"]\').click()')
    await cdp.eval('document.querySelector(\'[data-page="ccswitch"]\').click()')
    await sleep(1000)
    for (const item of providers) {
      const models = snapshot.find((entry) => entry.id === item.id)?.availableModels
      if (!models?.length) throw new Error(`${item.presetId} 自動更新未成功`)
      if (item.presetId === 'codex' && !models.includes('gpt-6.1-sol')) throw new Error('Codex 仍被舊版本過濾')
      await cdp.eval(`document.querySelector('#ccProviderList .cc-tile[data-id="${item.id}"] .cc-tile-edit').click()`)
      await checkGroups(cdp, item, models)
      console.log(`PASS ${item.presetId}: 自動更新 ${models.length} 個模型，四格下拉一致`)
      await cdp.eval("document.getElementById('ccProviderDialog').close()")
    }
    console.log('PASS 五家真實 API → 每日自動更新 → 打包版下拉；三家多 lab 分組；隔離 profile')
  } finally {
    cdp?.close()
    stopTestApp(child)
    try { removeTree(USER_DATA_DIR) } catch { /* 慢慢釋放 */ }
  }
}

main().catch((error) => {
  console.error(String(error.message))
  process.exitCode = 1
})
