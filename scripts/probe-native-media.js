'use strict'

const fs = require('fs')
const path = require('path')
const assert = require('assert/strict')
const { spawn, spawnSync } = require('child_process')
const { tempDir } = require('./lib/test-temp')
const ROOT = path.join(__dirname, '..')
const runtime = path.resolve(process.env.VOICEINK_MEDIA_DIR || path.join(ROOT, 'resources/media'))
const output = path.resolve(process.env.VOICEINK_MEDIA_REPORT_DIR || tempDir('native-media-'))
fs.mkdirSync(output, { recursive: true })
const magick = path.join(runtime, 'magick.exe')
const exe = path.join(runtime, 'voiceink-media.exe')
const ffmpeg = require('ffmpeg-static')

function generate(file, args, tool = magick) {
  const result = spawnSync(tool, [...args, file], { windowsHide: true, encoding: 'utf8' })
  assert.equal(result.status, 0, `fixture ${path.extname(file)}: ${result.stderr}`)
}
async function play(file, action = '', options = []) {
  const report = path.join(output, `${path.basename(file)}${action}.json`)
  const child = spawn(exe, ['--hidden', `--probe=${report}`, ...(action ? [`--probe-action=${action}`] : []), ...options, '--', file], { windowsHide: true, stdio: 'ignore' })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`native timeout: ${file}`)) }, 50000)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`native exit ${code}: ${file}`)) })
    })
    return JSON.parse(fs.readFileSync(report, 'utf8'))
  } finally { child.kill() }
}
async function main() {
  const reports = []
  const filter = process.argv[2]
  const rare = ['tga', 'dds', 'exr', 'hdr', 'jp2', 'pcx', 'ppm', 'pam', 'pbm', 'pgm', 'jng']
  for (const ext of ['png', 'jpg', 'gif', 'webp', 'avif', 'heic', 'jxl', 'psd', 'tiff', 'bmp', 'ico', 'qoi', ...rare]) {
    if (filter && ext !== filter && !(filter === 'rare' && rare.includes(ext))) continue
    const file = path.join(output, `image.${ext}`)
    if (ext === 'heic') {
      const bytes = Buffer.from(await (await fetch('https://raw.githubusercontent.com/strukturag/libheif/master/examples/example.heic')).arrayBuffer())
      assert.equal(require('crypto').createHash('sha256').update(bytes).digest('hex'), '7f8b363e4936c0666a25f64f3a92fda10bd8e5453be4592530b65a55dd98f3f2')
      fs.writeFileSync(file, bytes)
    } else generate(file, ['-size', '160x100', 'gradient:#78a3b5-#d4a75b'])
    const report = await play(file)
    reports.push(report)
    assert.equal(report.loaded && !report.error, true, `${ext}: ${JSON.stringify(report)}`)
    console.log(`PASS ${ext} — ${report.video.w}×${report.video.h}, ${report.elapsedMs}ms`)
  }
  if (!filter || ['webp','gif','mng'].includes(filter)) {
    for (const ext of (!filter ? ['webp', 'gif', 'mng'] : [filter])) {
    const file = path.join(output, `animated.${ext}`)
    generate(file, ['-size', '64x40', '-delay', '25', 'xc:#78a3b5', '-size', '64x40', '-delay', '50', 'xc:#d4a75b', '-loop', '0'])
    const report = await play(file, 'animation')
    assert.equal(report.loaded && !report.error, true, `animated WebP: ${JSON.stringify(report)}`)
    const colors = Array.from({ length: 12 }, (_, i) => {
      const frame = path.join(output, `animated.${ext}animation.${i}.png`)
      const result = spawnSync(magick, [frame, '-format', '%[pixel:p{20,20}]', 'info:'], { windowsHide: true, encoding: 'utf8' })
      assert.equal(result.status, 0, `animation screenshot ${i}: ${result.stderr}`)
      return result.stdout
    })
    const unique = [...new Set(colors)]
    assert.equal(unique.length, 2, 'WebP 要真的顯示兩格')
    for (const color of unique) assert.ok(colors.filter((c) => c === color).length >= 2, 'WebP 兩格必須反覆顯示')
    assert.ok(colors.filter((c, i) => i > 0 && c !== colors[i - 1]).length >= 3, 'WebP 至少重播兩輪')
    console.log(`PASS animated ${ext} — 12 張真實畫面，兩格反覆播放`)
    reports.push(report)
    }
  }
  if (!filter || filter === 'svg') {
    const file = path.join(output, 'image.svg')
    fs.writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#78a3b5"/></svg>')
    const report = await play(file)
    assert.equal(report.loaded && !report.error, true, `svg: ${JSON.stringify(report)}`)
    console.log('PASS SVG'); reports.push(report)
  }
  if (!filter || filter === 'video') {
    const file = path.join(output, 'video.mkv')
    generate(file, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], ffmpeg)
    for (const action of ['', 'pause', 'seek', 'decoder-crash']) {
      const report = await play(file, action)
      assert.equal(report.loaded, true, `video ${action}: ${JSON.stringify(report)}`)
      assert.equal(report.error, action === 'decoder-crash', `video ${action}`)
      if (action === 'pause') assert.equal(report.pause, true)
      if (action === 'seek') assert.ok(report.time > 1)
      console.log(`PASS MKV / ${action || 'play'}`); reports.push(report)
    }
    for (const [ext, codec, extra] of [
      ['mp4','libx264',[]], ['avi','mpeg4',[]], ['webm','libvpx-vp9',['-cpu-used','8']],
      ['wmv','wmv2',[]], ['mpg','mpeg2video',[]],
      ['mov','prores_ks',['-pix_fmt','yuv422p10le']],
      ['hevc.mp4','libx265',['-preset','ultrafast','-x265-params','pools=1:frame-threads=1']],
      ['av1.mp4','libaom-av1',['-cpu-used','8','-threads','2']]
    ]) {
      const dir = path.join(output, `video-${ext}`); fs.mkdirSync(dir, { recursive: true })
      const clip = path.join(dir, `clip.${ext}`)
      generate(clip, ['-y','-f','lavfi','-i','testsrc2=size=160x96:rate=12','-t','4','-c:v',codec,...extra], ffmpeg)
      const report = await play(clip)
      assert.equal(report.loaded && !report.error, true, `${ext}: ${JSON.stringify(report)}`)
      assert.equal(report.kind, 'video')
      console.log(`PASS ${ext} / ${codec} / ${report.hwdec}`); reports.push(report)
    }
  }
  if (!filter || filter === 'audio') {
    for (const [ext, codec] of [['flac','flac'], ['mp3','libmp3lame'], ['opus','libopus'], ['wav','pcm_s24le']]) {
      const file = path.join(output, `audio.${ext}`)
      generate(file, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:a', codec], ffmpeg)
      const report = await play(file)
      assert.equal(report.loaded && !report.error, true, `${ext}: ${JSON.stringify(report)}`)
      console.log(`PASS ${ext}`); reports.push(report)
    }
  }
  if (!filter || filter === 'playlist') {
    const dir = path.join(output, 'queue'); fs.mkdirSync(dir, { recursive: true })
    for (const [name, duration] of [['first.wav', 1], ['second.wav', 5]]) {
      generate(path.join(dir, name), ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(duration)], ffmpeg)
    }
    for (const [ext, text] of [
      ['m3u8', '\ufeff#EXTM3U\nhttps://example.invalid/no.mp3\nfirst.wav\nsecond.wav\n'],
      ['pls', '[playlist]\nFile1=first.wav\nFile2=second.wav\nNumberOfEntries=2\n'],
      ['cue', 'FILE "first.wav" WAVE\n  TRACK 01 AUDIO\nFILE "second.wav" WAVE\n  TRACK 02 AUDIO\n']
    ]) {
      const file = path.join(dir, `list.${ext}`); fs.writeFileSync(file, text)
      const report = await play(file)
      assert.equal(report.loaded && !report.error, true, `${ext}: ${JSON.stringify(report)}`)
      assert.equal(report.queueCount, 2); assert.equal(report.index, 1, '第一首結束必須自動播放第二首')
      console.log(`PASS ${ext} — 本機清單與自動下一首`); reports.push(report)
    }
  }
  if (!filter || filter === 'broken') {
    for (const ext of ['png', 'mp4', 'psd', 'm3u8']) {
      const file = path.join(output, `broken.${ext}`); fs.writeFileSync(file, ext === 'm3u8' ? '#EXTM3U\nhttps://example.invalid/no.mp3' : 'broken media')
      const report = await play(file)
      assert.equal(report.error, true, `${ext} 損壞檔必須顯示錯誤`)
      assert.ok(report.elapsedMs < 40000, '損壞檔必須及時回報，不可等到 watchdog')
      console.log(`PASS broken ${ext} — 正常回報錯誤與結束`); reports.push(report)
    }
  }
  if (filter === 'raw' || filter?.startsWith('raw:')) {
    const samples = [
      ['dng', '7317', '4c65b8cda205087cfb94d8931811e53e15eb4df538ad67c1b4a3e76c1185b277'],
      ['cr2', '2102', 'ba644e7dd2abe74eca260e67f0206ff113bf0f62e710f8130611e964d6be5bf1'],
      ['cr3', '4659', '74abb0a113d075ad9887a058082f40dd2a938c4813a08474d82356f11a027778'],
      ['nef', '4282', '268d9a98920a9f3ea3ebf6a2b9ff68b956df74ac0e46b980bee69e7ef3ebc172'],
      ['arw', '1582', 'a35ebb2fbec929daa5beb20d1ce5c15a8aac7b1a7a231455387f3df8a7442e07'],
      ['3fr', '2851', '34fdb93cb215e4f419ae0f7252c57b881fa381003124b4f9c143d27741f211b3']
    ]
    // raw.pixls.us 相機原檔，以上各 sample 皆為 CC0；只在明確選 raw 時下載。
    for (const [ext, id, sha256] of samples) {
      if (filter !== 'raw' && filter !== `raw:${ext}`) continue
      const file = path.join(output, `camera.${ext}`)
      if (!fs.existsSync(file)) {
        const response = await fetch(`https://raw.pixls.us/getfile.php/${id}/nice/sample.${ext}`, { signal: AbortSignal.timeout(180000) })
        assert.equal(response.ok, true, `${ext} fixture HTTP ${response.status}`)
        fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()))
      }
      assert.equal(require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'), sha256)
      const report = await play(file)
      assert.equal(report.loaded && !report.error, true, `${ext}: ${JSON.stringify(report)}`)
      assert.ok(report.video?.w > 0 && report.video?.h > 0, `${ext} 必須解碼出真實畫面：${JSON.stringify(report)}`)
      console.log(`PASS RAW ${ext} — ${report.video.w}×${report.video.h}`); reports.push(report)
    }
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(reports, null, 2))
  console.log(`原生媒體：${reports.length} passed；報告 ${output}`)
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
