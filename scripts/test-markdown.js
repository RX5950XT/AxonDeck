/**
 * markdown.js 自檢（node 直跑，零依賴）
 *   node scripts/test-markdown.js
 *
 * markdown.js 是 ESM 而專案 package.json 無 type:module，
 * 直接 import 會被 node 當 CJS 解析而炸；改用 vm 載入原始碼 + DOM shim。
 * shim 的 innerHTML 是會丟例外的 setter → 只要 markdown.js 用到就當場失敗。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

// ===== 極簡 DOM shim =====

function textNode(data) {
  return { nodeType: 3, data: String(data) }
}

function makeNode(tag) {
  const node = {
    nodeType: tag === '#fragment' ? 11 : 1,
    tagName: tag.toUpperCase(),
    className: '',
    attributes: {},
    childNodes: [],
    appendChild(child) {
      this.childNodes.push(child)
      return child
    },
    setAttribute(key, value) {
      this.attributes[key] = String(value)
    },
    addEventListener() {}
  }
  Object.defineProperty(node, 'textContent', {
    get() {
      return textOf(this)
    },
    set(value) {
      this.childNodes = [textNode(value)]
    }
  })
  // 用到 innerHTML 就當場炸 → 「零 innerHTML」是可執行的斷言，不是註解
  Object.defineProperty(node, 'innerHTML', {
    get() {
      throw new Error('markdown.js 讀了 innerHTML')
    },
    set() {
      throw new Error('markdown.js 寫了 innerHTML')
    }
  })
  return node
}

const documentShim = {
  createElement: (tag) => makeNode(tag),
  createTextNode: (t) => textNode(t),
  createDocumentFragment: () => makeNode('#fragment')
}

function textOf(node) {
  if (node.nodeType === 3) return node.data
  if (node.tagName === 'BR') return '\n'
  return node.childNodes.map(textOf).join('')
}

function findAll(node, tagName) {
  const out = []
  const walk = (n) => {
    if (n.nodeType !== 3 && n.tagName === tagName.toUpperCase()) out.push(n)
    if (n.childNodes) n.childNodes.forEach(walk)
  }
  walk(node)
  return out
}

function findByClass(node, cls) {
  const out = []
  const walk = (n) => {
    if (n.nodeType !== 3 && String(n.className).split(/\s+/).includes(cls)) out.push(n)
    if (n.childNodes) n.childNodes.forEach(walk)
  }
  walk(node)
  return out
}

// ===== 載入受測模組 =====

// 語法比對式拆在 markdown-syntax.js：接在前面一起載
const src = ['markdown-syntax.js', 'markdown.js']
  .map((name) => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'scripts', name), 'utf8'))
  .join('\n')
  .replace(/^export /gm, '')
  .replace(/^import [^;]*?from '[^']+'$/gm, '')
// 內嵌 HTML 白名單與 mermaid 要真 DOM（DOMParser／img），這裡只驗 markdown.js 什麼時候交給它們
const handoff = { html: [], tags: [], mermaid: [], code: [], math: [], emoji: [] }
const sandbox = {
  document: documentShim, URL,
  sanitizeHtml: (html) => {
    handoff.html.push(html)
    const frag = makeNode('#fragment')
    frag.querySelectorAll = () => []
    return frag
  },
  cleanTag: (tag) => { handoff.tags.push(tag); return makeNode('kbd') },
  mountMermaid: (box, pre, source) => handoff.mermaid.push(source),
  highlightCode: (code, lang) => handoff.code.push(lang),
  mountMath: (node, source, display) => { handoff.math.push({ source, display }); node.textContent = source },
  // 對照表當成已載好：smile 有、其他沒有
  emojiFor: (name) => (name === 'smile' ? '😄' : null),
  mountEmoji: (span, name) => handoff.emoji.push(name)
}
vm.createContext(sandbox)
vm.runInContext(`${src}\n;globalThis.__render = renderMarkdown; globalThis.__resolve = resolveLinkPath; globalThis.__slice = previewSlice; globalThis.__max = PREVIEW_MAX_CHARS;`, sandbox)
const resolveLinkPath = sandbox.__resolve
/** @type {(text: string) => any} */
const renderMarkdown = sandbox.__render

// ===== 測試 =====

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (e) {
    failed++
    console.log(`  FAIL  ${name}\n        ${e.message}`)
  }
}

console.log('\n[A] XSS / 注入')

check('img onerror 不產生 IMG 元素，只留文字', () => {
  const frag = renderMarkdown('看這個 <img src=x onerror=alert(1)> 好嗎')
  assert.strictEqual(findAll(frag, 'img').length, 0)
  assert.ok(textOf(frag).includes('<img src=x onerror=alert(1)>'))
})

check('script 標籤不產生 SCRIPT 元素', () => {
  const frag = renderMarkdown('<script>alert(1)</script>')
  assert.strictEqual(findAll(frag, 'script').length, 0)
  assert.ok(textOf(frag).includes('<script>alert(1)</script>'))
})

check('javascript: 連結不產生 <a>，降級純文字', () => {
  const frag = renderMarkdown('[點我](javascript:alert(1))')
  assert.strictEqual(findAll(frag, 'a').length, 0)
  assert.ok(textOf(frag).includes('javascript:alert(1)'))
})

check('data: 連結不產生 <a>', () => {
  const frag = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)')
  assert.strictEqual(findAll(frag, 'a').length, 0)
})

check('https 連結產生 <a> 並帶 noopener noreferrer', () => {
  const frag = renderMarkdown('[範例](https://example.com/a?b=1)')
  const links = findAll(frag, 'a')
  assert.strictEqual(links.length, 1)
  assert.strictEqual(links[0].attributes.href, 'https://example.com/a?b=1')
  assert.strictEqual(links[0].attributes.rel, 'noopener noreferrer')
  assert.strictEqual(links[0].attributes.target, '_blank')
  assert.strictEqual(textOf(links[0]), '範例')
})

check('mailto 連結允許', () => {
  assert.strictEqual(findAll(renderMarkdown('[m](mailto:a@b.c)'), 'a').length, 1)
})

console.log('\n[B] 區塊語法')

check('圍欄碼塊：語言標籤、複製鈕、內容不再解析行內語法', () => {
  const frag = renderMarkdown('```js\nconst a = **1**\n```')
  const boxes = findByClass(frag, 'md-code')
  assert.strictEqual(boxes.length, 1)
  assert.strictEqual(findByClass(frag, 'md-code-lang')[0].textContent, 'js')
  assert.strictEqual(findByClass(frag, 'md-copy').length, 1)
  assert.strictEqual(findAll(frag, 'strong').length, 0)
  assert.strictEqual(textOf(findAll(frag, 'code')[0]), 'const a = **1**')
})

check('串流中未封閉的碼塊不丟例外，標記 md-code-open', () => {
  const frag = renderMarkdown('說明：\n```python\nprint(1)')
  assert.strictEqual(findByClass(frag, 'md-code-open').length, 1)
  assert.ok(textOf(frag).includes('print(1)'))
})

check('無語言的碼塊標 text', () => {
  const frag = renderMarkdown('```\nplain\n```')
  assert.strictEqual(findByClass(frag, 'md-code-lang')[0].textContent, 'text')
})

check('表格：thead 1 列、tbody 2 列、對齊 class', () => {
  const md = '| 名稱 | 數量 |\n|:---|---:|\n| a | 1 |\n| b | 2 |'
  const frag = renderMarkdown(md)
  assert.strictEqual(findAll(frag, 'table').length, 1)
  assert.strictEqual(findAll(frag, 'th').length, 2)
  assert.strictEqual(findAll(frag, 'td').length, 4)
  assert.strictEqual(findAll(frag, 'th')[1].className, 'md-right')
  assert.strictEqual(textOf(findAll(frag, 'td')[0]), 'a')
})

check('--- 是分隔線，不是表格', () => {
  const frag = renderMarkdown('上\n\n---\n\n下')
  assert.strictEqual(findAll(frag, 'hr').length, 1)
  assert.strictEqual(findAll(frag, 'table').length, 0)
})

check('標題層級正確、行內語法生效', () => {
  const frag = renderMarkdown('### 標題 **粗**')
  assert.strictEqual(findAll(frag, 'h3').length, 1)
  assert.strictEqual(findAll(frag, 'strong').length, 1)
})

check('無序與有序清單，ol 帶 start', () => {
  const ul = renderMarkdown('- a\n- b\n- c')
  assert.strictEqual(findAll(ul, 'ul').length, 1)
  assert.strictEqual(findAll(ul, 'li').length, 3)
  const ol = renderMarkdown('3. x\n4. y')
  assert.strictEqual(findAll(ol, 'ol')[0].attributes.start, '3')
  assert.strictEqual(findAll(ol, 'li').length, 2)
})

check('引用可遞迴，深層不爆堆疊', () => {
  const frag = renderMarkdown('> 一層\n> > 二層')
  assert.ok(findAll(frag, 'blockquote').length >= 1)
  assert.doesNotThrow(() => renderMarkdown('> > > > > > 深'))
})

check('段落內換行變 <br>', () => {
  const frag = renderMarkdown('第一行\n第二行')
  assert.strictEqual(findAll(frag, 'p').length, 1)
  assert.strictEqual(findAll(frag, 'br').length, 1)
})

console.log('\n[C] 行內語法')

check('行內碼優先於粗體', () => {
  const frag = renderMarkdown('`**不是粗體**`')
  assert.strictEqual(findAll(frag, 'strong').length, 0)
  assert.strictEqual(textOf(findAll(frag, 'code')[0]), '**不是粗體**')
})

check('粗體 / 斜體 / 刪除線', () => {
  const frag = renderMarkdown('**粗** *斜* ~~刪~~')
  assert.strictEqual(findAll(frag, 'strong').length, 1)
  assert.strictEqual(findAll(frag, 'em').length, 1)
  assert.strictEqual(findAll(frag, 'del').length, 1)
})

check('snake_case 不會被誤判成斜體', () => {
  const frag = renderMarkdown('變數 foo_bar_baz 與 my_var_name 保持原樣')
  assert.strictEqual(findAll(frag, 'em').length, 0)
  assert.ok(textOf(frag).includes('foo_bar_baz'))
})

check('乘法星號不會被誤判成斜體', () => {
  const frag = renderMarkdown('2 * 3 * 4 = 24')
  assert.strictEqual(findAll(frag, 'em').length, 0)
})

console.log('\n[D] 邊界輸入')

check('null / undefined / 空字串不丟例外', () => {
  assert.doesNotThrow(() => renderMarkdown(null))
  assert.doesNotThrow(() => renderMarkdown(undefined))
  assert.strictEqual(renderMarkdown('').childNodes.length, 0)
})

check('CRLF 正規化', () => {
  const frag = renderMarkdown('a\r\n\r\nb')
  assert.strictEqual(findAll(frag, 'p').length, 2)
})

check('未配對的標記原樣輸出', () => {
  const frag = renderMarkdown('這裡有 ** 和 ` 沒配對')
  assert.strictEqual(findAll(frag, 'strong').length, 0)
  assert.strictEqual(findAll(frag, 'code').length, 0)
  assert.ok(textOf(frag).includes('**'))
})

check('長輸入（5000 行）在 2 秒內完成', () => {
  const big = Array.from({ length: 5000 }, (_, i) => `第 ${i} 行 **粗體** 與 \`碼\``).join('\n')
  const t0 = Date.now()
  renderMarkdown(big)
  assert.ok(Date.now() - t0 < 2000, `耗時 ${Date.now() - t0}ms`)
})

check('Markdown 網路圖片顯示 IMG 與 alt，不變成連結', () => {
  const frag = renderMarkdown('![範例](https://example.com/a.png)')
  assert.strictEqual(findAll(frag, 'img').length, 1)
  assert.strictEqual(findAll(frag, 'img')[0].attributes.alt, '範例')
  assert.strictEqual(findAll(frag, 'a').length, 0)
})
check('專案相對圖片依 Markdown 所在資料夾解析，根目錄圖片也可用', () => {
  const frag = renderMarkdown('> ![圖](../images/pic.png)\n\n![根](/images/root.png)', 0, 'vi-media://token/project/docs/readme.md')
  assert.deepStrictEqual(findAll(frag, 'img').map((n) => n.attributes.src), [
    'vi-media://token/project/images/pic.png', 'vi-media://token/project/images/root.png'
  ])
})
check('危險圖片與越出專案的相對圖片維持文字', () => {
  for (const url of ['javascript:bad', 'file:///secret.png', '../../secret.png', '//evil.test/p.png']) {
    assert.strictEqual(findAll(renderMarkdown(`![圖](${url})`, 0, 'vi-media://token/project/readme.md'), 'img').length, 0)
  }
})
check('表格中的跳脫直線不會多切一欄', () => {
  const frag = renderMarkdown('| A\\|B | 值 |\n| --- | --- |\n| x | 80.8 |')
  assert.strictEqual(findAll(frag, 'th').length, 2)
  assert.strictEqual(findAll(frag, 'th')[0].textContent, 'A|B')
  assert.strictEqual(findAll(frag, 'td').length, 2)
})
const FENCE = '```'
check('mermaid：收尾的碼塊交給 mountMermaid，串流中還沒收尾的不畫', () => {
  handoff.mermaid.length = 0
  renderMarkdown(`${FENCE}mermaid
graph TD
  A --> B
${FENCE}`)
  renderMarkdown(`${FENCE}mermaid
graph TD`)
  assert.deepStrictEqual(handoff.mermaid, [`graph TD
  A --> B`])
})
check('沒開 html（聊天）：HTML 照舊是文字', () => {
  handoff.html.length = 0
  const frag = renderMarkdown(`<p align="center"><img src="a.png"></p>

<kbd>x</kbd>`)
  assert.strictEqual(handoff.html.length, 0)
  assert.ok(textOf(frag).includes('<p align="center">'))
  assert.ok(textOf(frag).includes('<kbd>x</kbd>'))
})
check('開 html：區塊 HTML 吃到空行，後面照 Markdown', () => {
  handoff.html.length = 0
  const frag = renderMarkdown(`<p align="center">
<img src="a.png"></p>

# AxonDeck`, 0, '', { html: true })
  assert.deepStrictEqual(handoff.html, [`<p align="center">
<img src="a.png"></p>`])
  assert.strictEqual(findAll(frag, 'h1').length, 1)
})
check('開 html：<details> 沒在第一段收尾，中間照畫 Markdown，配對的 </details> 後面繼續', () => {
  handoff.html.length = 0
  const frag = renderMarkdown(`<details>
<summary>更多</summary>

- 一
- 二

</details>

## 後面`, 0, '', { html: true })
  assert.deepStrictEqual(handoff.html, [`<details>
<summary>更多</summary>`])
  assert.strictEqual(findAll(frag, 'li').length, 2)
  assert.strictEqual(findAll(frag, 'h2').length, 1)
})
check('開 html：行內標籤交給 cleanTag，行內碼裡的標籤不動', () => {
  handoff.tags.length = 0
  const frag = renderMarkdown('按 <kbd>Ctrl</kbd> 換行<br>看 `<br>`', 0, '', { html: true })
  assert.deepStrictEqual(handoff.tags, ['<kbd>', '<br>'])
  assert.strictEqual(findAll(frag, 'code')[0].textContent, '<br>')
  assert.strictEqual(findAll(frag, 'kbd')[0].textContent, 'Ctrl')
})
check('html 開關只影響那一次呼叫', () => {
  handoff.html.length = 0
  renderMarkdown('<div>x</div>', 0, '', { html: true })
  renderMarkdown('<div>x</div>')
  assert.strictEqual(handoff.html.length, 1)
})
console.log('\n[F] 補齊的語法')

const doc = (md) => renderMarkdown(md, 0, '', { html: true })

check('巢狀清單：縮排到內容欄的子項目畫成內層清單', () => {
  const frag = renderMarkdown('- 一\n  - 一之一\n    - 更深\n- 二\n\n1. 甲\n   1. 乙')
  const lists = findAll(frag, 'ul')
  assert.strictEqual(lists.length, 3)
  assert.strictEqual(findAll(lists[0], 'li').length, 4)
  assert.strictEqual(lists[0].childNodes.length, 2)
  assert.strictEqual(findAll(frag, 'ol').length, 2)
})
check('緊湊清單不包 <p>；中間有空行的寬鬆清單每項是段落', () => {
  assert.strictEqual(findByClass(renderMarkdown('- a\n- b'), 'md-p').length, 0)
  assert.strictEqual(findByClass(renderMarkdown('- a\n\n- b'), 'md-p').length, 2)
})
check('清單項目裡的碼塊與續段', () => {
  const frag = renderMarkdown('1. 安裝\n\n   ```bash\n   npm i\n   ```\n\n   完成\n2. 下一步')
  assert.strictEqual(findAll(frag, 'ol').length, 1)
  assert.strictEqual(findAll(frag, 'li').length, 2)
  assert.strictEqual(textOf(findAll(findAll(frag, 'li')[0], 'code')[0]), 'npm i')
})
check('待辦清單：[ ] [x] 變成停用的勾選框', () => {
  const boxes = findAll(renderMarkdown('- [ ] 未做\n- [x] 已做'), 'input')
  assert.strictEqual(boxes.length, 2)
  assert.strictEqual(boxes[0].attributes.disabled, '')
  assert.ok(!('checked' in boxes[0].attributes))
  assert.strictEqual(boxes[1].attributes.checked, '')
})
check('參考式連結、圖片徽章包連結、沒定義的 [x] 照原文', () => {
  const frag = renderMarkdown('看 [文件][docs] 和 [Docs] 與 a[0]\n\n[![CI](https://x.test/b.svg)](https://x.test/ci)\n\n[docs]: https://x.test/docs "標題"')
  const links = findAll(frag, 'a')
  assert.deepStrictEqual(links.map((a) => a.attributes.href), ['https://x.test/docs', 'https://x.test/docs', 'https://x.test/ci'])
  assert.strictEqual(findAll(links[2], 'img').length, 1)
  assert.ok(textOf(frag).includes('a[0]'))
  assert.ok(!textOf(frag).includes('[docs]:'))
})
check('自動連結：直接貼的網址、<網址>、www.；句尾標點不算網址', () => {
  const links = findAll(renderMarkdown('到 https://x.test/a。也可 <https://y.test> 或 www.z.test, 謝謝'), 'a')
  assert.deepStrictEqual(links.map((a) => a.attributes.href), ['https://x.test/a', 'https://y.test', 'https://www.z.test'])
})
check('GitHub 提示框', () => {
  const frag = renderMarkdown('> [!WARNING]\n> 小心')
  assert.strictEqual(findByClass(frag, 'md-alert-warning').length, 1)
  assert.strictEqual(findByClass(frag, 'md-alert-title')[0].textContent, '警告')
  assert.ok(!textOf(frag).includes('[!WARNING]'))
})
check('腳註：上標編號、文末清單、定義行不顯示', () => {
  const frag = renderMarkdown('甲[^b] 乙[^a] 再[^b]\n\n[^a]: 註 A\n[^b]: 註 B')
  const refs = findByClass(frag, 'md-fnref').map(textOf)
  assert.deepStrictEqual(refs, ['1', '2', '1'])
  const notes = findAll(findByClass(frag, 'md-footnotes')[0], 'li').map(textOf)
  assert.deepStrictEqual(notes, ['註 B↩', '註 A↩'])
  assert.ok(!textOf(frag).includes('[^a]:'))
})
check('底線式標題與標題錨點（重複的加編號）', () => {
  const frag = renderMarkdown('安裝 Setup!\n===\n\n用法\n---\n\n## 用法')
  assert.strictEqual(findAll(frag, 'h1')[0].attributes['data-anchor'], '安裝-setup')
  assert.deepStrictEqual(findAll(frag, 'h2').map((h) => h.attributes['data-anchor']), ['用法', '用法-1'])
  assert.strictEqual(findAll(frag, 'hr').length, 0)
})
check('#錨點連結建 <a> 不帶 target；相對路徑連結只留文字', () => {
  const frag = renderMarkdown('[跳](#用法) [檔](docs/a.md)')
  const a = findAll(frag, 'a')
  assert.strictEqual(a.length, 1)
  assert.strictEqual(a[0].attributes.href, '#用法')
  assert.ok(!('target' in a[0].attributes))
  assert.strictEqual(findByClass(frag, 'md-link-local')[0].attributes.title, 'docs/a.md')
})
check('emoji：認得的換掉，不認得的（含時間）照原文', () => {
  const frag = renderMarkdown('好 :smile: 在 10:30:00 :nope:')
  assert.strictEqual(textOf(frag), '好 😄 在 10:30:00 :nope:')
})
check('碼塊交給上色；mermaid 不上色', () => {
  handoff.code.length = 0
  renderMarkdown('```ts\nlet a\n```\n\n```mermaid\ngraph TD\n```\n\n```\nplain\n```')
  assert.deepStrictEqual(handoff.code, ['ts'])
})
check('數學只在文件模式：行內 $、獨立 $$、```math；$5 和 $10 不是公式', () => {
  handoff.math.length = 0
  renderMarkdown('聊天 $x^2$')
  assert.strictEqual(handoff.math.length, 0)
  doc('質能 $E=mc^2$，價格 $5 和 $10\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n```math\na+b\n```')
  assert.deepStrictEqual(handoff.math, [
    { source: 'E=mc^2', display: false },
    { source: '\\int_0^1 x\\,dx', display: true },
    { source: 'a+b', display: true }
  ])
})
check('跳脫字元只在文件模式；聊天裡的 Windows 路徑不吃反斜線', () => {
  assert.strictEqual(textOf(doc('\\*不是斜體\\*')), '*不是斜體*')
  assert.strictEqual(textOf(renderMarkdown('C:\\Users\\x\\.claude')), 'C:\\Users\\x\\.claude')
})
check('文件模式：段落折行當空白、行尾兩空白是換行；聊天照樣換行', () => {
  assert.strictEqual(findAll(doc('一\n二  \n三'), 'br').length, 1)
  assert.strictEqual(textOf(doc('一\n二')), '一 二')
  assert.strictEqual(findAll(renderMarkdown('一\n二'), 'br').length, 1)
})
check('文件模式：縮排碼塊與 front matter', () => {
  const frag = doc('---\ntitle: x\n---\n\n文字\n\n    code line\n\n後面')
  assert.deepStrictEqual(findByClass(frag, 'md-code-lang').map(textOf), ['yaml', 'text'])
  assert.strictEqual(textOf(findAll(frag, 'code')[1]), 'code line')
  assert.strictEqual(findAll(frag, 'h2').length, 0)
})
check('給了 openLink：相對路徑連結建 <a>（不帶 target），沒給只留文字', () => {
  const linked = findAll(renderMarkdown('[檔](docs/a.md)', 0, '', { openLink: () => {} }), 'a')
  assert.strictEqual(linked.length, 1)
  assert.strictEqual(linked[0].attributes.href, 'docs/a.md')
  assert.ok(!('target' in linked[0].attributes))
  assert.strictEqual(findAll(renderMarkdown('[檔](docs/a.md)'), 'a').length, 0)
  assert.strictEqual(findAll(renderMarkdown('[x](javascript:alert(1))', 0, '', { openLink: () => {} }), 'a').length, 0)
})
check('resolveLinkPath：以檔案所在資料夾為準、/ 是最上層、跑出去回 null', () => {
  const plain = (r) => (r ? { path: r.path, dir: r.dir } : r)
  assert.deepStrictEqual(plain(resolveLinkPath('docs/guide/a.md', '../b.md#段落')), { path: 'docs/b.md', dir: false })
  assert.deepStrictEqual(plain(resolveLinkPath('docs/a.md', '/src/')), { path: 'src', dir: true })
  assert.deepStrictEqual(plain(resolveLinkPath('README.md', './my%20file.md?x=1')), { path: 'my file.md', dir: false })
  assert.strictEqual(resolveLinkPath('README.md', '../outside.md'), null)
  assert.strictEqual(resolveLinkPath('README.md', '%E0%A4'), null)
})
check('沒收尾的 $$ 不卡死', () => {
  assert.ok(textOf(doc('$$\n沒有結尾')).includes('沒有結尾'))
})

console.log('\n[Z] 大檔預覽只畫開頭')
check('沒超過上限原樣回傳、超過就切在最後一個換行', () => {
  const slice = sandbox.__slice
  const max = sandbox.__max
  assert.deepStrictEqual(JSON.parse(JSON.stringify(slice('# 小檔'))), { text: '# 小檔', cut: false })
  const line = 'x'.repeat(99) + '\n'
  const big = line.repeat(Math.ceil(max / line.length) + 5)
  const out = slice(big)
  assert.ok(out.cut && out.text.length <= max && big.startsWith(out.text + '\n'))
  // 呼叫端只給開頭一段＋整份長度（編輯視窗不複製整份）
  assert.ok(slice(big.slice(0, max), big.length).cut)
})

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'}  ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
