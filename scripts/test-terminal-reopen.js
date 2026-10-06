'use strict'
/**
 * 終端機開到一半被別的導覽蓋掉：分頁要留著，對話載入回來也不准把工作區收起來。
 *   node scripts/test-terminal-reopen.js
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')

function load(rel, context, tail) {
  const source = fs.readFileSync(path.join(root, rel), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export \{[^}]*\}\s*$/gm, '')
    .replace(/^export /gm, '')
  vm.createContext(context)
  vm.runInContext(`${source}\n;${tail}`, context)
}

const openSession = fs.readFileSync(path.join(root, 'src/renderer/scripts/terminal-page.js'), 'utf8')
const openBody = openSession.slice(openSession.indexOf('async function openSession'), openSession.indexOf('function fitPane'))
const trackAt = openBody.indexOf('trackTerminal(')
const openAt = openBody.indexOf('electronAPI.terminal.open')
assert.ok(trackAt !== -1 && openAt !== -1 && trackAt < openAt, '開終端機要先掛上分頁，再等 PTY')

let epoch = 0
const modes = []
let releaseGet
const chat = {
  console,
  setTimeout,
  clearTimeout,
  document: {
    getElementById: () => null,
    addEventListener() {},
    querySelectorAll: () => []
  },
  showToast() {},
  noteLocation() {},
  cleanIpcError: (e) => e,
  openSettingsPage() {},
  setChatPaneMode(mode) { modes.push(mode) },
  getChatPaneEpoch: () => epoch,
  electronAPI: {
    chat: {
      get: () => new Promise((resolve) => { releaseGet = resolve }),
      onDelta() {},
      onTitle() {}
    },
    store: { get: async () => null }
  }
}
load('src/renderer/scripts/chat-page.js', chat, 'this.openConversation = openConversation')

chatRace().then(() => {
  const tabs = fs.readFileSync(path.join(root, 'src/renderer/scripts/ws-tabs.js'), 'utf8')
  const pickSrc = tabs.slice(tabs.indexOf('function pickRestoredTab'), tabs.indexOf('async function restoreProjectTabs'))
  const pick = {}
  vm.createContext(pick)
  vm.runInContext(`${pickSrc}\n;this.pick = pickRestoredTab`, pick)
  assert.equal(pick.pick('codex', 'grok', ['grok', 'codex']), 'codex', '還原途中剛開的終端機要留在畫面上')
  assert.equal(pick.pick('', 'grok', ['grok', 'codex']), 'grok', '沒有人中途開分頁才回到上次那個')
  assert.equal(pick.pick('', '', []), '', '什麼都沒有就維持空的')
  console.log('PASS 終端機開啟途中不被收掉')
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})

async function chatRace() {
  const pending = chat.openConversation('c1')
  epoch += 1
  releaseGet({ id: 'c1', messages: [], web: false })
  await pending
  assert.deepEqual(modes, [], '等對話資料時使用者已經切去工作區，不准再把終端機蓋掉')
}
