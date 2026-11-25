// tests/host-git-head.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectGitHeadFull, readRefCommitFull } from '../src/store/host.js'
import { handleGitHead, apply } from '../index.js'

function makeRepo(root) {
  const gitDir = path.join(root, '.git')
  fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true })
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
  return gitDir
}

test('detectGitHeadFull resolves loose ref, packed-refs and detached HEAD at 40 chars', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-git-head-test-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  // Not a repo
  assert.deepEqual(detectGitHeadFull(tmpDir), { isRepo: false })

  // Loose ref
  const gitDir = makeRepo(tmpDir)
  const fullSha = '0123456789abcdef0123456789abcdef01234567'
  fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), fullSha + '\n')
  let res = detectGitHeadFull(tmpDir)
  assert.equal(res.isRepo, true)
  assert.equal(res.gitBranch, 'main')
  assert.equal(res.gitHead, fullSha)

  // Packed-refs only (remove loose ref)
  fs.rmSync(path.join(gitDir, 'refs', 'heads', 'main'))
  fs.writeFileSync(path.join(gitDir, 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${fullSha} refs/heads/main\n`)
  res = detectGitHeadFull(tmpDir)
  assert.equal(res.isRepo, true)
  assert.equal(res.gitHead, fullSha)

  // Detached HEAD
  const detached = 'abcdef0123456789abcdef0123456789abcdef01'
  fs.writeFileSync(path.join(gitDir, 'HEAD'), detached + '\n')
  res = detectGitHeadFull(tmpDir)
  assert.equal(res.isRepo, true)
  assert.equal(res.gitBranch, '')
  assert.equal(res.gitHead, detached)
})

test('readRefCommitFull handles worktree common dir and returns 40-hex', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-git-worktree-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const main = makeRepo(root)
  const wtDir = path.join(root, 'wt')
  fs.mkdirSync(wtDir, { recursive: true })
  const wtGitDir = path.join(main, 'worktrees', 'wt')
  fs.mkdirSync(path.join(wtGitDir), { recursive: true })
  fs.writeFileSync(path.join(wtGitDir, 'commondir'), '../..\n')
  fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/main\n')
  fs.writeFileSync(path.join(wtDir, '.git'), `gitdir: ${wtGitDir}\n`)
  const sha = 'fedcba9876543210fedcba9876543210fedcba98'
  fs.writeFileSync(path.join(main, 'refs', 'heads', 'main'), sha + '\n')

  // resolveGitLocations 是内部 helper；通过公开的 detectGitHeadFull 验证 worktree 解析
  assert.equal(detectGitHeadFull(wtDir).gitHead, sha)
  assert.equal(detectGitHeadFull(wtDir).gitBranch, 'main')
})

test('handleGitHead resolves workspace and returns envelope', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-git-head-route-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const gitDir = makeRepo(root)
  const sha = '0123456789abcdef0123456789abcdef01234567'
  fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), sha + '\n')

  const ok = await handleGitHead({ workspaceId: 'ws1' }, { workspaces: [{ id: 'ws1', path: root }] })
  assert.equal(ok.ok, true)
  assert.equal(ok.status, 200)
  assert.equal(ok.gitHead, sha)

  const missing = await handleGitHead({ workspaceId: 'nope' }, { workspaces: [] })
  assert.equal(missing.ok, false)
  assert.equal(missing.status, 400)
})

test('readRefCommitFull directly resolves loose ref and returns empty string for missing', () => {
  assert.equal(readRefCommitFull('refs/heads/main', null), '')
  assert.equal(readRefCommitFull('refs/heads/main', { gitDir: '/nonexistent', commonDir: '/nonexistent' }), '')
})

test('apply registers GET /api/punch-desk/git-head route', async () => {
  const routes = []
  const fakeCtx = {
    effect: fn => fn(),
    get: () => undefined,
    connection: {
      fetch: {
        register: route => {
          routes.push(route)
          return () => {}
        },
      },
    },
  }
  apply(fakeCtx)
  const route = routes.find(r => r.path === '/api/punch-desk/git-head')
  assert.ok(route, 'git-head route must be registered')
  assert.deepEqual(route.methods, ['GET'])
})
