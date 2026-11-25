import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHostDeskStore, sha256Hex } from '../src/store/host.js'
import { createDistillLifecycle, createDistillApply } from '../src/store/distill-host.js'
import { createDistillRun } from '../src/domain/distill-run.js'
import { computeFingerprint } from '../src/domain/distill-plan.js'
import { handleDistillApply, apply as pluginApply } from '../index.js'

const T0 = 1_700_000_000_000
const WS = 'ws-1'
const GUIDE = '# Guide\n\n## Section A\n\nalpha\n\n## Section B\n\nbeta\n'
const AGENTS_NAV = '# AGENTS\n\n## 0. 工程文档体系与导航 (Project Documentation Navigation)\n\n- AGENTS.md\n- README.md\n- docs/\n  - guide.md\n  - new.md\n\n## 1. Other\n'
const SESSIONS = [{ sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's3' }]

function mkChange(over = {}) {
  return {
    id: 'c1',
    kind: 'insert-into-section',
    sectionAnchor: '## Section A',
    proposedText: 'inserted note',
    rationale: 'because the session decided so',
    evidenceSnippet: 'excerpt',
    evidence: [{ sessionId: 's1', messageId: 'm1', turn: 1, grade: 'resolved' }],
    dependsOn: [],
    ...over,
  }
}

function restat(plan) {
  const byGrade = { resolved: 0, commit: 0, submitted: 0 }
  let changes = 0
  for (const target of plan.targets) {
    for (const change of target.changes) {
      changes += 1
      const grades = change.evidence.map(e => e.grade)
      const grade = grades.includes('resolved') ? 'resolved' : grades.includes('commit') ? 'commit' : grades.includes('submitted') ? 'submitted' : null
      if (grade) byGrade[grade] += 1
    }
  }
  plan.stats = { targets: plan.targets.length, changes, byGrade }
  return plan
}

function makeEnv(t, { files = {}, fs: fsOverride } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-apply-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const wsDir = path.join(root, 'ws')
  fs.mkdirSync(path.join(wsDir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(wsDir, 'AGENTS.md'), AGENTS_NAV)
  fs.writeFileSync(path.join(wsDir, 'docs', 'guide.md'), GUIDE)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(wsDir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  const backupsRoot = path.join(root, 'backups')
  const store = createHostDeskStore({ storageFilePath: path.join(root, 'store', 'punch_desk.json'), now: () => T0 })
  const clock = { now: T0 }
  let seq = 0
  const now = () => clock.now
  const uuid = () => `id-${++seq}`
  const workspaces = [{ id: WS, path: wsDir }]
  const fsImpl = fsOverride || fs
  const lifecycle = createDistillLifecycle({ store, workspaces, now, uuid, fs: fsImpl })
  const distillApply = createDistillApply({ lifecycle, store, workspaces, now, uuid, backupsRoot, fs: fsImpl })
  lifecycle.registerApplyRecovery(distillApply.recoverApplying)
  return { root, wsDir, backupsRoot, store, lifecycle, distillApply, clock, workspaces, uuid }
}

async function seedApplying(env, tx, { runId = 'run-1' } = {}) {
  const created = createDistillRun({ id: runId, workspaceId: WS, sessions: SESSIONS, now: T0 })
  return env.store.putDistillRun({ ...created, status: 'applying', updatedAt: T0, tx })
}

const recover = (env, run) => env.distillApply.recoverApplying({ run, workspaceDir: env.wsDir, store: env.store, now: T0 })

function backupDirOf(env) {
  return path.join(env.backupsRoot, `ws-${sha256Hex(WS).slice(0, 8)}`)
}

/** Seed a crashed update transaction: backup on disk + target at new content. */
async function seedCrashedUpdate(env, { file = 'docs/guide.md', original = GUIDE, updated, withBackup = true, currentFile = true, done = false } = {}) {
  const full = path.join(env.wsDir, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, updated)
  const baseHash = sha256Hex(original)
  const newHash = sha256Hex(updated)
  let backupPath
  if (withBackup) {
    fs.mkdirSync(backupDirOf(env), { recursive: true })
    backupPath = path.join(backupDirOf(env), `${T0}-${encodeURIComponent(file)}`)
    fs.writeFileSync(backupPath, original)
  }
  const item = { file, action: 'update', baseHash, newHash, ...(backupPath ? { backupPath } : {}) }
  const tx = {
    startedAt: T0,
    files: [item],
    done: done ? [item] : [],
    fingerprintIds: [],
    ...(currentFile ? { currentFile: { ...item } } : {}),
  }
  const run = await seedApplying(env, tx)
  return { run, item, backupPath, full }
}

/** Proxy fs that logs rename targets (rollback order assertions). */
function recordingFs(log) {
  return new Proxy(fs, {
    get(target, prop) {
      if (prop === 'renameSync') {
        return (from, to) => { log.push(to); return target.renameSync(from, to) }
      }
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function makePlan(env, over = {}) {
  const content = fs.readFileSync(path.join(env.wsDir, 'docs', 'guide.md'), 'utf8')
  return restat({
    schemaVersion: 1,
    runId: 'run-1',
    workspaceId: WS,
    summary: 'apply test plan',
    navigation: { source: 'AGENTS.md#0', mode: 'tree', fallback: false },
    targets: [{
      file: 'docs/guide.md',
      action: 'update',
      navRef: 'AGENTS.md > docs/',
      fileBaseHash: sha256Hex(content),
      changes: [mkChange()],
    }],
    conflicts: [],
    stats: { targets: 1, changes: 1, byGrade: { resolved: 1, commit: 0, submitted: 0 } },
    truncated: false,
    ...over,
  })
}

async function seedReadyRun(env, plan, { runId = 'run-1', status = 'ready' } = {}) {
  const created = createDistillRun({ id: runId, workspaceId: WS, sessions: SESSIONS, now: T0 })
  const run = await env.store.putDistillRun({ ...created, status, planId: runId, updatedAt: T0 })
  await env.store.putDistillPlan({ ...plan, runId })
  return run
}

const applyInput = (over = {}) => ({ runId: 'run-1', selectedChangeIds: ['c1'], ...over })
const readGuide = env => fs.readFileSync(path.join(env.wsDir, 'docs', 'guide.md'), 'utf8')

// ---------------------------------------------------------------------------
// Batch 1 — happy path, CAS, selection, validation, routing
// ---------------------------------------------------------------------------

test('apply: happy path writes synthesized content, backup, fingerprint and applied run', async (t) => {
  const env = makeEnv(t)
  await seedReadyRun(env, makePlan(env))
  const result = await env.distillApply.applyPlan(applyInput())
  assert.equal(result.ok, true)
  assert.equal(result.status, 200)
  assert.equal(result.runStatus, 'applied')
  assert.equal(result.readBackOk, true)
  assert.equal(result.applied.length, 1)
  const item = result.applied[0]
  assert.equal(item.file, 'docs/guide.md')
  assert.equal(item.action, 'update')
  assert.match(item.newHash, /^[0-9a-f]{64}$/)
  assert.ok(item.backupPath)
  assert.equal(readGuide(env), '# Guide\n\n## Section A\n\nalpha\n\ninserted note\n\n## Section B\n\nbeta\n')
  assert.equal(fs.readFileSync(item.backupPath, 'utf8'), GUIDE)
  assert.equal(sha256Hex(readGuide(env)), item.newHash)
  const run = await env.store.getDistillRun('run-1')
  assert.equal(run.status, 'applied')
  assert.equal(run.tx, undefined)
  assert.ok(run.appliedAt)
  assert.equal(result.fingerprints.length, 1)
  const fps = await env.store.listDistillFingerprints(WS)
  assert.equal(fps.length, 1)
  assert.equal(fps[0].id, result.fingerprints[0])
  assert.equal(fps[0].targetFile, 'docs/guide.md')
  assert.equal(fps[0].changeKind, 'insert-into-section')
  assert.equal(fps[0].appliedFileHash, item.newHash)
  assert.equal(fps[0].backupPath, item.backupPath)
  assert.equal(fps[0].normalizedHash, computeFingerprint({ targetFile: 'docs/guide.md', sectionAnchor: '## Section A', proposedText: 'inserted note' }))
  assert.deepEqual(fps[0].sourceRefs, [{ sessionId: 's1', messageId: 'm1', turn: 1 }])
  assert.equal(env.lifecycle.getRunControl('run-1').state, 'finished')
})

test('apply: backup naming is reversible, workspace-scoped and collision-safe', async (t) => {
  const env = makeEnv(t)
  await seedReadyRun(env, makePlan(env))
  const result = await env.distillApply.applyPlan(applyInput())
  const item = result.applied[0]
  const dir = path.dirname(item.backupPath)
  const expectedDir = path.join(env.backupsRoot, `ws-${sha256Hex(WS).slice(0, 8)}`)
  assert.equal(dir, expectedDir)
  assert.equal(path.basename(item.backupPath), `${T0}-docs%2Fguide.md`)
  // A pre-existing同名 backup forces the incremental suffix.
  const env2 = makeEnv(t)
  fs.mkdirSync(path.join(env2.backupsRoot, `ws-${sha256Hex(WS).slice(0, 8)}`), { recursive: true })
  fs.writeFileSync(path.join(env2.backupsRoot, `ws-${sha256Hex(WS).slice(0, 8)}`, `${T0}-docs%2Fguide.md`), 'occupied')
  await seedReadyRun(env2, makePlan(env2))
  const result2 = await env2.distillApply.applyPlan(applyInput())
  assert.equal(path.basename(result2.applied[0].backupPath), `${T0}-docs%2Fguide.md-1`)
})

test('apply: multi-file update + create with paired AGENTS registration', async (t) => {
  const env = makeEnv(t)
  const agentsContent = fs.readFileSync(path.join(env.wsDir, 'AGENTS.md'), 'utf8')
  const plan = makePlan(env, {
    targets: [
      makePlan(env).targets[0],
      {
        file: 'docs/new.md', action: 'create', navRef: 'AGENTS.md > docs/', fileBaseHash: null,
        changes: [mkChange({ id: 'c2', kind: 'create-file', sectionAnchor: undefined, proposedText: '# New\n\nfresh body' })],
      },
      {
        file: 'AGENTS.md', action: 'update', navRef: 'AGENTS.md', fileBaseHash: sha256Hex(agentsContent),
        changes: [mkChange({ id: 'c3', kind: 'append-section', sectionAnchor: undefined, proposedText: '## 2. Registration\n\n- docs/new.md' })],
      },
    ],
  })
  await seedReadyRun(env, plan)
  const result = await env.distillApply.applyPlan(applyInput({ selectedChangeIds: ['c1', 'c2', 'c3'] }))
  assert.equal(result.ok, true)
  assert.equal(result.applied.length, 3)
  const created = result.applied.find(a => a.file === 'docs/new.md')
  assert.equal(created.action, 'create')
  assert.equal(created.backupPath, undefined)
  assert.equal(fs.readFileSync(path.join(env.wsDir, 'docs', 'new.md'), 'utf8'), '# New\n\nfresh body\n')
  assert.match(fs.readFileSync(path.join(env.wsDir, 'AGENTS.md'), 'utf8'), /## 2\. Registration/)
  assert.equal((await env.store.getDistillRun('run-1')).status, 'applied')
})

test('apply: CAS conflict when disk changed after analysis (nothing written)', async (t) => {
  const env = makeEnv(t)
  await seedReadyRun(env, makePlan(env))
  fs.writeFileSync(path.join(env.wsDir, 'docs', 'guide.md'), '# Guide\n\nexternally edited\n')
  const result = await env.distillApply.applyPlan(applyInput())
  assert.equal(result.ok, false)
  assert.equal(result.status, 409)
  assert.equal(result.code, 'CAS_CONFLICT')
  assert.equal(result.file, 'docs/guide.md')
  assert.equal(result.expected, sha256Hex(GUIDE))
  assert.equal(result.actual, sha256Hex('# Guide\n\nexternally edited\n'))
  assert.equal(result.rolledBack, false)
  assert.equal((await env.store.getDistillRun('run-1')).status, 'ready')
  assert.equal(fs.existsSync(env.backupsRoot), false)
})

test('apply: request baseHashes are secondary confirmation only', async (t) => {
  const env = makeEnv(t)
  await seedReadyRun(env, makePlan(env))
  const mismatch = await env.distillApply.applyPlan(applyInput({ baseHashes: { 'docs/guide.md': 'f'.repeat(64) } }))
  assert.equal(mismatch.code, 'CAS_CONFLICT')
  assert.equal(mismatch.expected, sha256Hex(GUIDE))
  assert.equal(mismatch.actual, 'f'.repeat(64))
  const ok = await env.distillApply.applyPlan(applyInput({ baseHashes: { 'docs/guide.md': sha256Hex(GUIDE) } }))
  assert.equal(ok.ok, true)
})

test('apply: rejects unknown run, non-ready run and invalid selections', async (t) => {
  const env = makeEnv(t)
  assert.equal((await env.distillApply.applyPlan(applyInput({ runId: 'ghost' }))).status, 404)
  assert.equal((await env.distillApply.applyPlan({})).code, 'INVALID_REQUEST')
  assert.equal((await env.distillApply.applyPlan(applyInput({ selectedChangeIds: [] }))).code, 'INVALID_REQUEST')
  await seedReadyRun(env, makePlan(env), { status: 'analyzing' })
  const notReady = await env.distillApply.applyPlan(applyInput())
  assert.equal(notReady.code, 'RUN_NOT_READY')
  assert.equal(notReady.runStatus, 'analyzing')
})

test('apply: unknown change ids and missing dependencies are refused', async (t) => {
  const env = makeEnv(t)
  const plan = makePlan(env, {
    targets: [{
      ...makePlan(env).targets[0],
      changes: [mkChange(), mkChange({ id: 'c2', proposedText: 'second note', dependsOn: ['c1'] })],
    }],
  })
  await seedReadyRun(env, plan)
  const unknown = await env.distillApply.applyPlan(applyInput({ selectedChangeIds: ['nope'] }))
  assert.equal(unknown.code, 'INVALID_REQUEST')
  const missing = await env.distillApply.applyPlan(applyInput({ selectedChangeIds: ['c2'] }))
  assert.equal(missing.code, 'INVALID_REQUEST')
  assert.deepEqual(missing.missing, [{ changeId: 'c2', dependsOn: ['c1'] }])
  assert.equal((await env.store.getDistillRun('run-1')).status, 'ready')
  const complete = await env.distillApply.applyPlan(applyInput({ selectedChangeIds: ['c1', 'c2'] }))
  assert.equal(complete.ok, true)
  assert.match(readGuide(env), /inserted note\n\nsecond note/)
})

test('apply: partial selection synthesizes only selected changes', async (t) => {
  const env = makeEnv(t)
  const plan = makePlan(env, {
    targets: [{
      ...makePlan(env).targets[0],
      changes: [mkChange(), mkChange({ id: 'c2', proposedText: 'second note' })],
    }],
  })
  await seedReadyRun(env, plan)
  const result = await env.distillApply.applyPlan(applyInput({ selectedChangeIds: ['c2'] }))
  assert.equal(result.ok, true)
  const content = readGuide(env)
  assert.match(content, /second note/)
  assert.doesNotMatch(content, /inserted note/)
})

test('apply: §9 validation errors block application and keep the run ready', async (t) => {
  const env = makeEnv(t)
  const plan = makePlan(env, {
    targets: [{ ...makePlan(env).targets[0], changes: [mkChange({ sectionAnchor: '## Ghost' })] }],
  })
  await seedReadyRun(env, plan)
  const result = await env.distillApply.applyPlan(applyInput())
  assert.equal(result.ok, false)
  assert.equal(result.code, 'VALIDATION_FAILED')
  assert.ok(result.checks.some(c => c.code === 'ANCHOR_MISSING' && c.level === 'error'))
  assert.equal((await env.store.getDistillRun('run-1')).status, 'ready')
  assert.equal(readGuide(env), GUIDE)
})

test('apply: path boundary and symlink targets are rejected', async (t) => {
  const env = makeEnv(t)
  const badPath = makePlan(env, { targets: [{ ...makePlan(env).targets[0], file: '../evil.md' }] })
  await seedReadyRun(env, badPath)
  const rejected = await env.distillApply.applyPlan(applyInput())
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'VALIDATION_FAILED')
  // symlink target: surface collection rejects it, validation blocks apply.
  const env2 = makeEnv(t)
  fs.symlinkSync(path.join(env2.wsDir, 'docs', 'guide.md'), path.join(env2.wsDir, 'docs', 'link.md'))
  const linkPlan = makePlan(env2, { targets: [{ ...makePlan(env2).targets[0], file: 'docs/link.md' }] })
  await seedReadyRun(env2, linkPlan)
  const linkResult = await env2.distillApply.applyPlan(applyInput())
  assert.equal(linkResult.ok, false)
  assert.equal(linkResult.code, 'VALIDATION_FAILED')
})

test('apply: create target appearing after analysis is a no-clobber CAS conflict', async (t) => {
  const env = makeEnv(t)
  const agentsContent = fs.readFileSync(path.join(env.wsDir, 'AGENTS.md'), 'utf8')
  const plan = makePlan(env, {
    targets: [
      { file: 'docs/new.md', action: 'create', navRef: 'AGENTS.md > docs/', fileBaseHash: null, changes: [mkChange({ id: 'c2', kind: 'create-file', sectionAnchor: undefined, proposedText: '# New\n\nbody' })] },
      { file: 'AGENTS.md', action: 'update', navRef: 'AGENTS.md', fileBaseHash: sha256Hex(agentsContent), changes: [mkChange({ id: 'c3', kind: 'append-section', sectionAnchor: undefined, proposedText: '## 2. Reg\n\n- docs/new.md' })] },
    ],
  })
  await seedReadyRun(env, plan)
  fs.writeFileSync(path.join(env.wsDir, 'docs', 'new.md'), '# appeared externally\n')
  const result = await env.distillApply.applyPlan(applyInput({ selectedChangeIds: ['c2', 'c3'] }))
  assert.equal(result.code, 'CAS_CONFLICT')
  assert.equal(result.file, 'docs/new.md')
  assert.equal(fs.readFileSync(path.join(env.wsDir, 'docs', 'new.md'), 'utf8'), '# appeared externally\n')
  assert.equal((await env.store.getDistillRun('run-1')).status, 'ready')
})

test('apply: equivalent final content is skipped but fingerprinted (§12.4)', async (t) => {
  const env = makeEnv(t)
  const plan = makePlan(env, {
    targets: [{ ...makePlan(env).targets[0], changes: [mkChange({ kind: 'replace-block', proposedText: 'alpha' })] }],
  })
  await seedReadyRun(env, plan)
  const result = await env.distillApply.applyPlan(applyInput())
  assert.equal(result.ok, true)
  assert.deepEqual(result.applied, [])
  assert.deepEqual(result.skipped, [{ file: 'docs/guide.md', reason: 'equivalent', hash: sha256Hex(GUIDE) }])
  assert.equal(readGuide(env), GUIDE)
  assert.equal((await env.store.getDistillRun('run-1')).status, 'applied')
  const fps = await env.store.listDistillFingerprints(WS)
  assert.equal(fps.length, 1)
  assert.equal(fps[0].appliedFileHash, sha256Hex(GUIDE))
  assert.equal(fps[0].backupPath, undefined)
})

test('apply: rationaleEdits write back to the plan preserving rawResponseRef', async (t) => {
  const env = makeEnv(t)
  const plan = makePlan(env)
  plan.rawResponseRef = 'raw-model-response-abc'
  await seedReadyRun(env, plan)
  const result = await env.distillApply.applyPlan(applyInput({ rationaleEdits: { c1: '人工改写后的理由' } }))
  assert.equal(result.ok, true)
  const stored = await env.store.getDistillPlan('run-1')
  assert.equal(stored.targets[0].changes[0].rationale, '人工改写后的理由')
  assert.equal(stored.rawResponseRef, 'raw-model-response-abc')
  assert.equal(stored.targets[0].changes[0].proposedText, 'inserted note')
})

test('apply: same-anchor inserts concatenate in selection order through the route handler', async (t) => {
  const env = makeEnv(t)
  const plan = makePlan(env, {
    targets: [{
      ...makePlan(env).targets[0],
      changes: [mkChange({ id: 'c1', proposedText: 'first' }), mkChange({ id: 'c2', proposedText: 'second' })],
    }],
  })
  await seedReadyRun(env, plan)
  const result = await handleDistillApply(applyInput({ selectedChangeIds: ['c1', 'c2'] }), { distillApply: env.distillApply })
  assert.equal(result.ok, true)
  assert.match(readGuide(env), /alpha\n\nfirst\n\nsecond\n\n## Section B/)
  const unavailable = await handleDistillApply(applyInput(), {})
  assert.equal(unavailable.status, 500)
})

test('routes: apply() registers distill-apply and wires recovery + engine', async (t) => {
  const env = makeEnv(t)
  const routes = []
  const ctx = {
    get: () => undefined,
    effect: fn => fn(),
    connection: { fetch: { register: route => routes.push(route) } },
  }
  const wired = pluginApply(ctx, {
    hostStore: env.store,
    workspaces: env.workspaces,
    distillBackupsRoot: env.backupsRoot,
  })
  assert.ok(wired.distillApply)
  const route = routes.find(r => r.path === '/api/punch-desk/distill-apply')
  assert.ok(route, 'distill-apply route registered')
  assert.deepEqual(route.methods, ['POST'])
  // The wired engine uses the real clock: seed fresh rows so lazy recovery
  // does not TTL-stale them before apply.
  const freshNow = Date.now()
  const created1 = createDistillRun({ id: 'run-1', workspaceId: WS, sessions: SESSIONS, now: freshNow })
  await env.store.putDistillRun({ ...created1, status: 'ready', planId: 'run-1', updatedAt: freshNow })
  await env.store.putDistillPlan({ ...makePlan(env), runId: 'run-1' })
  const response = await route.fetch(new Request('http://localhost/api/punch-desk/distill-apply', {
    method: 'POST',
    body: JSON.stringify(applyInput()),
    headers: { 'content-type': 'application/json' },
  }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.runStatus, 'applied')
  // Recovery hook is registered: a seeded applying run recovers through it.
  const created = createDistillRun({ id: 'run-2', workspaceId: WS, sessions: SESSIONS, now: freshNow })
  await env.store.putDistillRun({ ...created, status: 'applying', updatedAt: freshNow, tx: { startedAt: freshNow, files: [], done: [], fingerprintIds: [] } })
  const outcome = await env.lifecycle.recoverWorkspace(WS)
  assert.ok(outcome.recovered >= 1)
  assert.equal((await env.store.getDistillRun('run-2')).status, 'failed')
})