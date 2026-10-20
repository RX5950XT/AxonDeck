'use strict'
/** 隔離打包版：真 IPC、滑鼠拖曳、鍵盤排序、重新載入與分類刪除。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { tempDir, removeTree } = require('./lib/test-temp')
const PORT = 9301, MAIN_PORT = 9302
const EXE = process.env.AXONDECK_EXE || path.join(__dirname, '../dist/win-unpacked/AxonDeck.exe')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const clients = []
const errors = []
class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map() }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = ({ data }) => {
      const message = JSON.parse(data), req = this.pending.get(message.id)
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
      if (!req) return
      this.pending.delete(message.id); clearTimeout(req.timer)
      if (message.error) req.reject(new Error(message.error.message))
      else req.resolve(message.result)
    }
    clients.push(this)
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
}
async function wait(read, label) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await sleep(50) }
  throw new Error(`timeout: ${label}`)
}
async function connect(port, matches) {
  const target = await wait(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(matches) } catch { return null }
  }, 'CDP target')
  const client = new Cdp(target.webSocketDebuggerUrl)
  await client.connect(); return client
}

async function main() {
  const dir = tempDir('workspace-folders-')
  const projectDirs = ['a', 'b', 'c'].map(id => path.join(dir, id))
  projectDirs.forEach(p => fs.mkdirSync(p))
  fs.writeFileSync(path.join(projectDirs[0], 'keep.txt'), '原始檔案')
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ sysmonSensors: false, uffsAuto: false,
    dictationEnabled: false, agyEnabled: false }))
  fs.writeFileSync(path.join(dir, 'workspaces.json'), JSON.stringify({ projects: projectDirs.map((p, i) => ({
    id: `w_folder_${i}`, path: p, name: ['AxonDeck', 'Strata', '私人專案'][i],
    tabsState: { activeId: 'draft', tabs: [{ id: 'draft', kind: 'editor', relPath: 'keep.txt', dirty: true, draftContent: '未存草稿' }] }
  })) }))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of Object.keys(env)) if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key]
  const start = () => spawn(EXE, [`--user-data-dir=${dir}`, `--remote-debugging-port=${PORT}`, `--inspect=127.0.0.1:${MAIN_PORT}`, '--hidden'],
    { env, detached: true, stdio: 'ignore' })
  let child = start()
  async function stop() {
    clients.splice(0).forEach(client => client.ws.close())
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ }
    child.kill(); await sleep(500)
  }
  try {
    let main = await connect(MAIN_PORT, target => target.type === 'node')
    let page = await connect(PORT, target => /index\.html/.test(target.url) && target.url.includes('page=chat'))
    await page.send('Runtime.enable')
    await main.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().forEach(w => { w.setSize(1200, 800); w.showInactive() })`)
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await wait(() => page.eval(`!!document.getElementById('sidebarModeProjects')`), 'sidebar ready')
    await page.eval(`import('./scripts/app.js').then(m => m.setSidebarMode('projects'))`)
    await wait(() => page.eval(`document.querySelectorAll('#projList .proj-list-item').length === 3 && document.getElementById('projNewFolderBtn').offsetHeight > 0`), 'legacy projects')
    const projects = () => page.eval(`electronAPI.workspace.listProjects().then(r => r.data)`)
    const folders = () => page.eval(`electronAPI.workspace.listFolders().then(r => r.data)`)
    async function create(name) {
      await page.eval(`document.getElementById('projNewFolderBtn').click()`)
      await wait(() => page.eval(`!!document.querySelector('dialog[open] input')`), 'folder dialog')
      await page.eval(`document.querySelector('dialog[open] input').value = ${JSON.stringify(name)}; document.querySelector('dialog[open] .btn-primary').click()`)
      await wait(() => page.eval(`Array.from(document.querySelectorAll('#projList .chat-folder-name')).some(el => el.textContent === ${JSON.stringify(name)})`), 'created folder')
      return (await folders()).find(f => f.name === name).id
    }
    const work = await create('工作')
    const personal = await create('個人')
    const folderSelector = id => `#projList .proj-folder[data-id="${id}"]`
    const rowSelector = id => `#projList .proj-list-item[data-id="${id}"]`
    async function choose(label) {
      await page.eval(`Array.from(document.querySelectorAll('.chat-menu-item')).find(b => b.textContent === ${JSON.stringify(label)}).click()`)
    }
    async function openProjectFolderMenu(id) {
      const at = await page.eval(`(() => { const r = document.querySelector('${rowSelector(id)} .chat-list-title').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'right', clickCount: 1 })
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'right', clickCount: 1 })
      await wait(() => page.eval(`!!document.querySelector('.ws-menu-item')`), 'project context menu')
      await page.eval(`Array.from(document.querySelectorAll('.ws-menu-item')).find(b => b.textContent === '移至資料夾…').click()`)
      await wait(() => page.eval(`!!document.querySelector('.chat-menu-item')`), 'project classification menu')
    }
    const originalOrder = (await projects()).map(p => p.id)
    await openProjectFolderMenu('w_folder_2')
    await choose('個人')
    await wait(async () => (await projects()).find(p => p.id === 'w_folder_2').folderId === personal, 'move without reordering')
    assert.deepEqual((await projects()).map(p => p.id), originalOrder, '選單分類不能順便改專案順序')
    await wait(() => page.eval(`!!document.querySelector('${folderSelector(personal)} .proj-list-item')`), 'personal row')
    await openProjectFolderMenu('w_folder_2')
    await choose('未分類')
    await wait(() => page.eval(`!!document.querySelector('#projList .chat-root-body [data-id="w_folder_2"]')`), 'move back to root')
    await openProjectFolderMenu('w_folder_0')
    await choose('工作')
    await wait(async () => (await projects()).find(p => p.id === 'w_folder_0').folderId === work, 'classified project')
    await wait(() => page.eval(`!!document.querySelector('${folderSelector(work)} .proj-list-item')`), 'classified row')
    await page.eval(`document.querySelector('${folderSelector(work)} .chat-folder-toggle').click()`)
    await wait(() => page.eval(`document.querySelector('${folderSelector(work)} .chat-folder-body').offsetHeight === 0`), 'collapsed folder')
    async function drag(from, to) {
      const positions = await page.eval(`(${JSON.stringify([from, to])}).map(s => { const r = document.querySelector(s).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })`)
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...positions[0], button: 'left', clickCount: 1 })
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...positions[1], button: 'left', buttons: 1 })
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...positions[1], button: 'left', clickCount: 1 })
    }
    await drag(`${rowSelector('w_folder_1')} .chat-list-title`, `${folderSelector(work)} .chat-folder-toggle`)
    await wait(async () => (await projects()).find(p => p.id === 'w_folder_1').folderId === work, 'drop into collapsed folder')
    assert.equal((await projects()).find(p => p.id === 'w_folder_0').folderId, work, '收合的專案不能被移出')
    await wait(() => page.eval(`document.querySelector('${folderSelector(work)} .chat-folder-count').textContent === '2'`), 'folder count')
    await page.eval(`document.querySelector('${folderSelector(work)} .chat-folder-toggle').click()`)
    await wait(() => page.eval(`document.querySelectorAll('${folderSelector(work)} .proj-list-item').length === 2`), 'expanded folder')
    await page.eval(`document.querySelector('${rowSelector('w_folder_1')} .chat-list-open').focus()`)
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', modifiers: 1 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', modifiers: 1 })
    await wait(async () => (await projects()).filter(p => p.folderId === work)[0].id === 'w_folder_1', 'keyboard project order')
    await drag(`${folderSelector(personal)} .chat-folder-name`, `${folderSelector(work)} .chat-folder-name`)
    await wait(async () => (await folders())[0].id === personal, 'mouse folder order')
    assert.equal((await folders()).find(f => f.id === personal).collapsed, false, '拖分類不能順便收合')
    await drag(`${rowSelector('w_folder_1')} .chat-list-title`, `${folderSelector(personal)} .chat-folder-toggle`)
    await wait(() => page.eval(`!!document.querySelector('${folderSelector(personal)} [data-id="w_folder_1"]')`), 'drag between folders')
    assert.equal((await projects()).find(p => p.id === 'w_folder_1').folderId, personal)
    await drag(`${rowSelector('w_folder_1')} .chat-list-title`, '#projList .chat-root-head')
    await wait(() => page.eval(`!!document.querySelector('#projList .chat-root-body [data-id="w_folder_1"]')`), 'drag back to root')
    assert.equal((await projects()).find(p => p.id === 'w_folder_1').folderId, '')
    await drag(`${rowSelector('w_folder_1')} .chat-list-title`, `${rowSelector('w_folder_0')} .chat-list-title`)
    await wait(() => page.eval(`document.querySelectorAll('${folderSelector(work)} .proj-list-item').length === 2`), 'drag into expanded folder')
    assert.equal((await projects()).filter(p => p.folderId === work)[0].id, 'w_folder_1')
    console.log('PASS 右鍵分類、拖入展開／收合分類、跨分類／移回未分類、專案與分類排序')

    await page.eval(`document.querySelector('${folderSelector(work)} .proj-folder-btn').click()`)
    await choose('重新命名')
    await wait(() => page.eval(`!!document.querySelector('#projList .chat-list-rename')`), 'inline rename')
    await page.eval(`document.querySelector('#projList .chat-list-rename').value = '程式開發'`)
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await wait(async () => (await folders()).some(f => f.name === '程式開發'), 'renamed folder')
    await page.eval(`document.querySelector('${folderSelector(work)} .chat-folder-toggle').click()`)
    await wait(async () => (await folders()).find(f => f.id === work).collapsed, 'saved collapsed')
    await page.send('Page.reload')
    await wait(() => page.eval(`!!document.getElementById('sidebarModeProjects')`), 'reloaded page')
    await page.eval(`document.getElementById('sidebarModeProjects').click()`)
    await wait(() => page.eval(`document.querySelector('${folderSelector(work)} .chat-folder-name')?.textContent === '程式開發'`), 'restored folders')
    assert.equal(await page.eval(`document.querySelector('${folderSelector(work)} .chat-folder-body').offsetHeight`), 0)
    assert.equal((await folders())[0].id, personal)
    assert.equal((await projects()).filter(p => p.folderId === work)[0].id, 'w_folder_1')
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'workspaces.json'), 'utf8'))
    assert.equal(disk.folders.find(f => f.id === work).collapsed, true)
    await stop()
    child = start()
    main = await connect(MAIN_PORT, target => target.type === 'node')
    page = await connect(PORT, target => /index\.html/.test(target.url) && target.url.includes('page=chat'))
    await page.send('Runtime.enable')
    await main.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().forEach(w => { w.setSize(1200, 800); w.showInactive() })`)
    await page.eval(`import('./scripts/app.js').then(m => m.setSidebarMode('projects'))`)
    await wait(() => page.eval(`document.querySelector('${folderSelector(work)} .chat-folder-name')?.textContent === '程式開發'`), 'restarted folders')
    assert.equal(await page.eval(`document.querySelector('${folderSelector(work)} .chat-folder-body').offsetHeight`), 0)
    assert.equal((await folders())[0].id, personal)
    assert.equal((await projects()).filter(p => p.folderId === work)[0].id, 'w_folder_1')
    console.log('PASS 改名、重新載入及重啟保留分類、收合、分類順序與專案順序')

    await page.eval(`document.querySelector('${folderSelector(work)} .chat-folder-toggle').click()`)
    await wait(() => page.eval(`document.querySelectorAll('${folderSelector(work)} .proj-list-item').length === 2`), 'screenshots ready')
    for (const [theme, width] of [['dark', 1200], ['light', 900]]) {
      await main.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().forEach(w => w.setSize(${width}, 800))`)
      await page.eval(`document.documentElement.setAttribute('data-theme', '${theme}')`)
      await wait(() => page.eval(`(() => {
        const probe = document.createElement('span'); probe.style.color = 'var(--text-secondary)'; document.body.append(probe)
        const expected = getComputedStyle(probe).color; probe.remove()
        return getComputedStyle(document.querySelector('#projList .chat-folder-head')).color === expected
      })()`), 'theme transition settled')
      assert.equal(await page.eval(`document.querySelectorAll('#projList .proj-list-item .proj-folder-btn').length`), 0, '專案列不能出現分類按鈕')
      const shot = await page.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(__dirname, `../dist/workspace-folders-${theme}.png`), Buffer.from(shot.data, 'base64'))
    }
    console.log('PASS 1200／900px、深淺色，專案右側沒有重複分類按鈕')
    await page.eval(`document.querySelector('${rowSelector('w_folder_0')}').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,clientX:150,clientY:300})); Array.from(document.querySelectorAll('.ws-menu-item')).find(b => b.textContent === '重新命名').click()`)
    await wait(() => page.eval(`!!document.querySelector('#projList .chat-list-rename')`), 'project rename')
    await page.eval(`document.querySelector('#projList .chat-list-rename').value = 'AxonDeck 改名'`)
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await wait(() => page.eval(`document.querySelector('${rowSelector('w_folder_0')} .chat-list-title')?.textContent === 'AxonDeck 改名' && !document.querySelector('#projList .chat-list-rename')`), 'project renamed without stuck input')
    assert.equal((await projects()).find(p => p.id === 'w_folder_0').folderId, work)
    await openProjectFolderMenu('w_folder_0')
    await choose('未分類')
    await wait(async () => (await projects()).find(p => p.id === 'w_folder_0').folderId === '', 'move out')
    await wait(() => page.eval(`!!document.querySelector('${folderSelector(work)} .proj-folder-btn')`), 'folder ready for removal')
    await page.eval(`document.querySelector('${folderSelector(work)} .proj-folder-btn').click()`)
    await choose('刪除資料夾（專案移回未分類）')
    await wait(async () => !(await folders()).some(f => f.id === work), 'removed folder')
    assert((await projects()).every(p => !p.folderId))
    assert.equal((await projects()).length, 3)
    const tabs = await page.eval(`electronAPI.workspace.getTabsState('w_folder_0').then(r => r.data)`)
    assert.equal(tabs.tabs[0].draftContent, '未存草稿')
    assert.equal(fs.readFileSync(path.join(projectDirs[0], 'keep.txt'), 'utf8'), '原始檔案')
    assert.deepEqual(errors, [], 'renderer 不可有未處理錯誤')
    console.log('PASS 專案改名、移出及刪分類保留全部專案、草稿與磁碟檔案')
  } catch (error) {
    const page = clients.find(c => c.url.includes(`:${PORT}/`))
    if (page) console.error('UI state:', await page.eval(`({ ready: document.readyState, selected: document.getElementById('sidebarModeProjects')?.getAttribute('aria-selected'), hidden: document.getElementById('projPanel')?.hidden, list: document.getElementById('projList')?.outerHTML, toasts: document.querySelector('.toast-container')?.textContent })`).catch(() => null))
    console.error('Renderer errors:', errors)
    throw error
  } finally {
    await stop(); removeTree(dir)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
