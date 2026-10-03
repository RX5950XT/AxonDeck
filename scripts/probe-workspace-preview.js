'use strict'
// 暫存 profile＋CDP＋本輪 PID；不開使用者視窗、不碰既有資料或預設程式。
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const { tempDir } = require('./lib/test-temp')
const root = path.join(__dirname, '..')
const exe = process.env.VOICEINK_EXE || path.join(root, 'dist/win-unpacked/VoiceInk.exe')
const profile = tempDir('media-packaged-')
const project = tempDir('media-project-')
const plainProject = tempDir('workspace-plain-')
const port = 9497
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const own = new Set()
function processes(parent) {
  const code = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(parent)}" | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress`
  const output = execFileSync('powershell', ['-NoProfile', '-Command', code], { windowsHide: true, encoding: 'utf8' }).trim()
  return output ? [JSON.parse(output)].flat() : []
}
function kill(pid, tree = true) {
  try { execFileSync('taskkill', ['/PID', String(pid), ...(tree ? ['/T'] : []), '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* 本輪程序已退出 */ }
}
async function wait(check, message) {
  for (let i = 0; i < 80; i++) { const value = await check(); if (value) return value; await delay(200) }
  throw new Error(message)
}
async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  let id = 0; const pending = new Map()
  ws.addEventListener('message', ({ data }) => {
    const value = JSON.parse(data); if (!pending.has(value.id)) return
    const callback = pending.get(value.id); pending.delete(value.id); callback(value)
  })
  return { ws, eval: (expression) => new Promise((resolve, reject) => {
    const key = ++id
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('CDP timeout')) }, 15000)
    pending.set(key, (value) => { clearTimeout(timer); const result = value.result
      if (value.error || result.exceptionDetails) reject(new Error(JSON.stringify(value.error || result.exceptionDetails)))
      else resolve(result.result.value)
    })
    ws.send(JSON.stringify({ id: key, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  }) }
}
async function main() {
  const http = require('node:http')
  let image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  execFileSync(path.join(path.dirname(exe), 'resources/media/magick.exe'), ['-size','64x40','xc:#78a3b5',path.join(project,'sample.png')], {windowsHide:true})
  image = fs.readFileSync(path.join(project,'sample.png'))
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'image/png'); res.end(image) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const online = `http://127.0.0.1:${server.address().port}/image.png`
  fs.mkdirSync(path.join(project, 'docs'))
  fs.mkdirSync(path.join(project, 'images'))
  fs.writeFileSync(path.join(project, 'images', '中文 圖(1).png'), image)
  fs.writeFileSync(path.join(project, 'docs', 'readme.md'), `# 圖片預覽\n\n![本機](<../images/中文 圖(1).png>)\n\n> ![引用](/images/中文%20圖(1).png)\n\n![網路](${online})\n\n![越界](../../outside.png)`)
  execFileSync(require('ffmpeg-static'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=64x40:rate=5', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(project, 'clip.mp4')], { windowsHide: true })
  const runGit = (...args) => execFileSync('git', args, { cwd: project, windowsHide: true, stdio: 'ignore' })
  runGit('init', '-q'); runGit('remote', 'add', 'origin', 'git@github.com:owner/example.git')
  runGit('config', 'user.email', 'probe@example.invalid'); runGit('config', 'user.name', 'probe')
  runGit('add', '-A'); runGit('commit', '-qm', 'seed')
  fs.appendFileSync(path.join(project, 'clip.mp4'), Buffer.from('probe-tail'))
  fs.appendFileSync(path.join(project, 'images', '中文 圖(1).png'), Buffer.from('probe-tail'))
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ sysmonSensors: false, theme: 'light' }))
  fs.writeFileSync(path.join(profile, 'workspaces.json'), JSON.stringify({ projects: [
    { id: 'w_media_probe', name: '專案預覽驗收', path: project, createdAt: Date.now() },
    { id: 'w_plain_probe', name: '無 Git 專案', path: plainProject, createdAt: Date.now() }
  ] }))
  const child = spawn(exe, ['--hidden', '--inspect=127.0.0.1:9498', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], { windowsHide: true, stdio: 'ignore', env: { ...process.env, LOCALAPPDATA: profile } })
  let cdp, mainCdp
  try {
    const target = await wait(async () => {
      try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => /index\.html/.test(t.url)) } catch { return null }
    }, 'CDP 沒有啟動')
    cdp = await connect(target.webSocketDebuggerUrl)
    const nodeTarget = (await (await fetch('http://127.0.0.1:9498/json/list')).json())[0]
    mainCdp = await connect(nodeTarget.webSocketDebuggerUrl)
    await wait(() => cdp.eval('!!window.electronAPI?.workspace && document.readyState === "complete"'), '介面未完成')
    const data = await cdp.eval(`electronAPI.workspace.readFile('w_media_probe', 'images/中文 圖(1).png')`)
    assert.ok(data.ok && data.data.image?.startsWith('vi-media://'))
    assert.equal(data.data.content, '')
    assert.equal(data.data.nativeMedia, undefined)
    await cdp.eval('document.querySelector(".nav-tab[data-page=chat]").click(); document.querySelector(".sidebar-mode[data-mode=projects]").click()')
    await wait(() => cdp.eval('!!document.querySelector("#projList [data-id=w_media_probe] .chat-list-open")'), '專案清單未完成')
    await cdp.eval('document.querySelector("#projList [data-id=w_media_probe] .chat-list-open").click()')
    const open = (file) => cdp.eval(`import('./scripts/ws-tabs.js').then(m => m.openEditorTab({ id:'w_media_probe' }, ${JSON.stringify(file)})).then(() => true)`)
    await open('docs/readme.md')
    await mainCdp.eval("process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w => /index\\.html/.test(w.webContents.getURL())).webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}).then(() => true)")
    await wait(() => cdp.eval('[...document.querySelectorAll("#wsEditorPreview img")].filter(i => i.complete && i.naturalWidth > 0).length === 3'), 'Markdown 圖片沒有真的載入')
    assert.equal(await cdp.eval('document.querySelectorAll("#wsEditorPreview img").length'), 3)
    console.log('PASS Markdown 相對／專案根目錄／中文空白括號／引用／網路圖片真的載入；越界維持文字')
    await cdp.eval('document.querySelector("#wsTree .ws-tree-row[data-rel=images]").click()')
    await wait(() => cdp.eval('!![...document.querySelectorAll("#wsTree .ws-tree-row")].find(r => r.dataset.rel === "images/中文 圖(1).png")'), '圖片檔案樹未展開')
    await cdp.eval('[...document.querySelectorAll("#wsTree .ws-tree-row")].find(r => r.dataset.rel === "images/中文 圖(1).png").click()')
    await wait(() => cdp.eval('document.querySelector("#wsEditorPreview .ws-editor-img")?.naturalWidth > 0'), '圖片分頁未載入')
    const count = await cdp.eval('document.querySelectorAll(".ws-tab").length')
    await open('images/中文 圖(1).png')
    assert.equal(await cdp.eval('document.querySelectorAll(".ws-tab").length'), count)
    await cdp.eval('[...document.querySelectorAll("#wsTree .ws-tree-row")].find(r => r.dataset.rel === "clip.mp4").click()')
    await wait(() => cdp.eval('document.querySelector("#wsEditorPreview video")?.readyState >= 2'), '影片分頁不能播放')
    assert.equal(await cdp.eval('document.querySelector("#wsEditorPreview video").duration'), 2)
    const range = await cdp.eval(`electronAPI.workspace.readFile('w_media_probe', 'clip.mp4').then(async r => { const v = await fetch(r.data.video, {headers:{Range:'bytes=0-31'}}); return {status:v.status, bytes:(await v.arrayBuffer()).byteLength} })`)
    assert.deepEqual(range, { status: 206, bytes: 32 })
    assert.equal(processes(child.pid).filter(p => p.Name === 'voiceink-media.exe').length, 0)
    console.log('PASS 專案圖片／影片分頁；重複點圖不重開；MP4 可解碼；Range 206；沒有獨立播放器')
    await cdp.eval('document.querySelector(".ws-right-tab[data-panel=git]").click()')
    await wait(() => cdp.eval('document.getElementById("wsGitHubBtn")?.disabled === false'), 'GitHub 按鈕未啟用')
    await mainCdp.eval(`globalThis.__opened = []; globalThis.__shell = process.mainModule.require('electron').shell; globalThis.__originalOpen = __shell.openExternal; __shell.openExternal = async url => { __opened.push(url) }`)
    await cdp.eval('document.getElementById("wsGitHubBtn").click()')
    await wait(() => mainCdp.eval('__opened[0] === "https://github.com/owner/example"'), '按鈕沒有正確開 GitHub')
    fs.mkdirSync(path.join(root, 'dist', 'qa'), { recursive: true })
    let shot
    for (let frame = 0; frame < 4; frame++) {
      shot = await mainCdp.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w => /index\.html/.test(w.webContents.getURL())).webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}).then(i => i.toPNG().toString('base64'))`)
      await delay(150)
    }
    fs.writeFileSync(path.join(root, 'dist', 'qa', 'workspace-preview-github.png'), Buffer.from(shot, 'base64'))
    await cdp.eval('document.querySelector("#projList [data-id=w_plain_probe] .chat-list-open").click()')
    await wait(() => cdp.eval('document.getElementById("wsGitHubBtn").disabled === true'), '非 Git 專案按鈕未停用')
    await cdp.eval('document.querySelector("#projList [data-id=w_media_probe] .chat-list-open").click()')
    await wait(() => cdp.eval('document.querySelectorAll(".ws-tab").length >= 3'), '媒體分頁沒有還原')
    await cdp.eval(`import('./scripts/ws-tabs.js').then(m => m.openEditorTab({id:'w_media_probe'}, 'images/中文 圖(1).png'))`)
    await wait(() => cdp.eval('document.querySelector("#wsEditorPreview .ws-editor-img")?.naturalWidth > 0'), '還原圖片不能顯示')
    console.log('PASS GitHub 按鈕完整 IPC 到瀏覽器網址；非 Git 停用；換專案後圖片／影片分頁還原')
    await open('docs/readme.md')
    const rename = await cdp.eval("electronAPI.workspace.renameEntry('w_media_probe','docs','manual')")
    assert.equal(rename.ok, true)
    await cdp.eval("import('./scripts/ws-tabs.js').then(m => m.retargetTabs('w_media_probe','docs','manual'))")
    await wait(() => cdp.eval('[...document.querySelectorAll("#wsEditorPreview img")].filter(i => i.complete && i.naturalWidth > 0).length === 3'), 'Markdown 改名後圖片未載入')
    await cdp.eval("import('./scripts/ws-tabs.js').then(async m => { await m.closeActiveTab(); await m.closeActiveTab(); await m.closeActiveTab() })")
    assert.equal(await cdp.eval('document.querySelectorAll("#wsEditorPreview img, #wsEditorPreview video").length'), 0)
    console.log('PASS Markdown 資料夾改名仍顯示相對圖片；關閉分頁會清除圖片與影片')
    await mainCdp.eval('__shell.openExternal = __originalOpen')
    const memory = await mainCdp.eval(`(async () => {
      const api = process.mainModule.require(process.mainModule.require('electron').app.getAppPath() + '/src/main/workspace/search.js')
      const before = process.memoryUsage(); let peak = before.rss
      const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 5)
      const counts = []
      try {
        for (let round = 0; round < 3; round++) {
          const result = await api.search(${JSON.stringify(root)}, 'preview-search-memory-1199271', false)
          counts.push({scanned:result.scanned,hits:result.hits.length})
        }
      } finally { clearInterval(timer) }
      const after = process.memoryUsage(); const mib = b => Math.round(b / 1048576 * 10) / 10
      return {counts, beforeRssMiB:mib(before.rss),peakRssMiB:mib(peak),beforeHeapMiB:mib(before.heapUsed),afterHeapMiB:mib(after.heapUsed)}
    })()`)
    console.log('PACKAGED 搜尋記憶體 ' + JSON.stringify(memory))
  } catch (error) {
    if (cdp) console.error(await cdp.eval('({text:document.getElementById("wsEditorPreview")?.textContent, images:[...document.querySelectorAll("#wsEditorPreview img")].map(i => ({src:i.src,width:i.naturalWidth,complete:i.complete,loading:i.loading})),tabs:document.querySelectorAll(".ws-tab").length})').catch(() => null))
    throw error
  } finally { cdp?.ws.close(); mainCdp?.ws.close(); kill(child.pid); server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
