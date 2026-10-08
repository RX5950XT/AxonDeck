'use strict'

/**
 * 用 ffmpeg 產生真的媒體檔給 Linux 播放器測試用（不放二進位進倉庫）。
 * 沒有 ffmpeg 回 null，測試自己決定要不要跳過。
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const FFMPEG = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((f) => fs.existsSync(f)) || ''

function ff(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', timeout: 120000 })
  if (r.status !== 0) throw new Error(`ffmpeg 失敗：${args.at(-1)}\n${r.stderr}`)
}

const V = (sec) => ['-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=25:duration=${sec}`]
const A = (sec, freq = 440) => ['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${sec}`]

/**
 * @param {string} dir
 * @param {{ seconds?: number }} [opts]
 */
function makeSamples(dir, opts = {}) {
  if (!FFMPEG) return null
  const sec = opts.seconds || 6
  const out = {
    mp4: path.join(dir, '01 h264.mp4'),
    webm: path.join(dir, '02 vp9.webm'),
    hevc: path.join(dir, '03 hevc.mp4'),
    avi: path.join(dir, '10 mpeg4.avi'),
    srt: path.join(dir, '01 h264.srt'),
    vtt: path.join(dir, '01 h264.zh-TW.vtt'),
    ass: path.join(dir, '01 h264.ass'),
    flac: path.join(dir, 'a1.flac'),
    wma: path.join(dir, 'a2.wma'),
    mp3: path.join(dir, 'a10.mp3'),
    m3u: path.join(dir, 'list.m3u8'),
    pls: path.join(dir, 'list.pls'),
    txt: path.join(dir, 'notes.txt')
  }
  ff([...V(sec), ...A(sec), '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', out.mp4])
  ff([...V(sec), ...A(sec, 660), '-shortest', '-c:v', 'libvpx-vp9', '-b:v', '200k', '-deadline', 'realtime', '-c:a', 'libopus', out.webm])
  ff([...V(sec), ...A(sec), '-shortest', '-c:v', 'libx265', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-c:a', 'aac', out.hevc])
  ff([...V(sec), ...A(sec), '-shortest', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'libmp3lame', out.avi])
  ff([...A(sec, 330), '-c:a', 'flac', out.flac])
  ff([...A(sec, 550), '-c:a', 'wmav2', out.wma])
  ff([...A(sec, 770), '-c:a', 'libmp3lame', out.mp3])
  fs.writeFileSync(out.srt, '\ufeff1\r\n00:00:00,000 --> 00:00:05,000\r\n<i>中文字幕</i> SRT\r\n\r\n2\r\n00:00:05,000 --> 00:00:06,000\r\n第二句\r\n')
  fs.writeFileSync(out.vtt, 'WEBVTT\n\n00:00.000 --> 00:05.000\nVTT 字幕\n')
  fs.writeFileSync(out.ass, '[Script Info]\nScriptType: v4.00+\n')
  fs.writeFileSync(out.m3u, '\ufeff#EXTM3U\n#EXTINF:6,wma\na2.wma\nhttps://example.com/x.mp3\nnotes.txt\nnested.m3u\n"a1.flac"\n')
  fs.writeFileSync(out.pls, '[playlist]\nFile1=a10.mp3\nTitle1=x\nFile2=/etc/passwd\nNumberOfEntries=2\n')
  fs.writeFileSync(out.txt, 'not media')
  return out
}

module.exports = { makeSamples, FFMPEG }
