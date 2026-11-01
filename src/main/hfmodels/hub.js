'use strict'

/**
 * Hugging Face Hub 唯讀查詢：搜尋 GGUF repo、列檔案、產下載網址、抓檔頭前一段。
 *
 * 兩條規矩照既有的雲端路徑走：
 *   - **不收 renderer 給的網址**：對外只收 repoId 與檔案相對路徑，網址一律在這裡組。
 *     收網址等於把 App 變成「幫你打任意網址」的代理。
 *   - **錯誤只留狀態碼**：上游 body 不進 console／IPC／UI（`shared.fetchJson` 已經是這個行為，
 *     所以這裡直接借它，不自己寫第二套 fetch）。
 *
 * 端點形狀是實測的（`scripts/probe-hf-hub.js`）：
 *   搜尋 `GET /api/models?search=&filter=gguf` → `[{id, likes, downloads, tags, pipeline_tag, createdAt}]`
 *   檔案 `GET /api/models/<repo>/tree/main?recursive=1` → `[{type:'file'|'directory', size, path}]`
 */

const { fetchJson, UsageError } = require('../usage/shared')
const { isSupportedArch, isNonTextRepo } = require('./archs')

const HOST = 'https://huggingface.co'
const LABEL = 'Hugging Face'
/** 一個 repo 的檔案清單；GGUF repo 通常十幾個檔案，1000 是 HF tree 端點自己的單頁上限 */
const TREE_LIMIT = 1000
const SEARCH_LIMIT_MAX = 100
/** 抓檔頭用：`<arch>.*` 那幾格排在詞表之前，實測 1MB 綽綽有餘 */
const PEEK_BYTES = 1024 * 1024
/** README 只拿來顯示模型卡，200KB 綽綽有餘（LFS 大檔不會是 README） */
const README_BYTES = 200 * 1024
const PEEK_TIMEOUT_MS = 20_000

/** `owner/name`；HF 的命名允許 `-` `_` `.` */
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/
/** repo 內的相對路徑；不吃 `..`、開頭斜線、反斜線與控制字元 */
const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,255}$/

/**
 * @param {any} id
 * @returns {boolean}
 */
function isRepoId(id) {
  return typeof id === 'string' && REPO_RE.test(id)
}

/**
 * @param {any} filePath
 * @returns {boolean}
 */
function isRepoPath(filePath) {
  return typeof filePath === 'string'
    && PATH_RE.test(filePath)
    && !filePath.includes('..')
    && !filePath.endsWith('/')
}

/**
 * @param {string} id
 * @returns {string}
 */
function assertRepo(id) {
  if (!isRepoId(id)) throw new UsageError('INVALID_REPO', 'Hugging Face 模型代號格式不正確')
  return id
}

/**
 * HF Token（gated／private repo 需要）。
 *
 * 這一層只保管一個字串，**不碰 store**（它是純粹跟 HF 講話的那一層）；
 * 由 `index.setStore` 灌進來。環境變數是給 CLI／測試用的退路。
 * @type {string}
 */
let token = ''

/**
 * @param {unknown} value
 */
function setToken(value) {
  token = String(value || '').trim().slice(0, 200)
}

/**
 * @returns {boolean} 只回「有沒有」——**token 本身不回給任何人**
 */
function hasToken() {
  return !!(token || process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN)
}

/**
 * @returns {Record<string, string>}
 */
function authHeaders() {
  const value = token || process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || ''
  return value ? { authorization: `Bearer ${value}` } : {}
}

// 架構名沒寫 moe、但整個架構都是 MoE 的（名字、tag 常沒標）。後面一排是讀 GGUF 檔頭 expert_count 確認過的。
// llama、gemma4、granitehybrid 這類同一個架構有 Dense 也有 MoE，不能放進來，交給名字判斷。
const MOE_ARCHS = new Set(['gpt-oss', 'deepseek2', 'deepseek2-ocr', 'deepseek32', 'deepseek4', 'qwen3next', 'dbrx',
  'arctic', 'jamba', 'grok', 'minimax-01', 'minimax-m2', 'minimax-m3', 'dots1', 'llama4', 'glm-dsa', 'smallthinker',
  'kimi-linear', 'mimo2',
  'qwen4exp', 'deepseek41', 'glm5-next', 'hy_v3', 'laguna', 'flint', 'mellum', 'inkling', 'kimi-k3', 'maple',
  'mistral4', 'muse-spark', 'rnd1', 'step35'])

/**
 * 總參數：HF 的 gguf.total 只是它挑的那一個檔，可能挑到 mmproj（clip）或 MTP／草稿小檔，
 * 所以跟 repo 名（35B-A3B 取 35B、8x7B 取 56B）取大的那個。
 * @returns {number} 參數個數，看不出來回 0
 */
function repoParams(id, gguf) {
  const total = gguf?.architecture === 'clip' ? 0 : Number(gguf?.total) || 0
  const name = String(id).split('/')[1] || ''
  const experts = name.match(/(\d+)x(\d+(?:\.\d+)?)B(?![a-z])/i)
  const sizes = experts ? [Number(experts[1]) * Number(experts[2]) * 1e9]
    : [...name.matchAll(/(?<![A-Za-z\d.])(\d+(?:\.\d+)?)([BM])(?![a-z])/gi)]
      .map((m) => Number(m[1]) * (m[2].toUpperCase() === 'B' ? 1e9 : 1e6))
  return Math.max(total, ...sizes)
}

/** MoE：架構、tag 或 repo 名（A3B、8x7B、MoE）任一看得出來就算 */
function repoIsMoe(id, arch, tags) {
  const base = String(arch || '').replace(/-vision$/, '')
  return /moe/i.test(base) || MOE_ARCHS.has(base) || tags.some((t) => /^(moe|mixture-of-experts)$/i.test(t))
    || /(?<![A-Za-z])A\d+(?:\.\d+)?B(?![a-z])|(?<![a-z])moe(?![a-z])|\d+x\d+(?:\.\d+)?B/i.test(String(id).split('/')[1] || '')
}

/**
 * 搜尋 GGUF repo
 * @param {{ query?: string, limit?: number, sort?: 'downloads' | 'likes' | 'lastModified',
 *           kind?: '' | 'dense' | 'moe', maxParamsB?: number }} options maxParamsB：總參數上限（十億），0 不限
 * @returns {Promise<Array<{ id: string, downloads: number, likes: number, tags: string[],
 *                           pipelineTag: string, createdAt: string, gated: boolean, params: number, moe: boolean }>>}
 */
async function searchModels(options = {}) {
  const query = String(options.query || '').trim().slice(0, 120)
  const limit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Number(options.limit) || SEARCH_LIMIT_MAX))
  const sort = ['downloads', 'likes', 'lastModified'].includes(options.sort) ? options.sort : 'downloads'
  const url = new URL('/api/models', HOST)
  url.searchParams.set('filter', 'gguf')
  url.searchParams.set('sort', sort)
  url.searchParams.set('direction', '-1')
  // 多抓一倍：不支援的架構會被濾掉，不然一頁常常只剩一半
  const kind = ['dense', 'moe'].includes(options.kind) ? options.kind : ''
  const maxParams = Math.max(0, Number(options.maxParamsB) || 0) * 1e9
  // 有篩選時多抓一些：濾掉的多，不然常常只剩幾筆
  url.searchParams.set('limit', String(limit * (kind || maxParams ? 8 : 2)))
  if (query) url.searchParams.set('search', query)
  // 指定 expand 後只回這幾欄，所以原本要用的欄位都要列
  for (const field of ['gguf', 'downloads', 'likes', 'tags', 'pipeline_tag', 'createdAt', 'gated']) {
    url.searchParams.append('expand[]', field)
  }

  // gguf 欄位帶整份 chat template（每筆約 8KB），篩選時抓 800 筆約 6MB，超過預設 1MB
  const rows = await fetchJson(url.toString(), { label: LABEL, headers: authHeaders(), allowArray: true,
    maxBytes: 16 * 1024 * 1024 })
  if (!Array.isArray(rows)) return []
  return rows
    .filter((row) => row && isRepoId(row.id))
    // HF 只挑 repo 裡一個檔報架構；挑到 mmproj 會報 clip，真正的架構留給詳情與下載時讀檔頭再擋
    .filter((row) => isSupportedArch(row.gguf?.architecture) || row.gguf?.architecture === 'clip')
    .map((row) => ({
      id: row.id,
      downloads: Number(row.downloads) || 0,
      likes: Number(row.likes) || 0,
      tags: Array.isArray(row.tags) ? row.tags.filter((t) => typeof t === 'string').slice(0, 40) : [],
      pipelineTag: typeof row.pipeline_tag === 'string' ? row.pipeline_tag : '',
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
      gated: row.gated === true || typeof row.gated === 'string',
      params: repoParams(row.id, row.gguf),
      moe: repoIsMoe(row.id, row.gguf?.architecture, Array.isArray(row.tags) ? row.tags : [])
    }))
    .filter((row) => !isNonTextRepo(row))
    .filter((row) => !kind || row.moe === (kind === 'moe'))
    // 看不出參數的，設了上限就不列（沒辦法保證放得下）
    .filter((row) => !maxParams || (row.params > 0 && row.params <= maxParams))
    .slice(0, limit)
}

/**
 * 列出 repo 裡的檔案（只回檔案，不回資料夾）
 * @param {string} repoId
 * @returns {Promise<Array<{ name: string, size: number }>>}
 */
async function listFiles(repoId) {
  assertRepo(repoId)
  const url = new URL(`/api/models/${repoId}/tree/main`, HOST)
  url.searchParams.set('recursive', '1')
  url.searchParams.set('limit', String(TREE_LIMIT))
  // 分片多的 repo 一份清單就好幾百筆，預設的 1MB 上限會剛好不夠（症狀是「這個 repo 是空的」）
  const rows = await fetchJson(url.toString(), {
    label: LABEL,
    headers: authHeaders(),
    allowArray: true,
    maxBytes: 4 * 1024 * 1024
  })
  if (!Array.isArray(rows)) return []
  return rows
    .filter((row) => row && row.type === 'file' && typeof row.path === 'string')
    .map((row) => ({
      name: row.path,
      // LFS 檔案的真實大小在 `lfs.size`；`size` 對 LFS 指標檔也是對的，兩個都看比較保險
      size: Number(row.lfs?.size) || Number(row.size) || 0
    }))
}

/**
 * 下載網址（網址在 main 組，renderer 只給 repoId 與檔名）
 * @param {string} repoId
 * @param {string} filePath
 * @returns {string}
 */
/** repo 檔案頁的網址前綴：README 裡的相對連結接在後面（`docs/x.md` → 網頁上的那個檔案） */
function pageBase(repoId) {
  assertRepo(repoId)
  return `${HOST}/${repoId}/blob/main/`
}

function fileUrl(repoId, filePath) {
  assertRepo(repoId)
  if (!isRepoPath(filePath)) throw new UsageError('INVALID_PATH', '檔案路徑格式不正確')
  const encoded = filePath.split('/').map(encodeURIComponent).join('/')
  return `${HOST}/${repoId}/resolve/main/${encoded}`
}

/**
 * 只讀 response body 的前綴。HF 的 resolve endpoint 偶爾會忽略 Range 回 200；
 * 這時不能用 arrayBuffer() 把整顆 GGUF（可能數 GB）先放進記憶體。
 * @param {Response | object} response
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readPrefix(response, maxBytes) {
  if (!response?.body) return Buffer.alloc(0)
  const chunks = []
  let total = 0
  for await (const chunk of response.body) {
    const part = Buffer.from(chunk.subarray(0, maxBytes - total))
    chunks.push(part)
    total += part.length
    if (total >= maxBytes) break
  }
  return Buffer.concat(chunks, total)
}

/**
 * 抓檔案開頭一段（HTTP Range）給 `gguf.readInfoFromBuffer` 用：
 * **還沒下載就先知道跑不跑得動**，不必先花 5GB 頻寬。
 *
 * @param {string} repoId
 * @param {string} filePath
 * @param {{ bytes?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ buffer: Buffer, totalBytes: number }>}
 */
async function peekFile(repoId, filePath, options = {}) {
  const url = fileUrl(repoId, filePath)
  const bytes = Math.max(1024, Math.min(PEEK_BYTES, Number(options.bytes) || PEEK_BYTES))
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PEEK_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      headers: { ...authHeaders(), range: `bytes=0-${bytes - 1}` },
      signal: controller.signal
    })
    if (!response?.ok) {
      throw new UsageError('HTTP_ERROR', `Hugging Face 暫時無法使用（HTTP ${Number(response?.status) || 0}）`,
        Number(response?.status) || 0)
    }
    const buffer = await readPrefix(response, bytes)
    // 206 才有 Content-Range；上游不支援 Range 時會回 200 整包，這裡照樣只留前面那一段
    const range = String(response.headers?.get?.('content-range') || '')
    const total = Number(range.split('/')[1])
      || (response.status === 200 ? Number(response.headers?.get?.('content-length')) : 0) || buffer.length
    return { buffer: buffer.subarray(0, bytes), totalBytes: total }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * repo 詳情（`gguf` 那格是 HF 自己解出來的，跟我們讀檔頭是兩個來源，這裡只拿來顯示）
 * @param {string} repoId
 * @returns {Promise<object>}
 */
async function modelCard(repoId) {
  assertRepo(repoId)
  const row = await fetchJson(new URL(`/api/models/${repoId}`, HOST).toString(), {
    label: LABEL,
    headers: authHeaders()
  })
  return {
    id: repoId,
    downloads: Number(row?.downloads) || 0,
    likes: Number(row?.likes) || 0,
    lastModified: typeof row?.lastModified === 'string' ? row.lastModified : '',
    pipelineTag: typeof row?.pipeline_tag === 'string' ? row.pipeline_tag : '',
    gated: row?.gated === true || typeof row?.gated === 'string',
    tags: Array.isArray(row?.tags) ? row.tags.filter((t) => typeof t === 'string').slice(0, 40) : [],
    gguf: {
      parameterCount: Number(row?.gguf?.total) || 0,
      architecture: typeof row?.gguf?.architecture === 'string' ? row.gguf.architecture : '',
      contextLength: Number(row?.gguf?.context_length) || 0
    }
  }
}

/**
 * README.md（模型卡內文）。**沒有 README 不是錯誤**——很多 GGUF repo 就是沒有，
 * 那時候詳情面板照樣要能開，所以這裡吞掉失敗回空字串。
 * @param {string} repoId
 * @returns {Promise<string>}
 */
async function readme(repoId) {
  let text = ''
  try {
    const { buffer } = await peekFile(repoId, 'README.md', { bytes: README_BYTES })
    text = buffer.toString('utf8')
  } catch {
    return ''
  }
  // 截在最後一個換行：Range 剛好切在多位元組字元中間會留下亂碼
  if (Buffer.byteLength(text, 'utf8') >= README_BYTES) {
    text = text.slice(0, text.lastIndexOf('\n') + 1 || text.length)
  }
  return stripHtml(htmlTablesToMarkdown(stripFrontMatter(text)))
}

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }

/**
 * @param {string} html 一格的內容
 * @returns {string} 純文字，`|` 跳脫成 `\|`（不然會被當成欄分隔）
 */
function cellText(html) {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name) => HTML_ENTITIES[name])
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '\\|')
}

/**
 * HF 的 benchmark 表很多是 HTML `<table>`。直接剝標籤會把整張表攤成一長串直排數字，
 * 所以先轉成 markdown 表格（第一列當表頭、colspan 補空格），再交給 `stripHtml`。
 * ponytail: 圍籬程式碼區塊裡的 `<table>` 也會被轉，模型卡幾乎不會這樣寫。
 * @param {string} text
 * @returns {string}
 */
function htmlTablesToMarkdown(text) {
  return text.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => {
    const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(([, row]) => {
      const cells = []
      for (const [, attrs, body] of row.matchAll(/<t[hd]\b([^>]*)>([\s\S]*?)<\/t[hd]>/gi)) {
        const span = Math.min(20, Math.max(1, Number(/colspan\s*=\s*["']?(\d+)/i.exec(attrs)?.[1]) || 1))
        cells.push(cellText(body), ...Array(span - 1).fill(''))
      }
      return cells
    }).filter((cells) => cells.length)
    if (!rows.length) return ''
    const width = Math.max(...rows.map((cells) => cells.length))
    const line = (cells) => `| ${[...cells, ...Array(width - cells.length).fill('')].join(' | ')} |`
    return `\n\n${[line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n')}\n\n`
  })
}

/**
 * HF 的 README 很常以一整塊 HTML 橫幅開頭（`<div style=...><img ...>`）。
 * `markdown.js` 是零 innerHTML 的，標籤會原樣變成文字印在模型卡最上面，
 * 所以在這裡先剝掉——**圍籬程式碼區塊裡的不動**（那裡的 `<` 是內容不是標籤）。
 * @param {string} text
 * @returns {string}
 */
function stripHtml(text) {
  let fenced = false
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line }
      if (fenced) return line
      return line.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[A-Za-z][^>]*>/g, '')
    })
    .join('\n')
}

/**
 * HF 的 README 開頭是一段 YAML front matter（授權、tags、base_model…），
 * 原樣顯示等於在模型卡最上面印一串設定檔。
 * @param {string} text
 * @returns {string}
 */
function stripFrontMatter(text) {
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  if (end < 0) return text
  const after = text.indexOf('\n', end + 1)
  return after < 0 ? '' : text.slice(after + 1).replace(/^\s+/, '')
}

module.exports = {
  isRepoId, isRepoPath, searchModels, repoParams, repoIsMoe, listFiles, pageBase, fileUrl, peekFile, modelCard, readme,
  htmlTablesToMarkdown, setToken, hasToken, authHeaders, HOST, PEEK_BYTES
}
