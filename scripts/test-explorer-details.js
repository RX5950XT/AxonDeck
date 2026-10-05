#!/usr/bin/env node
/**
 * 檔案頁「詳細資訊」依類型補的段落：ffmpeg 檔頭解析、文字檔統計、屬性系統分組。
 * 真的叫 ffmpeg 跑一次自己產的影音檔（有裝 ffmpeg-static 才跑）。
 *
 *   node scripts/test-explorer-details.js
 */

'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { tempDir } = require('./lib/test-temp')
const { parseProbe, textFacts, groupProps, details } = require('../src/main/explorer/details')

const fact = (groups, title, key) => groups.find((g) => g.title === title)?.facts.find((f) => f[0] === key)?.[1]

const PHONE_VIDEO = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'IMG_0001.MOV':
  Metadata:
    major_brand     : qt
    creation_time   : 2025-05-01T02:20:30.000000Z
    com.apple.quicktime.location.ISO6709: +25.0330+121.5654+010.000/
    com.apple.quicktime.make: Apple
    com.apple.quicktime.model: iPhone 15 Pro
    com.apple.quicktime.software: 17.2
  Duration: 00:01:05.43, start: 0.000000, bitrate: 24567 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 3840x2160, 24300 kb/s, 59.94 fps, 59.94 tbr, 600 tbn (default)
    Metadata:
      creation_time   : 2025-05-01T02:20:30.000000Z
    Side data:
      displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 256 kb/s (default)
  Stream #0:2[0x3](eng): Subtitle: mov_text (tx3g / 0x67337874), 0 kb/s
At least one output file must be specified`

const SONG = `Input #0, flac, from 'a.flac':
  Metadata:
    TITLE           : 歌名
    ARTIST          : 歌手
    ALBUM           : 專輯
    DATE            : 2024
  Duration: 00:03:20.00, start: 0.000000, bitrate: 1411 kb/s
  Stream #0:0: Audio: flac, 96000 Hz, 5.1(side), s32 (24 bit)
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 600x600, 90k tbr, 90k tbn (attached pic)`

console.log('[A] 手機影片')
{
  const g = parseProbe(PHONE_VIDEO)
  assert.strictEqual(fact(g, '媒體', '長度'), '1:05')
  assert.strictEqual(fact(g, '媒體', '總位元率'), '24,567 kbps')
  assert.strictEqual(fact(g, '視訊', '編碼'), 'H.265 (HEVC) · Main 10')
  assert.strictEqual(fact(g, '視訊', '解析度'), '3840 × 2160')
  assert.strictEqual(fact(g, '視訊', '幀率'), '59.94 fps')
  assert.strictEqual(fact(g, '視訊', '視訊位元率'), '24,300 kbps')
  assert.strictEqual(fact(g, '視訊', '色彩深度'), '10 位元')
  assert.strictEqual(fact(g, '視訊', 'HDR'), 'HLG')
  assert.strictEqual(fact(g, '視訊', '旋轉'), '90°')
  assert.strictEqual(fact(g, '音訊', '取樣率'), '48 kHz')
  assert.strictEqual(fact(g, '音訊', '聲道'), '立體聲')
  assert.strictEqual(fact(g, '音訊', '音訊位元率'), '256 kbps')
  assert.strictEqual(fact(g, '字幕', '軌數'), '1')
  assert.strictEqual(fact(g, '標籤', '裝置型號'), 'iPhone 15 Pro')
  assert.strictEqual(fact(g, '標籤', '拍攝位置'), '25.033, 121.5654')
  assert.ok(fact(g, '標籤', '建立時間').startsWith('2025/5/1'), fact(g, '標籤', '建立時間'))
  console.log('  PASS')
}

console.log('[B] 音樂（封面、24 位元、5.1、大寫標籤）')
{
  const g = parseProbe(SONG)
  assert.strictEqual(fact(g, '音訊', '取樣率'), '96 kHz')
  assert.strictEqual(fact(g, '音訊', '位元深度'), '24 位元')
  assert.strictEqual(fact(g, '音訊', '聲道'), '5.1 聲道')
  assert.strictEqual(fact(g, '媒體', '封面'), '有（600 × 600）')
  assert.ok(!g.some((x) => x.title === '視訊'), '封面不算視訊軌')
  assert.strictEqual(fact(g, '標籤', '演出者'), '歌手')
  assert.strictEqual(fact(g, '媒體', '長度'), '3:20')
  console.log('  PASS')
}

console.log('[C] 文字檔')
{
  const crlf = textFacts(Buffer.from('a\r\nb\r\n中文'), false)
  assert.deepStrictEqual(Object.fromEntries(crlf), { 編碼: 'UTF-8', 換行: 'CRLF（Windows）', 行數: '3', 字元數: '8' })
  const bom = Object.fromEntries(textFacts(Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a]), false))
  assert.strictEqual(bom.編碼, 'UTF-8（含 BOM）')
  assert.strictEqual(bom.行數, '1')
  const big5 = Object.fromEntries(textFacts(Buffer.from([0xa4, 0xa4, 0xa4, 0xe5, 0x0a]), false))
  assert.ok(big5.編碼.startsWith('非 UTF-8'), big5.編碼)
  assert.strictEqual(Object.fromEntries(textFacts(Buffer.from('a\nb\r\n'), false)).換行, '混合：CRLF（Windows）、LF（Unix）')
  console.log('  PASS')
}

console.log('[D] 屬性系統分組')
{
  const g = groupProps([
    { name: 'System.Photo.CameraModel', value: 'iPhone 15 Pro' },
    { name: 'System.Photo.FNumber', value: 'f/1.8' },
    { name: 'System.Image.HorizontalSize', value: '4032 個像素' },
    { name: 'System.Image.VerticalSize', value: '3024 個像素' },
    { name: 'System.GPS.Latitude', value: '25; 1; 58.8000000000029175' },
    { name: 'System.GPS.LatitudeRef', value: 'N' },
    { name: 'System.GPS.Longitude', value: '121; 33; 55.4400000000025273' },
    { name: 'System.GPS.LongitudeRef', value: 'E' },
    { name: 'System.GPS.Altitude', value: '10' },
    { name: 'System.FileVersion', value: '‪1.35.1.0‬' }
  ])
  assert.strictEqual(fact(g, '相機', '相機型號'), 'iPhone 15 Pro')
  assert.strictEqual(fact(g, '影像', '尺寸'), '4032 × 3024')
  assert.strictEqual(fact(g, '影像', '像素'), '約 1,219 萬像素（12.2 MP）')
  assert.strictEqual(fact(g, '位置', '緯度'), '25°1′58.8″ N')
  assert.strictEqual(fact(g, '位置', '座標'), '25.033000, 121.565400')
  assert.strictEqual(fact(g, '位置', '高度'), '10 公尺')
  assert.strictEqual(fact(g, '程式', '檔案版本'), '1.35.1.0', '方向控制字元要拿掉')
  assert.deepStrictEqual(g.map((x) => x.title), ['相機', '影像', '位置', '程式'])
  console.log('  PASS')
}

async function realFfmpeg() {
  let bin
  try { bin = require('ffmpeg-static') } catch { bin = '' }
  if (!bin || !fs.existsSync(bin)) { console.log('[E] SKIP 沒有 ffmpeg-static'); return }
  console.log('[E] 真的 ffmpeg：自己產一支有聲音的影片')
  const dir = tempDir('axondeck-details-')
  const file = path.join(dir, 'clip.mp4')
  execFileSync(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', '-b:a', '128k',
    '-metadata', 'title=測試', file])
  const g = (await details(file)).groups
  assert.strictEqual(fact(g, '視訊', '解析度'), '1280 × 720', JSON.stringify(g))
  assert.strictEqual(fact(g, '視訊', '幀率'), '25 fps')
  assert.strictEqual(fact(g, '音訊', '取樣率'), '44.1 kHz')
  assert.strictEqual(fact(g, '標籤', '標題'), '測試')
  const txt = path.join(dir, 'a.txt')
  fs.writeFileSync(txt, 'x\ny\n')
  assert.strictEqual(fact((await details(txt)).groups, '文字', '行數'), '2')
  console.log('  PASS')
}

realFfmpeg().catch((e) => { console.error(e); process.exitCode = 1 })
