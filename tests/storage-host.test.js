import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  withWorkspaceLock,
  detectGitBranch,
  detectGitCommit,
  prunePromptLogs,
  createHostDeskStore,
} from '../src/store/host.js'
import {
  apply,
  handleGitBranch,
  handleWorkspaceFiles,
  resolveWorkspaceDir,
  adaptRoute,
} from '../index.js'

function makeTempDir(prefix = 'pd-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// =========================================================================
// 1. Host storage domain read/write/fallback & persistence
// =========================================================================

test('Host storage domain read, write, fallback, and persistence across instances', async () => {
  const tmpDir = makeTempDir('pd-store-')
  const storageFilePath = path.join(tmpDir, 'punch_desk.json')

  try {
    // 1. First instance: initial empty state fallback
    const store1 = createHostDeskStore({ storageFilePath })
    const initialEntries = await store1.listEntries('ws-1')
    assert.deepEqual(initialEntries, [])

    const initialPrefs = await store1.getPrefs()
    assert.equal(initialPrefs.draftDefaultVisibility, 'workspace')
    assert.equal(initialPrefs.startSessionBehavior, 'prefill')

    // 2. Write entries, workspace records, groups, handoff, and prefs
    await store1.putWorkspaceRecord({
      id: 'ws-1',
      name: 'Test Workspace',
      path: tmpDir,
      gitBranch: 'main',
      status: 'active',
      specSyncStatus: 'pending',
      createdAt: 1000,
      updatedAt: 1000,
    })

    await store1.putEntry({
      id: 'f-1',
      kind: 'finding',
      sessionId: 'sess-1',
      workspaceKey: 'session:sess-1',
      text: 'First host finding',
      tag: 'optimize',
      submissionStatus: 'unsubmitted',
    })

    await store1.putGroup({
      id: 'g-1',
      groupNumber: 1,
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      startTurn: 0,
      items: [{ findingId: 'f-1', order: 0 }],
      createdAt: 1000,
    })

    await store1.setHandoff('sess-1', { draftId: 'd-1', body: 'Draft prompt' })
    await store1.setPrefs({ submitMode: 'sequential' })

    // 3. Second instance pointing to same file: verifies disk persistence
    const store2 = createHostDeskStore({ storageFilePath })
    const records = await store2.listWorkspaceRecords()
    assert.equal(records.length, 1)
    assert.equal(records[0].id, 'ws-1')
    assert.equal(records[0].name, 'Test Workspace')

    const entries = await store2.listEntries('session:sess-1')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].id, 'f-1')
    assert.equal(entries[0].text, 'First host finding')

    const groups = await store2.getGroups('sess-1')
    assert.equal(groups.length, 1)
    assert.equal(groups[0].id, 'g-1')

    const handoff = await store2.getHandoff('sess-1')
    assert.deepEqual(handoff, { draftId: 'd-1', body: 'Draft prompt' })

    const prefs = await store2.getPrefs()
    assert.equal(prefs.submitMode, 'sequential')

    // 4. Delete operations
    await store2.deleteEntry('session:sess-1', 'f-1')
    const remainingEntries = await store2.listEntries('session:sess-1')
    assert.equal(remainingEntries.length, 0)

    await store2.deleteHandoff('sess-1')
    assert.equal(await store2.getHandoff('sess-1'), null)

    // 5. Corrupt file degrades to default state without throwing
    fs.writeFileSync(storageFilePath, '{ corrupt json invalid', 'utf8')
    const store3 = createHostDeskStore({ storageFilePath })
    assert.deepEqual(await store3.listEntries('ws-1'), [])
    assert.deepEqual(await store3.listWorkspaceRecords(), [])
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// =========================================================================
// 2. PromptLog rolling prune (1000 items and 30 days retention)
// =========================================================================

test('PromptLog rolling prune enforces max 30 days retention', () => {
  const now = 1_000_000_000
  const oneDay = 24 * 3600 * 1000
  const thirtyDays = 30 * oneDay

  const logs = [
    { id: '1', messageId: 'm1', text: 'Old 35d', createdAt: now - 35 * oneDay },
    { id: '2', messageId: 'm2', text: 'Old 31d', createdAt: now - 31 * oneDay },
    { id: '3', messageId: 'm3', text: 'Recent 29d', createdAt: now - 29 * oneDay },
    { id: '4', messageId: 'm4', text: 'Recent 10d', createdAt: now - 10 * oneDay },
    { id: '5', messageId: 'm5', text: 'Today', createdAt: now },
  ]

  const pruned = prunePromptLogs(logs, { now, maxCount: 1000, maxAgeMs: thirtyDays })
  assert.equal(pruned.length, 3)
  assert.deepEqual(pruned.map(p => p.id), ['3', '4', '5'])
})

test('PromptLog rolling prune correctly handles authentic time field (Bug C4 fix)', () => {
  const now = 1_000_000_000
  const oneDay = 24 * 3600 * 1000
  const thirtyDays = 30 * oneDay

  // Authentic PromptLog entries generated by prompt-log.js only have 'time', NOT 'createdAt'
  const authenticLogs = [
    { id: '1', messageId: 'm1', text: 'Old 35d', time: now - 35 * oneDay },
    { id: '2', messageId: 'm2', text: 'Old 31d', time: now - 31 * oneDay },
    { id: '3', messageId: 'm3', text: 'Recent 29d', time: now - 29 * oneDay },
    { id: '4', messageId: 'm4', text: 'Recent 10d', time: now - 10 * oneDay },
    { id: '5', messageId: 'm5', text: 'Today', time: now },
  ]

  const pruned = prunePromptLogs(authenticLogs, { now, maxCount: 1000, maxAgeMs: thirtyDays })
  assert.equal(pruned.length, 3, 'Items with authentic time field within 30 days must be retained')
  assert.deepEqual(pruned.map(p => p.id), ['3', '4', '5'])
})

test('PromptLog rolling prune enforces max 1000 records cap', () => {
  const now = 1_000_000_000
  const logs = []
  for (let i = 0; i < 1200; i++) {
    logs.push({
      id: `log-${i}`,
      messageId: `msg-${i}`,
      text: `Prompt message ${i}`,
      createdAt: now - (1200 - i) * 1000, // all within recent minutes
    })
  }

  const pruned = prunePromptLogs(logs, { now, maxCount: 1000 })
  assert.equal(pruned.length, 1000)
  // Oldest 200 dropped, newest 1000 retained
  assert.equal(pruned[0].id, 'log-200')
  assert.equal(pruned[pruned.length - 1].id, 'log-1199')
})

test('prompt log retention follows the configured prefs window', async () => {
  const tmpDir = makeTempDir('pd-host-retention-')
  const storageFilePath = path.join(tmpDir, 'punch_desk.json')
  const now = 2_000_000_000
  const oneDay = 24 * 3600 * 1000
  try {
    const store = createHostDeskStore({ storageFilePath, now: () => now })
    await store.setPrefs({ promptLogRetentionDays: 7, promptLogRetentionRows: 200 })

    const rows = []
    for (let i = 0; i < 10; i++) {
      rows.push({ messageId: 'old-' + i, text: 'old', createdAt: now - 10 * oneDay })
    }
    for (let i = 0; i < 250; i++) {
      rows.push({ messageId: 'new-' + i, text: 'new', createdAt: now - (250 - i) * 1000 })
    }
    await store.upsertPromptLog('ws-retention', rows)
    const stored = await store.listPromptLog('ws-retention')
    assert.equal(stored.length, 200, 'row cap from prefs applies on write')
    assert.ok(stored.every(item => item.createdAt >= now - 7 * oneDay), 'age cap from prefs applies on write')

    // Raising the window later cannot resurrect rows that were already dropped.
    await store.setPrefs({ promptLogRetentionDays: 30, promptLogRetentionRows: 1000 })
    await store.upsertPromptLog('ws-retention', [{ messageId: 'tail', text: 'tail', createdAt: now }])
    const after = await store.listPromptLog('ws-retention')
    assert.equal(after.length, 201)
    assert.ok(!after.some(item => item.messageId === 'old-0'))
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('Host store cleanExpiredPromptLogs and upsertPromptLog prune synchronized', async () => {
  const tmpDir = makeTempDir('pd-prune-')
  const storageFilePath = path.join(tmpDir, 'punch_desk.json')
  const now = 2_000_000_000
  const oneDay = 24 * 3600 * 1000

  try {
    const store = createHostDeskStore({ storageFilePath, now: () => now })

    // Upsert 1100 logs (100 expired by 35 days, 1000 recent)
    const logs = []
    for (let i = 0; i < 100; i++) {
      logs.push({
        messageId: `old-${i}`,
        text: `Old prompt ${i}`,
        createdAt: now - 35 * oneDay,
      })
    }
    for (let i = 0; i < 1000; i++) {
      logs.push({
        messageId: `new-${i}`,
        text: `New prompt ${i}`,
        createdAt: now - (1000 - i) * 1000,
      })
    }

    await store.upsertPromptLog('ws-prune', logs)
    const stored = await store.listPromptLog('ws-prune')

    // Upsert should have pruned the 100 expired logs
    assert.equal(stored.length, 1000)
    assert.ok(stored.every(item => item.createdAt >= now - 30 * oneDay))

    // Manual cleanExpiredPromptLogs entry point
    const result = await store.cleanExpiredPromptLogs({ now, maxCount: 500 })
    assert.equal(result.prunedCount, 500)
    assert.equal(result.remainingCount, 500)

    const afterClean = await store.listPromptLog('ws-prune')
    assert.equal(afterClean.length, 500)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// =========================================================================
// 3. Git branch detection (standard repo and worktree)
// =========================================================================

test('detectGitBranch detects branch from standard .git repository', () => {
  const tmpDir = makeTempDir('pd-git-')
  try {
    const gitDir = path.join(tmpDir, '.git')
    fs.mkdirSync(gitDir)
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/feat/refine-v2\n', 'utf8')

    const branch = detectGitBranch(tmpDir)
    assert.equal(branch, 'feat/refine-v2')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('detectGitBranch detects branch from git worktree with .git file', () => {
  const tmpDir = makeTempDir('pd-worktree-')
  try {
    const mainGitDir = path.join(tmpDir, 'main-repo-git', 'worktrees', 'feature-worktree')
    fs.mkdirSync(mainGitDir, { recursive: true })
    fs.writeFileSync(path.join(mainGitDir, 'HEAD'), 'ref: refs/heads/feature/worktree-branch\n', 'utf8')

    const worktreeDir = path.join(tmpDir, 'worktree-code')
    fs.mkdirSync(worktreeDir)
    // .git as file pointing to gitdir
    fs.writeFileSync(path.join(worktreeDir, '.git'), `gitdir: ${mainGitDir}\n`, 'utf8')

    const branch = detectGitBranch(worktreeDir)
    assert.equal(branch, 'feature/worktree-branch')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('detectGitBranch handles detached HEAD commit hash and non-git dirs', () => {
  const tmpDir = makeTempDir('pd-detached-')
  try {
    const gitDir = path.join(tmpDir, '.git')
    fs.mkdirSync(gitDir)
    fs.writeFileSync(path.join(gitDir, 'HEAD'), '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b\n', 'utf8')

    const branch = detectGitBranch(tmpDir)
    assert.equal(branch, '1a2b3c4')

    // Non-git dir returns empty string
    const nonGitDir = makeTempDir('pd-nongit-')
    try {
      assert.equal(detectGitBranch(nonGitDir), '')
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('detectGitCommit resolves HEAD from loose refs, packed-refs and detached HEAD', () => {
  const tmpDir = makeTempDir('pd-commit-')
  const nonGitDir = makeTempDir('pd-commit-nongit-')
  const hash = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0'
  try {
    const gitDir = path.join(tmpDir, '.git')
    fs.mkdirSync(gitDir)
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n', 'utf8')

    // Loose ref
    fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true })
    fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), `${hash}\n`, 'utf8')
    assert.equal(detectGitCommit(tmpDir), 'a1b2c3d')
    assert.equal(detectGitBranch(tmpDir), 'main')

    // Packed ref after the loose ref disappears
    fs.rmSync(path.join(gitDir, 'refs'), { recursive: true, force: true })
    fs.writeFileSync(path.join(gitDir, 'packed-refs'), `# pack-refs\n${hash} refs/heads/main\n`, 'utf8')
    assert.equal(detectGitCommit(tmpDir), 'a1b2c3d')

    // Detached HEAD
    fs.writeFileSync(path.join(gitDir, 'HEAD'), `${hash}\n`, 'utf8')
    assert.equal(detectGitCommit(tmpDir), 'a1b2c3d')
    assert.equal(detectGitCommit(nonGitDir), '')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(nonGitDir, { recursive: true, force: true })
  }
})

// =========================================================================
// 6. Host RPC Handlers & Route Adapters (spec writeback routes retired, Task 4.2)
// =========================================================================

test('Host RPC routes handleGitBranch, handleWorkspaceFiles, and the retired spec writeback routes are gone', async () => {
  const tmpDir = makeTempDir('pd-rpc-')
  try {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agents Spec\n', 'utf8')
    const gitDir = path.join(tmpDir, '.git')
    fs.mkdirSync(gitDir)
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/release/v2.0\n', 'utf8')
    fs.mkdirSync(path.join(gitDir, 'refs', 'heads', 'release'), { recursive: true })
    fs.writeFileSync(
      path.join(gitDir, 'refs', 'heads', 'release', 'v2.0'),
      '5f251df0123456789abcdef0123456789abcdef0\n',
      'utf8',
    )

    // 1. handleGitBranch
    const branchRes = await handleGitBranch({ workspaceId: tmpDir })
    assert.equal(branchRes.ok, true)
    assert.equal(branchRes.gitBranch, 'release/v2.0')
    assert.equal(branchRes.gitCommit, '5f251df')

    // 2b. handleWorkspaceFiles - deep nested hierarchy scan
    const nestedDir = path.join(tmpDir, 'src', 'client', 'deep')
    fs.mkdirSync(nestedDir, { recursive: true })
    fs.writeFileSync(path.join(nestedDir, 'component.jsx'), 'export const Deep = () => null\n')
    // Ignored directory
    const ignoredDir = path.join(tmpDir, 'node_modules', 'pkg')
    fs.mkdirSync(ignoredDir, { recursive: true })
    fs.writeFileSync(path.join(ignoredDir, 'index.js'), 'ignored')

    const filesRes = await handleWorkspaceFiles({ workspaceId: tmpDir })
    assert.equal(filesRes.ok, true)
    assert.ok(Array.isArray(filesRes.files))
    assert.ok(filesRes.files.some(f => f.name === 'AGENTS.md'))
    assert.ok(filesRes.files.some(f => f.path === 'src/client/deep/component.jsx' && f.kind === 'file'), 'Must index deep nested files')
    assert.ok(!filesRes.files.some(f => f.path.includes('node_modules')), 'Must ignore node_modules')

    // 2b. handleWorkspaceFiles with query
    const queryRes = await handleWorkspaceFiles({ workspaceId: tmpDir, query: 'component' })
    assert.equal(queryRes.ok, true)
    assert.equal(queryRes.files.length, 1)
    assert.equal(queryRes.files[0].name, 'component.jsx')
    assert.equal(queryRes.files[0].path, 'src/client/deep/component.jsx')

    // 2. adaptRoute with Express-style req/res
    const route = adaptRoute(handleGitBranch)
    let expressStatus = 0
    let expressJson = null
    const req = { query: { workspaceId: tmpDir }, method: 'GET' }
    const res = {
      status(code) { expressStatus = code; return this },
      json(data) { expressJson = data; return this },
    }
    await route(req, res)
    assert.equal(expressStatus, 200)
    assert.equal(expressJson.gitBranch, 'release/v2.0')

    // 5. apply(ctx) registers authenticated Fetch routes on the Connection
    //    service (the Host entry must never touch ctx.router / ctx.storageDomain
    //    without injecting them, otherwise the whole entry fails to activate).
    const registeredRoutes = []
    const fakeCtx = {
      effect(execute) { return execute() },
      get() { return undefined },
      connection: {
        fetch: {
          register(route) {
            registeredRoutes.push(route)
            return () => {}
          },
        },
      },
    }
    const pluginInstance = apply(fakeCtx)
    assert.ok(pluginInstance.hostStore, 'apply returns the host store instance')
    const routesByPath = Object.fromEntries(registeredRoutes.map(route => [route.path, route]))
    assert.deepEqual(routesByPath['/api/punch-desk/git-branch'].methods, ['GET'])

    // 3b. Task 4.2: the retired spec-baseline / spec-writeback routes must not
    //     be registered anymore (their CAS writeback moved to distill-apply).
    assert.equal(routesByPath['/api/punch-desk/spec-baseline'], undefined)
    assert.equal(routesByPath['/api/punch-desk/spec-writeback'], undefined)
    // 2026-11-11 UX Host contract: + estimate / delete / review / rebase;
    // park / abandon add two more paths after that; turn-actions-scan adds the 19th route.
    assert.equal(registeredRoutes.length, 19, '9 legacy paths - 2 retired + 11 distill paths + 1 turn-actions-scan')
    assert.deepEqual(routesByPath['/api/punch-desk/turn-actions-scan'].methods, ['POST'])

    // 4. The registered GET workspace-files route correctly forwards query param
    const filesResponse = await routesByPath['/api/punch-desk/workspace-files'].fetch(
      new Request(`http://localhost/api/punch-desk/workspace-files?workspaceId=${encodeURIComponent(tmpDir)}&query=spec`),
    )
    assert.equal(filesResponse.status, 200)
    const filesBody = await filesResponse.json()
    assert.equal(filesBody.ok, true)
    assert.ok(Array.isArray(filesBody.files))

    // 5. No write-back route exists, so the disk file stays untouched
    assert.equal(fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf8'), '# Agents Spec\n')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
