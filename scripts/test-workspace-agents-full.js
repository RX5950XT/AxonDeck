'use strict'
const assert = require('assert/strict')
const fs = require('node:fs')
const os = require('os')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')
const { seedAgentFixtures } = require('./lib/workspace-agent-fixtures')
const agents = require('../src/main/workspace/agents')
;(async () => {
  const home = tempDir('agents-full-'), project = path.join(home, 'project')
  const fixture = seedAgentFixtures(home, project, true), oldHome = os.homedir
  const saved = Object.fromEntries(Object.keys(fixture.env).map(k => [k, process.env[k]]))
  os.homedir = () => home; Object.assign(process.env, fixture.env)
  try {
    const rows = await agents.sessions(project)
    for (const agent of Object.keys(fixture.ids)) {
      assert(rows.some(x => x.agent === agent && x.id === fixture.ids[agent]), agent + ' 對話列表')
      assert.deepEqual(await agents.sessions(project, agent), rows.filter(row => row.agent === agent), agent + ' 啟動掃描只讀該工具，清單結果一致')
      let cursor, text = '', user = '', pages = 0, turns = 0
      do {
        const page = await agents.sessionDetail(project, agent, fixture.ids[agent], cursor)
        assert.equal(page.truncated, false)
        for (const turn of page.turns) { if (turn.role === 'assistant') text += turn.text; else user += turn.text; turns++ }
        cursor = page.nextCursor; pages++
        assert(pages < 100, '分頁必須前進')
        assert(JSON.stringify(page).length < 1500000, '每頁記憶體有上限')
      } while (cursor)
      assert(text.includes(fixture.text), agent + ' 巨型回答尾端完整')
      assert(user.includes(fixture.user), agent + ' 提問完整')
      if (agent === 'claude') assert(turns > 60)
      assert(pages > 1)
      await assert.rejects(agents.sessionDetail(path.join(home, 'other'), agent, fixture.ids[agent]), e => e.code === 'SESSION_NOT_FOUND')
      if (agent === 'agy') {
        const moved = await agents.sessionConversation(path.join(home, 'other'), agent, fixture.ids[agent])
        assert(moved.turns.some(turn => turn.role === 'user' && turn.text.includes('提問')), '終端機目錄和 AGY 工作區不同仍讀得到這次程序的對話')
      }
      assert((await agents.resume(project, agent, fixture.ids[agent])).command.includes(fixture.ids[agent]))
      const first = await agents.sessionDetail(project, agent, fixture.ids[agent])
      const again = await agents.sessionDetail(project, agent, fixture.ids[agent], first.pageCursor)
      assert.deepEqual(again.turns, first.turns, '上一頁重讀內容一致')
      await assert.rejects(agents.sessionDetail(project, agent, fixture.ids[agent], { offset: -1, part: 0, text: 0 }), e => e.code === 'BAD_CURSOR')
      console.log('PASS', agent, pages, 'pages', turns, 'turn fragments')
    }
    const expected = []
    for (let i = 0; i < 45; i++) {
      const id = `codex-batch-${i}`, cwd = i % 3 ? project : path.join(home, 'other')
      const file = path.join(home, '.codex/sessions', id + '.jsonl')
      fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd } }) + '\n')
      const time = new Date(Date.now() + (i + 1) * 1000)
      fs.utimesSync(file, time, time)
      if (cwd === project) expected.unshift(id)
    }
    assert.deepEqual((await agents.sessions(project, 'codex')).map(row => row.id), expected.slice(0, 30), '分批讀檔維持排序、30 筆上限與跨專案隔離')
    console.log('PASS Codex 批次讀取排序、上限與專案隔離')
  } finally { os.homedir = oldHome; for (const [k,v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } removeTree(home) }
})().catch(e => { console.error(e); process.exitCode = 1 })
