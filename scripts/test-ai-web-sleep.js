/** npx electron scripts/test-ai-web-sleep.js — 真實 webview：閒置網頁版對話只在重開後長得一樣時才收；隔離資料、不連外。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, session } = require('electron')
const { tempDir } = require('./lib/test-temp')

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.setPath('userData', tempDir('ai-web-sleep-'))
const root = tempDir('ai-web-sleep-fixture-')
const timeout = setTimeout(() => { console.error('FAIL 網頁版休眠逾時'); app.exit(1) }, 45000)
const HOUR = 60 * 60 * 1000

const FIXTURE = `<!doctype html><body style="margin:0"><main style="height:300px;overflow:auto" id="m"><div style="height:3000px"></div></main>
<textarea id="box"></textarea><script>
  const m = document.getElementById('m')
  m.scrollTop = m.scrollHeight
  window.token = Math.random()
</script>`

async function run() {
  session.fromPartition('persist:ai-chatgpt').protocol.handle('https', () =>
    new Response(FIXTURE, { headers: { 'content-type': 'text/html' } }))
  const source = fs.readFileSync(path.resolve(__dirname, '../src/renderer/scripts/ai-web-page.js'), 'utf8')
    .replace("import { electronAPI, setChatPaneMode } from './app.js'", `
      const electronAPI = { chat: { setWebUrl: async () => {}, setWebTitle: async () => false } }
      const setChatPaneMode = () => { void showAiWeb() }`)
  fs.writeFileSync(path.join(root, 'ai-web.mjs'), source)
  fs.writeFileSync(path.join(root, 'page.html'), `<div id="aiWebMain" style="width:800px;height:600px;display:flex"></div>
    <style>.ai-web-pane { flex:1; display:flex } .ai-web-pane[hidden] { display:none } webview { flex:1 }</style>
    <script type="module">
      import * as mod from './ai-web.mjs'
      window.mod = mod
      window.ready = true
    </script>`)
  const win = new BrowserWindow({ width: 900, height: 700, x: -3000, y: -3000, show: false, webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true } })
  win.setPosition(-3000, -3000)
  win.showInactive()
  await win.loadFile(path.join(root, 'page.html'))
  const evaluate = (code) => win.webContents.executeJavaScript(code)
  const until = async (code) => {
    const deadline = Date.now() + 8000
    while (!await evaluate(code)) {
      if (Date.now() > deadline) throw new Error(`未符合：${code}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  await until('window.ready')
  const open = (id) => evaluate(`mod.openAiWeb({ id: '${id}', web: { site: 'chatgpt', url: 'https://chatgpt.com/c/${id}' } }, () => {}, (cid, state) => { (window.statusLog ||= []).push([cid, state]) })`)
  const guest = (id) => `document.querySelector('[data-conv-id="${id}"] webview')`
  const ready = (id) => until(`(() => { const v = ${guest(id)}; try { return v && !v.isLoading() && v.getURL().startsWith('https:') } catch { return false } })()`)
  const inGuest = (id, code) => evaluate(`${guest(id)}.executeJavaScript(${JSON.stringify(code)})`)
  const sleep = (extra = 2 * HOUR) => evaluate(`mod.sleepIdleAiWeb(Date.now() + ${extra})`)

  for (const id of ['draft', 'scrolled', 'clean', 'recent']) {
    await open(id)
    await ready(id)
  }
  await open('recent') // 切一輪，每則都有切走時間；現在顯示 recent
  await inGuest('draft', `document.getElementById('box').value = '打到一半'`)
  await inGuest('scrolled', `document.getElementById('m').scrollTop = 0`)
  assert.equal(await evaluate('document.querySelector(\'[data-conv-id="clean"]\').hidden'), true)

  assert.equal(await sleep(1000), 0, '還沒滿 1 小時不收')
  assert.equal(await sleep(), 1, '只收重開後長得一樣的那則')
  assert.equal(await evaluate(`!${guest('clean')}`), true)
  assert.equal(await evaluate(`!!${guest('draft')} && !!${guest('scrolled')} && !!${guest('recent')}`), true,
    '打到一半、往上翻著、正在顯示的都留著')
  assert.equal(await inGuest('draft', `document.getElementById('box').value`), '打到一半')
  console.log('PASS 只收乾淨的閒置對話；草稿、翻舊訊息、正在看的都留著')

  await open('clean')
  await ready('clean')
  assert.ok((await evaluate(`${guest('clean')}.getURL()`)).endsWith('/c/clean'), '點回來照原網址重建')
  console.log('PASS 點回來照原網址重建')

  await inGuest('draft', `document.getElementById('box').value = ''`)
  await inGuest('draft', `document.body.insertAdjacentHTML('beforeend', '<button data-testid="stop-button"></button>')`)
  await open('recent')
  assert.equal(await evaluate(`(async () => { const n = await mod.sleepIdleAiWeb(Date.now() + ${2 * HOUR}); return !!${guest('draft')} })()`), true, '還在生成的不收')
  console.log('PASS 還在生成的不收')

  // 側欄狀態：背景生成完＝完成未讀；正看著的生成完不算未讀
  await open('watch')
  await ready('watch')
  await open('other')
  await ready('other')
  await evaluate('window.statusLog = []; mod.pollAiWebStatus()')
  const stop = `document.body.insertAdjacentHTML('beforeend', '<button id="s" aria-label="Stop response"></button>')`
  const done = `document.getElementById('s').remove()`
  await inGuest('watch', stop)
  await evaluate('mod.pollAiWebStatus()')
  await inGuest('watch', done)
  await evaluate('mod.pollAiWebStatus()')
  await inGuest('other', stop)
  await evaluate('mod.pollAiWebStatus()')
  await inGuest('other', done)
  await evaluate('mod.pollAiWebStatus()')
  const log = (await evaluate('window.statusLog')).filter(([id]) => id === 'watch' || id === 'other')
  assert.deepEqual(log, [['watch', 'running'], ['watch', 'done'], ['other', 'running'], ['other', '']])
  console.log('PASS 背景生成完標未讀；正看著的不標')
  win.destroy()
}

app.whenReady().then(run).then(() => {
  clearTimeout(timeout)
  app.exit(0)
}).catch((error) => {
  console.error(error)
  clearTimeout(timeout)
  app.exit(1)
})
