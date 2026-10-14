'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/speech-script.js'), 'utf8').replace(/^export /gm, '')
const api = vm.runInNewContext(`${source}\n;({ splitSentences, parseSubtitles, applyPronunciations, formatTime })`)
const plain = (value) => JSON.parse(JSON.stringify(value))

const sentences = plain(api.splitSentences('今天天氣很好，我們去公園散步吧。好！\n\n第二段開始了，這是一個比較長的句子。結束'))
assert.deepEqual(sentences.map((s) => s.text), ['今天天氣很好，我們去公園散步吧。', '好！', '第二段開始了，這是一個比較長的句子。', '結束'])
assert.deepEqual(sentences.map((s) => s.gap), [0.3, 0.7, 0.3, 0], '段落尾停久一點、最後一句不停')
assert.ok(plain(api.splitSentences('啊。'.repeat(100))).every((s) => s.text.length <= 80), '短句合併但不超過 80 字')
assert.deepEqual(plain(api.splitSentences('  \n ')), [])

const srt = '1\n00:00:01,000 --> 00:00:02,500\n小明：你好嗎？\n\n2\n00:00:03,000 --> 00:00:04,000\n<i>我很好</i>\n'
assert.deepEqual(plain(api.parseSubtitles('a.srt', srt)), { speakers: ['小明', ''], cues: [
  { start: 1, end: 2.5, text: '你好嗎？', speaker: '小明' }, { start: 3, end: 4, text: '我很好', speaker: '' }] })
const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000\n<v Alice>Hi there</v>\n\n00:00.500 --> 00:00.900\n<v Bob>Early</v>'
const parsedVtt = plain(api.parseSubtitles('b.vtt', vtt))
assert.deepEqual(parsedVtt.cues.map((c) => [c.speaker, c.text, c.start]), [['Bob', 'Early', 0.5], ['Alice', 'Hi there', 1]], '依時間排序')
const ass = '[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,阿華,0,0,0,,{\\b1}嗨，你好\\N再見'
assert.deepEqual(plain(api.parseSubtitles('c.ass', ass)).cues, [{ start: 1, end: 2, text: '嗨，你好 再見', speaker: '阿華' }])
assert.throws(() => api.parseSubtitles('d.txt', srt), /只支援/)
assert.throws(() => api.parseSubtitles('e.srt', 'nothing'), /沒有可以配音/)

const dict = [{ word: '重', sound: '眾' }, { word: '重慶', sound: '崇慶' }, { word: 'a.b', sound: 'A點B' }]
assert.equal(api.applyPronunciations('重慶很重，a.b 不是 axb', dict), '崇慶很眾，A點B 不是 axb', '長詞先換、特殊字元照字面')
assert.equal(api.applyPronunciations('不變', []), '不變')
assert.equal(api.formatTime(75.9), '01:15')
console.log('PASS 文字轉語音稿子：分句與停頓、SRT/VTT/ASS 角色與時間、讀音字典、時間格式')
