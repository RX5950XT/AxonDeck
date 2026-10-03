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
const port = 9397
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
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ sysmonSensors: false, theme: 'light' }))
  fs.writeFileSync(path.join(profile, 'workspaces.json'), JSON.stringify({ projects: [{ id: 'w_media_probe', name: '媒體驗收', path: project, createdAt: Date.now() }] }))
  execFileSync(path.join(path.dirname(exe), 'resources/media/magick.exe'), ['-size', '64x40', 'xc:#78a3b5', path.join(project, '中文 $ 圖片.png')], { windowsHide: true, stdio: 'ignore' })
  fs.writeFileSync(path.join(project, 'note.txt'), '保留原本的文字編輯器')
  const archive = path.join(project, 'media.zip')
  execFileSync('C:/Program Files/7-Zip/7z.exe', ['a', '-tzip', archive, path.join(project, '中文 $ 圖片.png')], { windowsHide: true, stdio: 'ignore' })
  const child = spawn(exe, ['--hidden', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
    windowsHide: true, stdio: 'ignore', env: { ...process.env, LOCALAPPDATA: profile, VOICEINK_MEDIA_HIDDEN: '1' }
  })
  let cdp
  try {
    const target = await wait(async () => {
      try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => /index\.html/.test(t.url)) } catch { return null }
    }, 'packaged CDP 沒有啟動')
    cdp = await connect(target.webSocketDebuggerUrl)
    await wait(() => cdp.eval('!!window.electronAPI?.workspace'), 'preload 沒有完成')
    await wait(() => cdp.eval('document.readyState === "complete" && document.documentElement.dataset.theme === "light"'), '介面初始化沒有完成')
    const api = 'window.electronAPI'
    const media = await cdp.eval(`${api}.workspace.readFile('w_media_probe', '中文 $ 圖片.png')`)
    assert.equal(media.ok, true); assert.ok(media.data.image.startsWith('vi-media://')); assert.equal(media.data.content, '')
    const outside = await cdp.eval(`${api}.workspace.readFile('w_media_probe', '../outside.png')`)
    assert.equal(outside.ok, false)
    const before = await cdp.eval('document.querySelectorAll(".nav-tab").length')
    await cdp.eval('document.querySelector(".nav-tab[data-page=chat]").click(); document.querySelector(".sidebar-mode[data-mode=projects]").click()')
    await wait(() => cdp.eval('!!document.querySelector("#projList [data-id=w_media_probe] .chat-list-open")'), '沒有暫存專案')
    await cdp.eval('document.querySelector("#projList [data-id=w_media_probe] .chat-list-open").click()')
    await delay(500)
    const rendererOpen = async (file) => cdp.eval(`import('./scripts/ws-tabs.js').then(m => m.openEditorTab({ id: 'w_media_probe', name: '媒體驗收' }, ${JSON.stringify(file)})).then(() => true)`)
    await rendererOpen('中文 $ 圖片.png')
    await wait(() => cdp.eval('document.querySelector(".ws-editor-img")?.naturalWidth > 0'), '工作區圖片分頁未載入')
    assert.equal(processes(child.pid).filter(p => p.Name === 'voiceink-media.exe').length, 0)
    console.log('PASS 工作區點圖＝分頁預覽；路徑守衛；沒有獨立播放器')
    let players
    for (const file of [path.join(project, '中文 $ 圖片.png'), path.join(archive, '中文 $ 圖片.png')]) {
      const result = await cdp.eval(`${api}.explorer.openPath(${JSON.stringify(file)})`); assert.equal(result.ok, true)
    }
    players = await wait(() => { const list = processes(child.pid).filter((p) => p.Name === 'voiceink-media.exe'); return list.length >= 2 ? list : null }, 'Explorer／ZIP 沒有啟動')
    for (const player of players) own.add(player.ProcessId)
    assert.equal(await cdp.eval('document.querySelectorAll(".nav-tab").length'), before)
    await rendererOpen('note.txt')
    assert.equal(await cdp.eval('!!document.querySelector(".ws-tab")'), true)
    console.log('PASS packaged Explorer／ZIP 開啟；沒有新頁；原本編輯器仍可用')
    for (const p of processes(child.pid).filter((p) => p.Name !== 'voiceink-media.exe')) own.add(p.ProcessId)
    kill(child.pid, false)
    await delay(600)
    for (const player of players) assert.ok(processes(player.ProcessId).some((p) => p.Name === 'mpv.exe'))
    console.log('PASS VoiceInk 強制結束後，獨立播放器仍運行')
  } catch (error) {
    if (cdp) console.error(await cdp.eval('({ ready:document.readyState, theme:document.documentElement.dataset.theme, page:document.querySelector(".page.active")?.id, projects:document.getElementById("projList")?.textContent })').catch(() => '主程序已結束'))
    throw error
  } finally { cdp?.ws.close(); kill(child.pid); for (const pid of own) kill(pid) }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
