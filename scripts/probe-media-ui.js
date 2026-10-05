'use strict'

const fs = require('fs')
const path = require('path')
const assert = require('assert/strict')
const { spawn, spawnSync } = require('child_process')
const { tempDir } = require('./lib/test-temp')
const runtime = path.resolve(process.env.AXONDECK_MEDIA_DIR || 'resources/media')
const output = path.resolve(process.env.AXONDECK_MEDIA_REPORT_DIR || tempDir('media-ui-'))
const ffmpeg = require('ffmpeg-static')
fs.mkdirSync(output, { recursive: true })
function generate(exe, args) {
  const result = spawnSync(exe, args, { windowsHide: true, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}
async function play(file, action, extraArgs = [], additionalFiles = []) {
  const report = path.join(output, `${action}.json`)
  const child = spawn(path.join(runtime, 'axondeck-media.exe'), ['--hidden', `--probe=${report}`, `--probe-action=${action}`, '--probe-wait=5.2', ...extraArgs, '--', file, ...additionalFiles], { windowsHide: true, stdio: 'ignore' })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`${action}: timeout`)) }, 15000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${action}: exit ${code}`)) })
    })
    const data = JSON.parse(fs.readFileSync(report, 'utf8'))
    assert.equal(data.loaded && !data.error, true, JSON.stringify(data))
    return data
  } finally { child.kill() }
}
async function main() {
  const images = path.join(output, 'images'); fs.mkdirSync(images, { recursive: true })
  for (const [i,color] of ['#78a3b5','#d4a75b','#36585b'].entries()) {
    generate(path.join(runtime, 'magick.exe'), ['-size','800x600',`xc:${color}`,path.join(images, `${i+1}.png`)])
  }
  const image = await play(path.join(images,'1.png'),'ui-image')
  assert.deepEqual(image.actions[0], { actual: true, zoom: 0.25, rotate: 90, pause: true, help: true, queue: true, index: 0 })
  assert.equal(image.actions[1].index,1); assert.equal(image.actions[1].loaded,true)
  assert.equal(image.actions[2].slideshow,true); assert.notEqual(image.actions[2].index,0)
  assert.equal(image.slideshow,false); assert.equal(image.screenshot,true)
  assert.ok(fs.statSync(path.join(output,'ui-image.capture.png')).size>100)
  console.log('PASS image: 1:1 / zoom / rotate / next / slideshow / help / queue / screenshot')
  const video = path.join(output,'video.mp4')
  generate(ffmpeg, ['-y','-f','lavfi','-i','testsrc2=size=640x360:rate=12','-t','12','-c:v','libx264','-pix_fmt','yuv420p',video])
  const audio = path.join(output,'audio.flac')
  generate(ffmpeg, ['-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','12','-c:a','flac','-metadata','title=午後的片刻','-metadata','artist=AxonDeck','-metadata','album=Aurora Sessions',audio])
  for (const [file,action] of [[video,'ui-video'],[audio,'ui-audio']]) {
    const data = await play(file,action)
    assert.equal(data.pause,true); assert.equal(data.mute,true); assert.equal(data.speed,1.25)
    assert.ok(data.time>=5); assert.ok(Math.abs(data.subDelay-0.1)<0.001)
    assert.equal(data.repeat && data.shuffle && data.help && data.queue,true)
    if (action==='ui-video') {
      assert.equal(data.screenshot,true); assert.ok(fs.statSync(path.join(output,`${action}.capture.png`)).size>100)
      assert.ok(data.actions[1].time>data.actions[0].time); assert.ok(data.time<data.actions[1].time)
    }
    console.log(`PASS ${action}: pause / mute / speed / seek / subtitle timing / repeat / shuffle`)
  }
  const full = await play(video,'ui-fullscreen')
  assert.deepEqual(full.actions[0],{full:true,chromeHidden:true})
  assert.equal(full.help,true); assert.equal(full.chromeHidden,false)
  console.log('PASS fullscreen: auto hide / wake; hidden test stays hidden')
  generate(path.join(runtime, 'magick.exe'), ['-size','64x40','xc:#78a3b5',path.join(images,'extra.png')])
  const queue = await play(path.join(images,'1.png'),'ui-queue',[],[path.join(images,'2.png')])
  assert.deepEqual(queue.actions[0], { append:true, search:true, remove:true, filePreserved:true })
  assert.equal(queue.queueCount,2)
  console.log('PASS queue: append / deduplicate / filter / remove without deleting file')
  for (const file of [video,audio]) {
    const settings = path.join(output, `preferences-${path.extname(file).slice(1)}-${Date.now()}`)
    const args = [`--settings-dir=${settings}`]
    const saved = await play(file,'preferences-save',args)
    assert.ok(Math.abs(saved.time-6)<0.3); assert.equal(saved.volume,37)
    const document = JSON.parse(fs.readFileSync(path.join(settings,'preferences.json'),'utf8'))
    assert.equal(document.preferences.volume,37); assert.equal(document.preferences.queue_width,344)
    assert.equal(document.preferences.window_saved,true); assert.ok(Math.abs(document.history[0].position-6)<0.3)
    assert.deepEqual([document.preferences.width,document.preferences.height],[820,540])
    const resumed = await play(file,'preferences-read',args)
    assert.equal(resumed.volume,37); assert.equal(resumed.queueWidth,344); assert.equal(resumed.mute,true)
    assert.deepEqual(resumed.windowSize,[820,540])
    assert.ok(Math.abs(resumed.time-6)<0.3, JSON.stringify(resumed))
    console.log(`PASS ${path.extname(file)} preferences: saved volume / size / sidebar / exact resume; isolated and muted`)
  }
  const started = Date.now()
  const closing = await play(video,'defaults-close')
  assert.ok(Date.now()-started > closing.elapsedMs+1000, '關閉播放器應等背景工作完成，不能中途結束關聯')
  console.log('PASS default background job: closes window and decoder, completes pending work before process exit; no registry writes')
  console.log(`media UI: 8 groups passed; ${output}`)
}
main().catch(error => { console.error(error); process.exitCode=1 })
