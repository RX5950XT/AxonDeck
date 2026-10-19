/**
 * 隱藏 iframe 裡跑 mermaid（見 markdown-mermaid.js）。
 *
 * 不跟主頁同一個全域：mermaid 打包進來的函式庫有 UMD 包裝，看到 Monaco 的 AMD `define`
 * 就把自己交給它（Monaco 正在載語法模組時直接炸「Can only have one anonymous define call」），
 * 模組匯出也跟著不見。這裡沒有 Monaco，`define` 不存在。
 */

// renderer 沒有 bundler：直接載自包含的 ESM 版（打包只帶這支＋它的 chunks，見 package.json build.files）
import mermaid from '../../../node_modules/mermaid/dist/mermaid.esm.min.mjs'

let theme = ''
let seq = 0

/**
 * @param {string} source
 * @param {'default' | 'dark'} wanted
 * @returns {Promise<string>} SVG 原始碼
 */
window.renderMermaid = async (source, wanted) => {
  if (theme !== wanted) {
    mermaid.initialize({
      startOnLoad: false, securityLevel: 'strict', theme: wanted,
      htmlLabels: false, flowchart: { htmlLabels: false },
      fontFamily: '"Segoe UI", "Microsoft JhengHei", "Noto Sans TC", sans-serif'
    })
    theme = wanted
  }
  const id = `m${++seq}`
  try {
    return (await mermaid.render(id, source)).svg
  } finally {
    // 語法錯誤時 mermaid 可能把暫存節點（`d<id>`）留在 body
    document.getElementById(`d${id}`)?.remove()
  }
}
