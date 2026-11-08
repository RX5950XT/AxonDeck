/**
 * 文字轉語音的稿子處理（純函式，不碰 DOM）：聲音範本、分句、字幕解析、讀音字典。
 */

// 聲音設計範本（女聲）。中文描述用簡體：官方範例和表情標籤都是簡體
export const PRESETS = [
  { name: '溫柔知性', zh: '温柔知性的年轻女性，声音清澈柔和，语速适中，像在耐心地向朋友解释一件事。', en: 'A gentle, articulate young woman with a clear, soft voice, speaking at a moderate pace as if patiently explaining something to a friend.' },
  { name: '活潑少女', zh: '活泼开朗的少女，声音明亮甜美，音调偏高，语速稍快，充满朝气和笑意。', en: 'A cheerful, bubbly teenage girl with a bright, sweet, high-pitched voice, speaking a little fast, full of energy and smiles.' },
  { name: '新聞主播', zh: '专业的女新闻主播，声音沉稳清晰，咬字标准，语调平稳有力，正式而可信。', en: 'A professional female news anchor with a steady, crisp voice, precise diction and a confident, even tone. Formal and trustworthy.' },
  { name: '睡前故事', zh: '温暖的年轻妈妈在讲睡前故事，声音轻柔缓慢，带着气声，安静而放松。', en: 'A warm young mother telling a bedtime story, speaking softly and slowly with a slightly breathy, calm and soothing voice.' },
  { name: '親切客服', zh: '亲切有礼的女客服，声音甜美干净，语气热情友善，节奏轻快但不急躁。', en: 'A polite, friendly female customer service agent with a sweet, clean voice, warm and welcoming, upbeat but never rushed.' },
  { name: '成熟沉穩', zh: '成熟沉稳的中年女性，声音低沉有磁性，语速偏慢，从容而有说服力。', en: 'A mature, composed middle-aged woman with a low, rich and resonant voice, speaking slowly with calm confidence.' }
]
export const PRESET_SAMPLE = { zh: '你好，很高興認識你。今天天氣真好，要不要一起出去走走？', en: 'Hi there, it is so nice to meet you. The weather is lovely today, shall we go for a walk?' }

const SENTENCE_GAP = 0.3
const PARAGRAPH_GAP = 0.7
const MAX_SENTENCE = 80

/**
 * 依段落與句末標點切句；太短的相鄰句併在一起（單字句單獨念容易怪），單句不超過 80 字。
 * 回傳 [{ text, gap }]，gap 是這句後面要停多久（秒）。
 */
export function splitSentences(source) {
  const result = []
  const paragraphs = String(source).replace(/\r\n?/g, '\n').split(/\n+/).map((p) => p.trim()).filter(Boolean)
  for (const paragraph of paragraphs) {
    const pieces = paragraph.match(/[^。！？!?；;…]+[。！？!?；;…」』"'）)]*|[。！？!?；;…]+/g) || [paragraph]
    let current = ''
    const flush = () => { if (current.trim()) result.push({ text: current.trim(), gap: SENTENCE_GAP }); current = '' }
    for (const piece of pieces) {
      if (current && (current + piece).length > MAX_SENTENCE) flush()
      current += piece
      if (current.length >= 6) flush()
    }
    flush()
    if (result.length) result[result.length - 1].gap = PARAGRAPH_GAP
  }
  if (result.length) result[result.length - 1].gap = 0
  return result
}

function clock(value) {
  const match = String(value).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/)
  if (!match) throw new Error('字幕時間格式不符')
  const [, h = '0', m, s, frac = '0'] = match
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(frac.padEnd(3, '0')) / 1000
}

function cleanText(value) {
  return value.replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').replace(/\s*\n\s*/g, ' ').trim()
}

/**
 * SRT／VTT／ASS 字幕 → { speakers: [名稱], cues: [{ start, end, text, speaker }] }。
 * 角色只認明確標註的（VTT 的 <v 名字>、ASS 的 Name 欄、行首「名字：」），不從內容猜。
 */
export function parseSubtitles(name, content) {
  const extension = String(name).split('.').pop().toLowerCase()
  if (!['srt', 'vtt', 'ass', 'ssa'].includes(extension)) throw new Error('只支援 SRT、VTT、ASS 字幕')
  const source = String(content).replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim()
  const cues = []
  const add = (start, end, raw, speaker = '') => {
    let text = cleanText(raw)
    const named = !speaker && text.match(/^([^：:\s]{1,20})[：:]\s*(.+)$/)
    if (named) { speaker = named[1]; text = named[2] }
    if (text && end > start) cues.push({ start, end, text, speaker: speaker.trim().slice(0, 60) })
  }
  if (extension === 'ass' || extension === 'ssa') {
    let events = false
    let fields = []
    for (const line of source.split('\n')) {
      if (line.trim().startsWith('[')) events = line.trim().toLowerCase() === '[events]'
      if (!events) continue
      if (/^Format:/i.test(line)) fields = line.slice(line.indexOf(':') + 1).split(',').map((v) => v.trim().toLowerCase())
      if (!/^Dialogue:/i.test(line) || fields.at(-1) !== 'text') continue
      const values = line.slice(line.indexOf(':') + 1).split(',')
      const field = (key) => values[fields.indexOf(key)]?.trim() ?? ''
      // 文字欄可能有逗號，接回去
      const text = values.slice(fields.length - 1).join(',').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ')
      add(clock(field('start')), clock(field('end')), text, field('name') || field('actor'))
    }
  } else {
    for (const block of source.split(/\n[ \t]*\n/)) {
      const lines = block.split('\n')
      const index = lines.findIndex((line) => line.includes('-->'))
      if (index < 0 || index > 1) continue
      const match = lines[index].match(/^(\S+)\s+-->\s+(\S+)/)
      if (!match) continue
      const body = lines.slice(index + 1).join('\n')
      const voice = body.match(/^<v(?:\.[^\s>]+)*\s+([^>]+)>/i)
      add(clock(match[1]), clock(match[2]), body, voice ? voice[1] : '')
    }
  }
  if (!cues.length) throw new Error('字幕裡沒有可以配音的台詞')
  if (cues.length > 2000) throw new Error('字幕超過 2000 句，請分批匯入')
  cues.sort((a, b) => a.start - b.start)
  return { speakers: [...new Set(cues.map((cue) => cue.speaker))], cues }
}

/** 套用讀音字典：長詞先換，避免「重」把「重慶」吃掉。 */
export function applyPronunciations(text, list) {
  const entries = (Array.isArray(list) ? list : []).filter((item) => item?.word && item?.sound)
    .sort((a, b) => b.word.length - a.word.length)
  if (!entries.length) return text
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(entries.map((item) => escape(item.word)).join('|'), 'g')
  const map = new Map(entries.map((item) => [item.word, item.sound]))
  return text.replace(pattern, (word) => map.get(word))
}

export function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0)
  const m = Math.floor(value / 60)
  const s = Math.floor(value % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
