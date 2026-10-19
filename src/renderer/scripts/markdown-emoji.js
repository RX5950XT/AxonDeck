/**
 * `:smile:` → 😄。對照表（gemoji，GitHub 用的那份）三百多 KB，第一次碰到才載。
 */

const GEMOJI = new URL('../../../node_modules/gemoji/index.js', import.meta.url).href

/** @type {Record<string, string> | null} */
let names = null
/** @type {Promise<void> | null} */
let loading = null

function load() {
  loading ||= import(GEMOJI).then((mod) => { names = mod.nameToEmoji }, (error) => {
    loading = null
    throw error
  })
  return loading
}

/**
 * @param {string} name
 * @returns {string | null | undefined} 表情；null＝沒有這個名字；undefined＝對照表還沒載好
 */
export function emojiFor(name) {
  if (!names) return undefined
  return Object.hasOwn(names, name) ? names[name] : null
}

/**
 * 對照表還沒載好時：先放原文，載好再換（不是表情就維持原文）
 * @param {HTMLElement} span
 * @param {string} name
 */
export function mountEmoji(span, name) {
  // 載不到就一直是 `:name:` 原文，跟沒支援時一樣
  load().then(() => {
    const emoji = emojiFor(name)
    if (emoji) span.textContent = emoji
  }, () => {})
}
