'use strict'

/** 舊有整窗 CDP 流程跟著主視窗目前的功能頁走；字幕／webview 等指定 target 不轉接。 */
function followMainPage(Cdp) {
  const connect = Cdp.prototype.connect
  const close = Cdp.prototype.close
  Cdp.prototype.connect = async function (...args) {
    await connect.apply(this, args)
    if (this.fixedPage) return
    const address = new URL(this.ws.url)
    const list = () => fetch(`http://${address.host}/json/list`).then((response) => response.json())
    const targets = await list()
    const initial = targets.find((target) => target.webSocketDebuggerUrl === this.ws.url)
    const host = targets.find((target) => target.url.includes('host=1'))
    if (!host || !initial || !/index\.html|[?&]page=/.test(initial.url)) return
    const originalSend = this.send.bind(this)
    const sessions = new Map([[initial.id, { send: originalSend }]])
    const settings = new Map()
    const sessionFor = async (target) => {
      if (sessions.has(target.id)) return sessions.get(target.id)
      const client = new Cdp(target.webSocketDebuggerUrl)
      client.fixedPage = true
      for (const field of ['exceptions', 'consoleErrors']) if (Array.isArray(this[field])) client[field] = this[field]
      await client.connect()
      for (const [method, params] of settings) await client.send(method, params)
      sessions.set(target.id, client)
      return client
    }
    const hostSession = await sessionFor(host)
    this.pageSessions = sessions
    this.send = async (method, params = {}) => {
      const deadline = Date.now() + 45000
      let page = ''
      while (Date.now() < deadline) {
        const response = await hostSession.send('Runtime.evaluate', {
          expression: '({page: document.body.dataset.mainPage, pending: document.body.dataset.pendingPage})', returnByValue: true
        })
        const state = response.result?.value
        if (state?.page && !state.pending) { page = state.page; break }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      if (!page) throw new Error('CDP 等待主視窗功能頁逾時')
      const target = (await list()).find((item) => /[?&]page=/.test(item.url) && new URL(item.url).searchParams.get('page') === page)
      if (!target) throw new Error(`CDP 找不到功能頁：${page}`)
      const client = await sessionFor(target)
      if (method.startsWith('Emulation.')) {
        settings.set(method, params)
        await Promise.all([...sessions.values()].filter((session) => session !== client).map((session) => session.send(method, params)))
      }
      return client.send(method, params)
    }
  }
  Cdp.prototype.close = function (...args) {
    for (const session of this.pageSessions?.values() || []) session.close?.()
    return close?.apply(this, args)
  }
}

module.exports = { followMainPage }
