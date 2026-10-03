'use strict'
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const git = require('../src/main/workspace/git')
const { tempDir } = require('./lib/test-temp')

async function main() {
  for (const remote of ['git@github.com:owner/repo.git', 'https://github.com/owner/repo.git',
    'ssh://git@github.com/owner/repo.git', 'https://token@github.com/owner/repo.git']) {
    assert.equal(git.githubUrlForRemote(remote), 'https://github.com/owner/repo')
  }
  for (const remote of ['https://github.com.evil.test/o/r', 'file:///repo', 'git@gitlab.com:o/r',
    'https://github.com/o/r/extra', 'https://github.com/o/r?token=secret']) {
    assert.equal(git.githubUrlForRemote(remote), '')
  }
  const cwd = tempDir('workspace-github-')
  const run = (...args) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'ignore' })
  run('init', '-q')
  assert.equal(await git.githubUrl(cwd), '')
  run('remote', 'add', 'upstream', 'git@github.com:upstream/project.git')
  assert.equal(await git.githubUrl(cwd), 'https://github.com/upstream/project')
  run('remote', 'add', 'origin', 'https://github.com/owner/project.git')
  assert.equal(await git.githubUrl(cwd), 'https://github.com/owner/project')
  console.log('PASS GitHub HTTPS／SSH／去除憑證／拒絕假網域／無 remote／origin 優先／upstream 退路')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
