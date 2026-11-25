// tests/host-git-range.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { runGitCommitRange } from '../src/store/host.js'
import { handleGitCommitRange, apply } from '../index.js'
import { execFileSync } from 'node:child_process'

const FROM = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TO = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function mockExec(stdout, capture) {
  return (cmd, args, opts, callback) => {
    if (capture) capture({ cmd, args, opts })
    callback(null, stdout, '')
  }
}

test('runGitCommitRange parses 40-hex, short hash, subject with tabs and sanitises env', async () => {
  let captured = null
  const out = '0123456789abcdef0123456789abcdef01234567\t1700000000\tfeat: keep\tthe\ttabs\n'
  const res = await runGitCommitRange({
    workspaceDir: '/tmp/ws',
    from: FROM,
    to: TO,
    execFile: mockExec(out, value => { captured = value }),
  })
  assert.equal(res.ok, true)
  assert.equal(res.truncated, false)
  assert.equal(res.commits.length, 1)
  assert.equal(res.commits[0].hash, '0123456789abcdef0123456789abcdef01234567')
  assert.equal(res.commits[0].shortHash, '0123456')
  assert.equal(res.commits[0].subject, 'feat: keep\tthe\ttabs')
  assert.equal(captured.cmd, 'git')
  assert.ok(captured.args.includes('--max-count=101'))
  assert.ok(captured.args.includes(`${FROM}..${TO}`))
  assert.equal(captured.opts.cwd, '/tmp/ws')
  assert.equal(captured.opts.timeout, 8000)
  assert.equal(captured.opts.maxBuffer, 1024 * 1024)
  assert.equal(captured.opts.env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(captured.opts.env.GIT_DIR, undefined)
  assert.equal(captured.opts.env.GIT_WORK_TREE, undefined)
  assert.equal(captured.opts.env.GIT_CONFIG_COUNT, undefined)
})

test('runGitCommitRange treats 101 lines as truncated and keeps newest 100', async () => {
  const line = i => `${String(i).padStart(40, '0')}\t170000000${i % 10}\tcommit ${i}\n`
  const out = Array.from({ length: 101 }, (_, i) => line(i + 1)).join('')
  const res = await runGitCommitRange({
    workspaceDir: '/tmp/ws', from: FROM, to: TO, execFile: mockExec(out),
  })
  assert.equal(res.ok, true)
  assert.equal(res.truncated, true)
  assert.equal(res.commits.length, 100)
  assert.equal(res.commits[0].hash, String(2).padStart(40, '0'))
  assert.equal(res.commits[99].hash, String(101).padStart(40, '0'))
})

test('runGitCommitRange rejects bad SHA and skips spawn for identical endpoints', async () => {
  let spawned = false
  const execFile = () => { spawned = true; throw new Error('must not spawn') }

  const bad = await runGitCommitRange({ workspaceDir: '/tmp/ws', from: 'abc', to: TO, execFile })
  assert.equal(bad.ok, false)
  assert.equal(bad.status, 400)
  assert.equal(spawned, false)

  const same = await runGitCommitRange({ workspaceDir: '/tmp/ws', from: FROM, to: FROM, execFile })
  assert.equal(same.ok, true)
  assert.equal(same.commits.length, 0)
  assert.equal(spawned, false)
})

test('runGitCommitRange handles exec error or non-zero exit', async () => {
  const failingExec = (cmd, args, opts, callback) => {
    callback(new Error('fatal: not a git repository'), '', 'fatal: not a git repository')
  }
  const res = await runGitCommitRange({
    workspaceDir: '/tmp/ws',
    from: FROM,
    to: TO,
    execFile: failingExec,
  })
  assert.equal(res.ok, false)
  assert.equal(res.status, 500)
  assert.equal(res.error, 'range-failed')
  assert.ok(res.detail.includes('fatal: not a git repository'))
})

test('handleGitCommitRange resolves workspace and returns envelope', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-git-range-route-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const out = '0123456789abcdef0123456789abcdef01234567\t1700000000\tfeat: route\n'
  const res = await handleGitCommitRange(
    { workspaceId: 'ws1', from: FROM, to: TO },
    { workspaces: [{ id: 'ws1', path: root }] },
    { execFile: mockExec(out) },
  )
  assert.equal(res.ok, true)
  assert.equal(res.status, 200)
  assert.equal(res.commits.length, 1)

  // Missing or unknown workspace
  const missingWs = await handleGitCommitRange(
    { from: FROM, to: TO },
    { workspaces: [] },
  )
  assert.equal(missingWs.ok, false)
  assert.equal(missingWs.status, 400)

  // Invalid SHA
  const invalidSha = await handleGitCommitRange(
    { workspaceId: 'ws1', from: 'bad', to: TO },
    { workspaces: [{ id: 'ws1', path: root }] },
  )
  assert.equal(invalidSha.ok, false)
  assert.equal(invalidSha.status, 400)
})

test('apply registers GET /api/punch-desk/git-commit-range route', async () => {
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
  const route = routes.find(r => r.path === '/api/punch-desk/git-commit-range')
  assert.ok(route, 'git-commit-range route must be registered')
  assert.deepEqual(route.methods, ['GET'])

  // Test route handler via fetch call
  const out = '0123456789abcdef0123456789abcdef01234567\t1700000000\tfeat: test\n'
  const mockOptions = {
    workspaces: [{ id: 'ws1', path: os.tmpdir() }],
  }
  const appRoutes = []
  const ctx = {
    effect: fn => fn(),
    get: () => undefined,
    connection: {
      fetch: {
        register: r => { appRoutes.push(r); return () => {} },
      },
    },
  }
  apply(ctx, mockOptions)
  const rangeRoute = appRoutes.find(r => r.path === '/api/punch-desk/git-commit-range')

  // Calling with invalid params returns 400
  const badReq = new Request(`http://localhost/api/punch-desk/git-commit-range?workspaceId=ws1&from=bad&to=${TO}`)
  const badResp = await rangeRoute.fetch(badReq)
  assert.equal(badResp.status, 400)
  const badJson = await badResp.json()
  assert.equal(badJson.ok, false)
  assert.equal(badJson.error, 'invalid-sha')

  // Calling with same from and to returns 200 without spawning
  const sameReq = new Request(`http://localhost/api/punch-desk/git-commit-range?workspaceId=ws1&from=${FROM}&to=${FROM}`)
  const sameResp = await rangeRoute.fetch(sameReq)
  assert.equal(sameResp.status, 200)
  const sameJson = await sameResp.json()
  assert.equal(sameJson.ok, true)
  assert.deepEqual(sameJson.commits, [])
})


test('runGitCommitRange executes real git in a temp repository (env scrub regression)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-real-git-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim()
  git('init', '-q')
  fs.writeFileSync(path.join(root, 'file.txt'), 'one\n')
  git('add', 'file.txt')
  git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'first')
  const first = git('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(root, 'file.txt'), 'two\n')
  git('add', 'file.txt')
  git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'second')
  const second = git('rev-parse', 'HEAD')

  const res = await runGitCommitRange({ workspaceDir: root, from: first, to: second })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.commits.length, 1)
  assert.equal(res.commits[0].hash, second)
  assert.equal(res.commits[0].subject, 'second')
})
