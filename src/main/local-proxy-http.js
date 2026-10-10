'use strict'

/** 本機代理（CC Proxy 轉換閘道、AGY 反代）共用的 HTTP 小工具。 */

const { timingSafeEqual } = require('crypto')

/** 只接受指向本機的 Host，擋 DNS rebinding（惡意網域解析到 127.0.0.1） */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
function hostAllowed(req) {
  const host = String(req.headers.host || '')
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return ALLOWED_HOSTS.has(name)
}

/**
 * Claude Code 送 `x-api-key`；有些客戶端送 Bearer。
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
function presentedKey(req) {
  const header = String(req.headers.authorization || '')
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  const apiKey = req.headers['x-api-key']
  return typeof apiKey === 'string' ? apiKey.trim() : ''
}

/**
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {object} payload
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

module.exports = { safeEqual, hostAllowed, presentedKey, sendJson }
