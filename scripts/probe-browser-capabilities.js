'use strict'
// npx electron scripts/probe-browser-capabilities.js；實測 ScienceDirect 文章與 PDF，資料隔離。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, session, ipcMain } = require('electron')
const { tempDir } = require('./lib/test-temp')
const DATA = tempDir('b-'), ROOT = process.env.AXONDECK_ASAR || path.join(__dirname, '..')
app.setPath('userData', DATA)
async function until(fn, name) {
  const end = Date.now() + 30000
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r,100)) }
  throw new Error(name + ': timeout')
}
async function main() {
  await app.whenReady()
  const web = session.fromPartition('persist:wsbrowser-clean')
  require(path.join(ROOT, 'src/main/ai-web')).setupSession(web, { userAgent: app.userAgentFallback,
    shimPath: path.join(ROOT, 'src/preload/ai-web-shim.js'), languages: 'zh-TW,zh,en-US,en' })
  const browserWindow = require(path.join(ROOT, 'src/main/browser-window'))
  ipcMain.handle('browserWindow:extensionActions', () => [])
  browserWindow.configure({ preload: path.join(ROOT, 'src/preload/browser-window-preload.js') })
  let response
  web.webRequest.onHeadersReceived({ urls: ['https://www.sciencedirect.com/*','https://pdf.sciencedirectassets.com/*'] }, (details, callback) => {
    if (details.resourceType === 'mainFrame') response = { status: details.statusCode,
      type: Object.entries(details.responseHeaders).find(([key])=>key.toLowerCase()==='content-type')?.[1]?.[0],
      challenge: Object.entries(details.responseHeaders).some(([key,value])=>key.toLowerCase()==='cf-mitigated' && value.includes('challenge')) }
    callback({})
  })
  const win = await browserWindow.open('https://www.sciencedirect.com/', 'ScienceDirect', null, 0, true)
  const page = browserWindow.pageOf(win.webContents)
  await until(()=>page.executeJavaScript('document.title.includes("ScienceDirect")').catch(()=>false), 'homepage')
  assert.equal(response.status,200); assert.equal(response.challenge,false)
  console.log('PASS ScienceDirect homepage', response)
  await page.loadURL('https://www.sciencedirect.com/science/article/pii/S259014272400020X')
  await until(()=>page.executeJavaScript('document.body.innerText.includes("RESTORE: Once-nightly")'), 'article')
  assert.equal(response.status,200); assert.equal(response.challenge,false)
  console.log('PASS ScienceDirect open-access article', response)
  await until(()=>page.executeJavaScript('Array.from(document.querySelectorAll("a[href]")).some(a=>a.href.includes("/S259014272400020X/pdfft"))'), 'PDF link')
  const pdfUrl = await page.executeJavaScript('Array.from(document.querySelectorAll("a[href]")).find(a=>a.href.includes("/S259014272400020X/pdfft"))?.href')
  assert.ok(pdfUrl)
  await page.loadURL(pdfUrl)
  let viewer
  await until(async()=>{
    viewer = page.mainFrame.framesInSubtree.find(f=>f.url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'))
    return viewer && await viewer.executeJavaScript('document.querySelector("pdf-viewer")?.shadowRoot?.querySelector("viewer-toolbar")?.docLength > 0').catch(()=>false)
  }, 'PDF viewer')
  assert.equal(response.status,200); assert.match(response.type,/application\/pdf/); assert.equal(response.challenge,false)
  const pdf = await viewer.executeJavaScript('(()=>{const v=document.querySelector("pdf-viewer");return {pages:v.shadowRoot.querySelector("viewer-toolbar").docLength,loaded:v.loaded_,loadState:v.loadState_}})()')
  assert.equal(pdf.pages,7)
  await until(()=>viewer.executeJavaScript('document.querySelector("pdf-viewer")?.loadState_ === "success"').catch(()=>false), 'PDF rendered')
  pdf.loadState=await viewer.executeJavaScript('document.querySelector("pdf-viewer").loadState_')
  console.log('PASS ScienceDirect PDF in native OOPIF viewer', { ...response, ...pdf })
  const output = path.join(__dirname,'../designs/browser-qa'); fs.mkdirSync(output,{recursive:true})
  let picture
  win.showInactive()
  await until(async()=>{
    try {
      picture=await page.capturePage()
      const pixels=picture.toBitmap();let paper=0
      for(let i=0;i<pixels.length;i+=4) if(pixels[i]>220 && pixels[i+1]>220 && pixels[i+2]>220) paper++
      return paper>10000
    }
    catch(error) { if(error.message!=='UnknownVizError') throw error;return false }
  },'PDF capture')
  fs.writeFileSync(path.join(output,'sciencedirect-pdf.png'),picture.toPNG())
  console.log('Screenshot:', path.join(output,'sciencedirect-pdf.png'))
  win.destroy()
}
main().then(()=>app.exit(0),error=>{console.error(error.message);app.exit(1)})
