'use strict'

const TARGETS = new Set(['zh-TW', 'zh-CN', 'en', 'ja', 'ko'])
const MAX_PDF_BYTES = 2 * 1024 * 1024 * 1024
const MAX_LINE_BYTES = 4 * 1024 * 1024
const STAGES = new Set(['opening', 'ocr', 'translate', 'render', 'saving'])
const WARNING_CODES = new Set(['overflow', 'untranslated', 'unsupported', 'spotting', 'small_text'])

function fail(code, message) { return Object.assign(new Error(message), { code, userMessage: message }) }

function validateOptions(options) {
  if (!options || typeof options.fileId !== 'string' || !/^[a-f0-9-]{36}$/.test(options.fileId)) {
    throw fail('INVALID_FILE', '請先選擇 PDF 檔案')
  }
  if (!TARGETS.has(options.targetLang)) throw fail('INVALID_LANGUAGE', '不支援這個翻譯語言')
  const sourceLang = options.sourceLang || 'auto'
  if (sourceLang !== 'auto' && !TARGETS.has(sourceLang)) throw fail('INVALID_LANGUAGE', '不支援這個來源語言')
  return { fileId: options.fileId, targetLang: options.targetLang, sourceLang }
}

function publicProgress(message) {
  const page = Number.isSafeInteger(message.page) && message.page >= 0 ? message.page : 0
  const pages = Number.isSafeInteger(message.pages) && message.pages >= page ? message.pages : 0
  return { page, pages, stage: STAGES.has(message.stage) ? message.stage : 'ocr' }
}

function warningsOf(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => WARNING_CODES.has(item?.code) && Number.isSafeInteger(item.count) && item.count > 0)
    .slice(0, WARNING_CODES.size).map(({ code, count }) => ({ code, count }))
}

function splitText(text, max = 1800) {
  const chunks = []
  let buffer = ''
  for (const unit of text.split(/(?<=[。．.！!？?…；;\n])/u)) {
    if (buffer && buffer.length + unit.length > max) { chunks.push(buffer); buffer = '' }
    for (const character of unit) {
      if (buffer.length + character.length > max) { chunks.push(buffer); buffer = '' }
      buffer += character
    }
  }
  if (buffer) chunks.push(buffer)
  return chunks
}

module.exports = { fail, validateOptions, publicProgress, warningsOf, splitText, MAX_PDF_BYTES, MAX_LINE_BYTES }
