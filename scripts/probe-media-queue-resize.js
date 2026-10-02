'use strict'
// 四筆／空清單，走與拖曳相同的寬度調整；只用本輪畫面外 HWND，不捕捉滑鼠。
const fs = require('fs')
const path = require('path')
const assert = require('assert/strict')
const { spawn, spawnSync } = require('child_process')
const { tempDir } = require('./lib/test-temp')
const runtime = path.resolve(process.env.VOICEINK_MEDIA_DIR || 'resources/media')
const output = path.resolve(process.env.VOICEINK_MEDIA_REPORT_DIR || tempDir('media-queue-resize-'))
fs.mkdirSync(output, { recursive: true })
async function main() {
  const files = Array.from({ length: 4 }, (_, i) => path.join(output, `track-${i}.wav`))
  const fixture = spawnSync(require('ffmpeg-static'), ['-y','-f','lavfi','-i','anullsrc=r=48000:cl=mono','-t','12',files[0]], { windowsHide:true, encoding:'utf8' })
  assert.equal(fixture.status,0,fixture.stderr)
  for (const file of files.slice(1)) fs.copyFileSync(files[0],file)
  for (const theme of ['dark','light']) {
    const report = path.join(output,`${theme}.json`)
    const child = spawn(path.join(runtime,'voiceink-media.exe'),['--offscreen',`--theme=${theme}`,`--probe=${report}`,'--probe-action=queue-resize','--probe-wait=3','--',...files],{ windowsHide:true,stdio:['ignore','ignore','pipe'] })
    let stderr=''; child.stderr.on('data',chunk=>{stderr+=chunk})
    try {
      await new Promise((resolve,reject) => {
        const timer=setTimeout(()=>{ child.kill();reject(new Error('queue resize timeout')) },15000)
        child.once('error',error=>{clearTimeout(timer);reject(error)})
        child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`exit ${code}`))})
      })
      const data=JSON.parse(fs.readFileSync(report,'utf8'))
      fs.writeFileSync(path.join(output,`${theme}-stderr.log`),stderr)
      assert.equal(stderr.trim(),'','native layout error')
      assert.equal(data.loaded && !data.error,true)
      const result=data.actions[0]
      assert.ok(result?.frames>=80,JSON.stringify(data))
      assert.equal(result.whitePixels,0,JSON.stringify(result))
      assert.equal(result.blankDark && result.callbackDark && result.eraseDark,true,JSON.stringify(result))
      assert.deepEqual(result.slider,[true,true,true,true],JSON.stringify(result))
      assert.equal(result.duplicateNoRedraw,true,JSON.stringify(result))
      assert.equal(result.fullSliderPaint,true,'長／短滑桿局部重畫會裁掉自繪圓點')
      assert.equal(result.buttonRefresh,true,'狀態更新後按鈕沒有排入重畫，必須等滑鼠移動')
      console.log(`PASS ${theme}: 120 long/short slider paints complete; ${result.frames} resize frames; slider callback/frame/erase stable; duplicate resize no redraw; layout p95 ${result.layoutP95Us} us; white pixels 0`)
    } finally { child.kill() }
  }
}
main().catch(error=>{ console.error(error);process.exitCode=1 })
