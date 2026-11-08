// 真工具實測（要先 build:media、build:shell）：node scripts/probe-explorer-media-thumbs.js
// 媒體縮圖走 mpv／magick＋磁碟快取；沒有關聯的副檔名不交給 Windows。
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { execFileSync } = require('child_process')
const { tempDir, removeTree } = require('./lib/test-temp')

const root = tempDir('vi-media-thumbs-')
const userData = path.join(root, 'userdata')
const launched = []
const edited = []
const originalLoad = Module._load
Module._load = function (name) {
  if (name === 'electron') {
    return {
      app: { getPath: () => userData },
      shell: { openPath: async (target) => { launched.push(target); return '' } },
      nativeImage: {}
    }
  }
  return originalLoad.apply(this, arguments)
}
const thumbs = require('../src/main/explorer/media-thumbs')
const player = require('../src/main/media-player')
const shell = require('../src/main/explorer/shell')
Module._load = originalLoad
player.setEditorOpener(async (file, opts) => { if (!opts?.force) return false; edited.push(file); return true })

const ffmpeg = require('ffmpeg-static')
const make = (...args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true })

async function settle(file, size, seconds = 60) {
  const until = Date.now() + seconds * 1000
  for (;;) {
    const state = await thumbs.find(file, size) || await thumbs.generate(file, size)
    if (!state?.working) return state
    assert.ok(Date.now() < until, `等太久：${path.basename(file)}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

;(async () => {
  try {
    const clip = path.join(root, 'clip[1] 100%.flv')
    make('-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=4', '-c:v', 'flv', clip)
    const cover = path.join(root, 'cover.png')
    make('-f', 'lavfi', '-i', 'testsrc2=s=600x600', '-frames:v', '1', cover)
    const song = path.join(root, 'song.mp3')
    make('-f', 'lavfi', '-i', 'sine=d=3', '-i', cover, '-map', '0', '-map', '1', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', song)
    const bare = path.join(root, 'bare.mp3')
    make('-f', 'lavfi', '-i', 'sine=d=3', bare)
    const tif = path.join(root, 'big.tif')
    make('-f', 'lavfi', '-i', 'testsrc2=s=4000x3000', '-frames:v', '1', tif)

    const video = await settle(clip, 256)
    assert.match(video?.url || '', /^data:image\/jpeg;base64,/, '影片要有圖（殼層解不了 FLV）')
    const started = Date.now()
    assert.equal((await thumbs.find(clip, 200)).url, video.url, '同一級尺寸共用快取')
    console.log(`PASS 影片 ${video.url.length} 字元，快取命中 ${Date.now() - started}ms`)
    assert.notEqual((await settle(clip, 512)).url, video.url, '512 是另一張')
    console.log('PASS 512 另存')

    assert.match((await settle(song, 256))?.url || '', /^data:image\/jpeg;base64,/, '音樂封面')
    assert.deepEqual(await settle(bare, 256), { none: true }, '沒封面的音樂回 none，不要一直等')
    console.log('PASS 音樂封面／沒封面')

    assert.equal(await thumbs.find(tif, 256), null, '圖片沒快取要先問殼層')
    assert.match((await settle(tif, 256))?.url || '', /^data:image\/webp;base64,/, 'magick 接手大 TIFF')
    assert.match((await thumbs.find(tif, 256))?.url || '', /^data:image\/webp/, '第二次直接讀快取')
    console.log('PASS magick＋快取')

    fs.utimesSync(clip, new Date(), new Date(Date.now() + 5000))
    assert.match((await settle(clip, 256))?.url || '', /^data:image\/jpeg/, '檔案改過要重做')
    assert.equal(fs.readdirSync(path.join(userData, 'thumb-cache')).filter((n) => n.endsWith('.jpg')).length, 4, '多了一張新的')
    console.log('PASS 改過重做')

    assert.deepEqual(fs.readdirSync(path.join(userData, 'thumb-cache')).filter((n) => n.startsWith('tmp-')), [], '不留暫存')

    assert.equal(await shell.associationOf('.xyzunknown'), 'none', '沒登記的副檔名')
    assert.equal(await shell.associationOf(''), 'none', '沒有副檔名')
    // 這些都不是一般的 open 指令：lnk 靠殼層、iso 預設動詞是掛載，判錯就開不了
    for (const ext of ['.exe', '.txt', '.lnk', '.pdf', '.bat', '.iso', '.url']) assert.equal(await shell.associationOf(ext), 'default', ext)
    console.log('PASS 關聯查詢')

    const note = path.join(root, 'note.xyzunknown')
    fs.writeFileSync(note, '純文字\n第二行\n')
    assert.equal(await player.openPath(note), '')
    assert.deepEqual(edited, [note], '文字開自家編輯器')
    const blob = path.join(root, 'blob.xyzunknown')
    fs.writeFileSync(blob, Buffer.from([0, 1, 2, 255, 0]))
    await assert.rejects(player.openPath(blob), { code: 'NO_APP' })
    assert.deepEqual(launched, [], '沒有關聯就不准交給 Windows')
    const plain = path.join(root, 'known.lnk')
    fs.writeFileSync(plain, '')
    await player.openPath(plain)
    assert.deepEqual(launched, [plain], '有關聯照舊交給 Windows')
    console.log('PASS 未知副檔名')
  } finally {
    shell.shutdown()
    removeTree(root)
  }
})().catch((error) => { console.error(error); process.exitCode = 1 })
