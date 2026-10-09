'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 終端機 id 當檔名。不收路徑，避免寫到別的目錄。 */
function fileFor(dir, id) {
  if (typeof dir !== 'string' || !dir || !ID_RE.test(id)) return ''
  const root = path.resolve(dir)
  const file = path.resolve(root, `${id}.json`)
  return path.dirname(file) === root ? file : ''
}

function requestBody(req) {
  const text = typeof req?.text === 'string' ? req.text.slice(0, 240) : ''
  const role = req?.role === 'prompt' || req?.role === 'answer' ? req.role : ''
  const index = Number.isInteger(req?.index) && req.index >= 0 && req.index < 10000 ? req.index : -1
  if (!text.trim() || !role || index < 0) return null
  return { nonce: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, text, role, index, ok: null }
}

/** 寫給 OpenCode 外掛的跳轉請求，等它把 ok 寫回來。逾時當沒跳到。 */
async function requestJump(dir, id, req, wait = sleep) {
  const file = fileFor(dir, id)
  const body = requestBody(req)
  if (!file || !body) return false
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file, JSON.stringify(body))
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    await wait(80)
    let parsed
    try { parsed = JSON.parse(await fs.promises.readFile(file, 'utf8')) } catch { continue }
    if (parsed?.nonce !== body.nonce) continue
    if (parsed.ok === true || parsed.ok === false) return parsed.ok === true
  }
  return false
}

module.exports = { requestJump, fileFor }
