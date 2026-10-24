#!/usr/bin/env node
/**
 * AxonDeck — skills 與全域記憶檔回歸（node 直跑，不碰真實家目錄）。
 *
 * 最容易錯的三條：
 * - `~/.claude/skills` 是指到 `~/.agents/skills` 的連結：兩邊會看到同一份，要標共用
 * - 停用搬移跑出 skills 目錄（`../` 跳脫），或蓋掉已存在的同名目錄
 * - 記憶檔寫壞（先備份、原子替換；不在清單的檔名一律拒絕）
 */

'use strict'

const fs = require('fs')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')

const ROOT = path.join(__dirname, '..')
const skills = require(path.join(ROOT, 'src/main/ccswitch/skills.js'))
const claudeSettings = require(path.join(ROOT, 'src/main/ccswitch/claude-settings.js'))

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const tmp = tempDir('axondeck-skills-')
// env 優先於預設家目錄（跟 agents.js 同一條規則）：測試一定要蓋掉，
// 不然這台機器上的 GROK_HOME 會把 grok 指回真實目錄
const prevEnv = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  GROK_HOME: process.env.GROK_HOME
}
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, '.claude')
process.env.CODEX_HOME = path.join(tmp, '.codex')
process.env.GROK_HOME = path.join(tmp, '.grok')
skills.configure({ homeDir: tmp })
claudeSettings.configure({ homeDir: tmp, backupDir: path.join(tmp, 'backup') })

const agentsSkills = path.join(tmp, '.agents', 'skills')
const claudeSkills = path.join(tmp, '.claude', 'skills')
const codexSkills = path.join(tmp, '.codex', 'skills')
fs.mkdirSync(agentsSkills, { recursive: true })
fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true })
fs.mkdirSync(codexSkills, { recursive: true })
// 真實世界：claude 的 skills 是指到 agents 的連結
fs.symlinkSync(agentsSkills, claudeSkills, 'junction')

function seedSkill(dir, name, frontmatter) {
  const full = path.join(dir, name)
  fs.mkdirSync(full, { recursive: true })
  const body = frontmatter ? `---\n${frontmatter}\n---\n\n# ${name}\n` : `# ${name}\n`
  fs.writeFileSync(path.join(full, 'SKILL.md'), body)
}

try {
  console.log('\n[A] 家目錄與共用標記')
  {
    const all = skills.homes()
    ok('六家（含 Antigravity）', all.length === 6 && all.some((row) => row.id === 'agy'))
    const listed = skills.list('claude')
    ok('連結解得開', listed.dir === agentsSkills)
    ok('標成跟 agents 共用', listed.sharedWith.some((label) => label.includes('.agents')))
    const agents = skills.list('agents')
    ok('另一邊也標共用', agents.sharedWith.some((label) => label.includes('Claude')))
  }

  console.log('\n[B] 清單與 frontmatter')
  {
    seedSkill(agentsSkills, 'good', 'name: Good Skill\ndescription: 會做事的 skill')
    seedSkill(agentsSkills, 'plain', '')
    seedSkill(codexSkills, 'cx', 'name: Cx')
    const listed = skills.list('claude')
    ok('掃得到兩顆', listed.skills.length === 2, JSON.stringify(listed.skills.map((s) => s.name)))
    const good = listed.skills.find((s) => s.name === 'Good Skill')
    ok('名字讀 frontmatter', Boolean(good))
    ok('描述讀 frontmatter', good && good.description.includes('會做事'))
    ok('沒 frontmatter 用目錄名', listed.skills.some((s) => s.name === 'plain'))
    const cx = skills.list('codex')
    ok('各家目錄獨立', cx.skills.length === 1 && cx.dir !== listed.dir)
    const empty = skills.list('grok')
    ok('不存在的目錄回空不清單', empty.skills.length === 0)
  }

  console.log('\n[C] 停用搬移')
  {
    const moved = skills.setEnabled('codex', 'cx', false)
    ok('回傳狀態', moved.enabled === false)
    ok('搬進 .disabled', fs.existsSync(path.join(codexSkills, '.disabled', 'cx', 'SKILL.md')))
    ok('原地不在了', !fs.existsSync(path.join(codexSkills, 'cx')))
    const listed = skills.list('codex')
    ok('清單標停用', listed.skills.length === 1 && listed.skills[0].enabled === false)
    skills.setEnabled('codex', 'cx', true)
    ok('搬得回來', fs.existsSync(path.join(codexSkills, 'cx', 'SKILL.md')))

    let threw = ''
    try {
      skills.setEnabled('codex', '../evil', false)
    } catch (error) { threw = error.code }
    ok('../ 跳脫擋掉', threw === 'SKILL_BAD_NAME', threw)
    threw = ''
    try {
      skills.setEnabled('codex', 'nope', false)
    } catch (error) { threw = error.code }
    ok('不存在的擋掉', threw === 'SKILL_NOT_FOUND', threw)
    threw = ''
    try {
      skills.setEnabled('nope', 'cx', false)
    } catch (error) { threw = error.code }
    ok('未知家目錄擋掉', threw === 'SKILL_HOME_UNKNOWN', threw)
  }

  console.log('\n[D] 記憶檔')
  {
    const files = skills.memoryFiles('codex')
    ok('codex 有 AGENTS.md＋CLAUDE.md＋config.toml', files.length === 3 && files[2].file === 'config.toml')
    ok('還沒建回 exists false', files.every((row) => row.exists === false))
    const wrote = skills.writeMemory('codex', 'AGENTS.md', '# rules\n')
    ok('寫得進去', wrote.path.endsWith('AGENTS.md') && fs.readFileSync(wrote.path, 'utf8') === '# rules\n')
    const read = skills.readMemory('codex', 'AGENTS.md')
    ok('讀得回來', read.exists === true && read.content === '# rules\n')
    skills.writeMemory('codex', 'AGENTS.md', '# rules v2\n')
    const backups = fs.readdirSync(path.join(tmp, 'backup')).filter((n) => n.startsWith('memory-codex-AGENTS.md-'))
    ok('覆寫前有備份', backups.length === 1)
    const claudeFiles = skills.memoryFiles('claude')
    ok('claude 是 CLAUDE.md＋settings.json', claudeFiles.map((row) => row.file).join() === 'CLAUDE.md,settings.json')
    const grokFiles = skills.memoryFiles('grok')
    ok('grok 是 MEMORY.md＋config.toml', grokFiles.map((row) => row.file).join() === 'MEMORY.md,config.toml')
    let threw = ''
    try {
      skills.readMemory('codex', '../../evil.md')
    } catch (error) { threw = error.code }
    ok('不在清單的檔名拒絕', threw === 'MEMORY_FILE_UNKNOWN', threw)
    threw = ''
    try {
      skills.writeMemory('codex', 'AGENTS.md', 'x'.repeat(300 * 1024))
    } catch (error) { threw = error.code }
    ok('太大拒絕', threw === 'MEMORY_TOO_LARGE', threw)
    threw = ''
    try {
      skills.writeMemory('claude', 'settings.json', '{ "a": ')
    } catch (error) { threw = error.code }
    ok('壞掉的 JSON 不寫', threw === 'CONFIG_PARSE_FAILED' && !skills.readMemory('claude', 'settings.json').exists, threw)
    threw = ''
    try {
      skills.writeMemory('codex', 'config.toml', 'model = ')
    } catch (error) { threw = error.code }
    ok('壞掉的 TOML 不寫', threw === 'CONFIG_PARSE_FAILED', threw)
    skills.writeMemory('claude', 'settings.json', '{ "a": 1 }')
    skills.writeMemory('claude', 'settings.json', '{ "a": 2 }')
    ok('設定檔備份留原副檔名', fs.readdirSync(path.join(tmp, 'backup')).some((n) => n.startsWith('memory-claude-settings.json-') && n.endsWith('.json')))
    const agy = skills.writeMemory('agy', 'antigravity-cli/settings.json', '{}')
    ok('agy 設定檔寫進子資料夾', agy.path === path.join(tmp, '.gemini', 'antigravity-cli', 'settings.json'))
    skills.writeMemory('agy', 'antigravity-cli/settings.json', '{ "x": 1 }')
    ok('agy 備份檔名攤平', fs.readdirSync(path.join(tmp, 'backup')).some((n) => n.startsWith('memory-agy-antigravity-cli_settings.json-')))
    ok('agy 記憶在 ~/.gemini', skills.memoryFiles('agy')[0].path === path.join(tmp, '.gemini', 'GEMINI.md'))
    const missing = skills.readMemory('grok', 'MEMORY.md')
    ok('沒建過回空', missing.exists === false && missing.content === '')
  }
} finally {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  removeTree(tmp)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
