import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PLAN_SCHEMA_VERSION,
  CHANGE_KINDS,
  LIMITS,
  isAllowedDocPath,
  normalizeNewlines,
  parseAtxHeading,
  collectAtxAnchors,
  normalizeForFingerprint,
  fingerprintInput,
  computeFingerprint,
  isEquivalentContent,
  changeGrade,
  validateChangePlan,
  validatePlan,
  defaultSelection,
  validateDependencySelection,
  synthesizeFileContent,
} from '../src/domain/distill-plan.js'

const HASH = 'a'.repeat(64)
const OTHER_HASH = 'b'.repeat(64)

// # Title / ## A (with child ### A1) / ## B — 13 lines, trailing newline.
const DOC = '# Title\n\n## A\n\nalpha\n\n### A1\n\nchild\n\n## B\n\nbeta\n'
const DOC_LINES = DOC.replace(/\n$/, '').split('\n')

function mkChange(over = {}) {
  return {
    id: 'c1',
    kind: 'insert-into-section',
    sectionAnchor: '## A',
    proposedText: 'inserted note',
    rationale: 'because the session decided so',
    evidenceSnippet: 'result-pair excerpt',
    evidence: [{ sessionId: 's1', messageId: 'm1', turn: 1, grade: 'resolved' }],
    dependsOn: [],
    ...over,
  }
}

function mkTarget(over = {}) {
  return {
    file: 'docs/guide.md',
    action: 'update',
    navRef: 'AGENTS.md > docs/',
    fileBaseHash: HASH,
    changes: [mkChange()],
    ...over,
  }
}

function restat(plan) {
  const byGrade = { resolved: 0, commit: 0, submitted: 0 }
  let changes = 0
  for (const target of plan.targets) {
    for (const change of target.changes) {
      changes++
      const grade = changeGrade(change)
      if (grade && grade in byGrade) byGrade[grade]++
    }
  }
  plan.stats = { targets: plan.targets.length, changes, byGrade }
  return plan
}

function mkPlan(over = {}) {
  return restat({
    schemaVersion: PLAN_SCHEMA_VERSION,
    runId: 'run-1',
    workspaceId: 'ws-1',
    summary: '沉淀了会话决议，更新指南文档；无未决冲突。',
    navigation: { source: 'AGENTS.md#0', mode: 'tree', fallback: false },
    targets: [mkTarget()],
    conflicts: [],
    stats: { targets: 1, changes: 1, byGrade: { resolved: 1, commit: 0, submitted: 0 } },
    truncated: false,
    ...over,
  })
}

function mkSnapshot(over = {}) {
  const content = over.content ?? DOC
  const { content: _content, targets: targetOver, ...rest } = over
  return {
    navigation: { content: 'AGENTS.md §0 tree text', mode: 'tree' },
    targets: [{
      file: 'docs/guide.md',
      exists: true,
      content,
      fileBaseHash: HASH,
      anchors: collectAtxAnchors(content),
      navRegistered: true,
      ...(targetOver ?? {}),
    }],
    plannedFiles: [],
    ...rest,
  }
}

function codes(result) {
  return result.checks.map((c) => c.code)
}

// ---------------------------------------------------------------------------
// §8.3 path boundary (pure part)
// ---------------------------------------------------------------------------

test('path boundary accepts root files and docs/** markdown', () => {
  for (const ok of ['AGENTS.md', 'README.md', 'docs/a.md', 'docs/arch/models/finding.md', 'docs/深.md']) {
    assert.equal(isAllowedDocPath(ok), true, ok)
  }
})

test('path boundary rejects traversal, absolute, hidden, non-md and foreign paths', () => {
  const bad = [
    '../x.md', 'docs/../AGENTS.md', 'docs/./a.md', 'docs//a.md', '/abs.md', 'C:/x.md',
    'docs\\.a.md', 'docs/.hidden/a.md', '.hidden.md', 'src/a.md', 'a.txt', 'docs/a.MD',
    '', 'docs/', 'docs/..md', 'docs/a.md/..', null, 42,
  ]
  for (const file of bad) assert.equal(isAllowedDocPath(file), false, String(file))
})

// ---------------------------------------------------------------------------
// ATX anchor rules (§8.4 细则)
// ---------------------------------------------------------------------------

test('parseAtxHeading honors level, closing hashes, spacing and setext exclusion', () => {
  assert.deepEqual(parseAtxHeading('# A'), { level: 1, text: 'A' })
  assert.deepEqual(parseAtxHeading('###### A'), { level: 6, text: 'A' })
  assert.deepEqual(parseAtxHeading('## A ##'), { level: 2, text: 'A' })
  assert.deepEqual(parseAtxHeading('## A   '), { level: 2, text: 'A' })
  assert.deepEqual(parseAtxHeading('   ## A'), { level: 2, text: 'A' })
  assert.deepEqual(parseAtxHeading('#'), { level: 1, text: '' })
  assert.deepEqual(parseAtxHeading('## A##'), { level: 2, text: 'A##' })
  assert.equal(parseAtxHeading('####### A'), null)
  assert.equal(parseAtxHeading('    ## A'), null)
  assert.equal(parseAtxHeading('#A'), null)
  assert.equal(parseAtxHeading('A\n---'), null)
  assert.equal(parseAtxHeading('plain text'), null)
})

test('collectAtxAnchors computes sections incl. children with exclusive endLine', () => {
  assert.deepEqual(collectAtxAnchors(DOC), [
    { text: 'Title', level: 1, startLine: 0, endLine: 13 },
    { text: 'A', level: 2, startLine: 2, endLine: 10 },
    { text: 'A1', level: 3, startLine: 6, endLine: 10 },
    { text: 'B', level: 2, startLine: 10, endLine: 13 },
  ])
  assert.deepEqual(collectAtxAnchors(''), [])
})

test('collectAtxAnchors excludes fenced pseudo headings and setext', () => {
  const content = ['# Title', '', '```markdown', '# Fake', '## AlsoFake', '```', '', '~~~', '## TildeFake', '~~~', '', '## Real', '', 'Setext', '---', ''].join('\n')
  assert.deepEqual(collectAtxAnchors(content).map((a) => a.text), ['Title', 'Real'])
})

test('collectAtxAnchors only closes a fence with a matching longer-or-equal marker', () => {
  const content = ['# Title', '', '````', '```', '# InsideFence', '````', '', '## After', ''].join('\n')
  assert.deepEqual(collectAtxAnchors(content).map((a) => a.text), ['Title', 'After'])
})

// ---------------------------------------------------------------------------
// ChangePlan schema (§5.2)
// ---------------------------------------------------------------------------

test('schema accepts a well-formed plan', () => {
  const result = validateChangePlan(mkPlan())
  assert.deepEqual(result, { ok: true, errors: [] })
})

test('schema rejects bad envelope fields', () => {
  assert.equal(validateChangePlan(null).ok, false)
  assert.equal(validateChangePlan(mkPlan({ schemaVersion: 2 })).ok, false)
  assert.equal(validateChangePlan(mkPlan({ runId: '' })).ok, false)
  assert.equal(validateChangePlan(mkPlan({ workspaceId: '' })).ok, false)
  assert.equal(validateChangePlan(mkPlan({ workspaceId: 'default' })).ok, false)
  assert.equal(validateChangePlan(mkPlan({ summary: '' })).ok, false)
  assert.equal(validateChangePlan(mkPlan({ truncated: 'no' })).ok, false)
  assert.equal(validateChangePlan(mkPlan({ navigation: { source: 'x', mode: 'weird', fallback: false } })).ok, false)
  assert.equal(validateChangePlan(mkPlan({ navigation: { source: 'x', mode: 'tree', fallback: true } })).ok, false)
})

test('schema enforces §8.3 paths on every target', () => {
  const result = validateChangePlan(mkPlan({ targets: [mkTarget({ file: '../escape.md' })] }))
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /path boundary/)
})

test('schema enforces create/update hash and change-kind pairing', () => {
  const createChange = mkChange({ id: 'c1', kind: 'create-file', sectionAnchor: undefined, proposedText: '# New\n\nbody' })
  const create = mkTarget({ file: 'docs/new.md', action: 'create', fileBaseHash: null, changes: [createChange] })
  assert.equal(validateChangePlan(mkPlan({ targets: [create] })).ok, true)
  assert.equal(validateChangePlan(mkPlan({ targets: [mkTarget({ file: 'docs/new.md', action: 'create', fileBaseHash: HASH, changes: [createChange] })] })).ok, false)
  assert.equal(validateChangePlan(mkPlan({ targets: [mkTarget({ file: 'docs/new.md', action: 'create', fileBaseHash: null, changes: [createChange, mkChange({ id: 'c2' })] })] })).ok, false)
  assert.equal(validateChangePlan(mkPlan({ targets: [mkTarget({ changes: [mkChange({ kind: 'create-file' })] })] })).ok, false)
  assert.equal(validateChangePlan(mkPlan({ targets: [mkTarget({ fileBaseHash: null })] })).ok, false)
  assert.equal(validateChangePlan(mkPlan({ targets: [mkTarget({ fileBaseHash: 'short' })] })).ok, false)
})

test('schema rejects duplicate target files and duplicate change ids', () => {
  const dupFile = mkPlan({ targets: [mkTarget(), mkTarget()] })
  assert.equal(validateChangePlan(dupFile).ok, false)
  const dupId = mkPlan({ targets: [mkTarget({ changes: [mkChange(), mkChange()] })] })
  assert.equal(validateChangePlan(dupId).ok, false)
})

test('schema validates dependsOn references, self-refs and cycles', () => {
  const unknown = mkPlan({ targets: [mkTarget({ changes: [mkChange({ dependsOn: ['nope'] })] })] })
  assert.equal(validateChangePlan(unknown).ok, false)
  const self = mkPlan({ targets: [mkTarget({ changes: [mkChange({ dependsOn: ['c1'] })] })] })
  assert.equal(validateChangePlan(self).ok, false)
  const cycle = mkPlan({
    targets: [mkTarget({
      changes: [mkChange({ id: 'c1', dependsOn: ['c2'] }), mkChange({ id: 'c2', dependsOn: ['c1'] })],
    })],
  })
  const cycleResult = validateChangePlan(cycle)
  assert.equal(cycleResult.ok, false)
  assert.match(cycleResult.errors.join('\n'), /cycle/)
})

test('schema enforces anchor presence rules per kind', () => {
  assert.equal(validateChangePlan(mkPlan({ targets: [mkTarget({ changes: [mkChange({ kind: 'insert-into-section', sectionAnchor: '' })] })] })).ok, false)
  assert.equal(validateChangePlan(mkPlan({ targets: [mkTarget({ changes: [mkChange({ kind: 'replace-block', sectionAnchor: undefined })] })] })).ok, false)
  assert.equal(validateChangePlan(mkPlan({ targets: [mkTarget({ changes: [mkChange({ kind: 'create-file', sectionAnchor: '## A', proposedText: '# N\n\nx' })] })] })).ok, false)
  assert.equal(validateChangePlan(mkPlan({ targets: [mkTarget({ changes: [mkChange({ kind: 'append-section', sectionAnchor: undefined, proposedText: '## C\n\nx' })] })] })).ok, true)
})

test('schema requires ATX-leading proposedText for append/create', () => {
  assert.equal(validateChangePlan(mkPlan({ targets: [mkTarget({ changes: [mkChange({ kind: 'append-section', proposedText: 'no heading' })] })] })).ok, false)
  const create = mkTarget({ file: 'docs/new.md', action: 'create', fileBaseHash: null, changes: [mkChange({ kind: 'create-file', sectionAnchor: undefined, proposedText: 'plain start' })] })
  assert.equal(validateChangePlan(mkPlan({ targets: [create] })).ok, false)
})

test('schema enforces evidence grades, snippet cap and submitted rationale prefix', () => {
  const longSnippet = mkPlan({ targets: [mkTarget({ changes: [mkChange({ evidenceSnippet: '字'.repeat(301) })] })] })
  assert.equal(validateChangePlan(longSnippet).ok, false)
  const dismissedOnly = mkPlan({ targets: [mkTarget({ changes: [mkChange({ evidence: [{ sessionId: 's', messageId: 'm', grade: 'dismissed' }] })] })] })
  assert.equal(validateChangePlan(dismissedOnly).ok, false)
  const submittedBad = mkPlan({ targets: [mkTarget({ changes: [mkChange({ evidence: [{ sessionId: 's', messageId: 'm', grade: 'submitted' }], rationale: '直接写规则' })] })] })
  assert.equal(validateChangePlan(submittedBad).ok, false)
  const submittedOk = mkPlan({ targets: [mkTarget({ changes: [mkChange({ evidence: [{ sessionId: 's', messageId: 'm', grade: 'submitted' }], rationale: '待确认：仅提交证据' })] })] })
  assert.equal(validateChangePlan(submittedOk).ok, true)
  const commitNoHash = mkPlan({ targets: [mkTarget({ changes: [mkChange({ evidence: [{ sessionId: 's', messageId: 'm', grade: 'commit' }] })] })] })
  assert.equal(validateChangePlan(commitNoHash).ok, false)
})

test('schema validates conflicts shape and resolvedBy enum', () => {
  const claim = { sessionId: 's1', messageId: 'm1', claim: 'x', evidenceGrade: 'resolved', turn: 1 }
  const conflict = { topic: 't', claims: [claim, { ...claim, sessionId: 's2' }], resolvedBy: 'unresolved' }
  assert.equal(validateChangePlan(mkPlan({ conflicts: [conflict] })).ok, true)
  assert.equal(validateChangePlan(mkPlan({ conflicts: [{ ...conflict, resolvedBy: 'whatever' }] })).ok, false)
  assert.equal(validateChangePlan(mkPlan({ conflicts: [{ ...conflict, resolvedBy: 'code' }] })).ok, false)
  assert.equal(validateChangePlan(mkPlan({ conflicts: [{ ...conflict, claims: [claim] }] })).ok, false)
  const codeOk = { ...conflict, resolvedBy: 'code', codeEvidence: [{ commit: 'abc1234', committedAt: 1700000000, path: 'src/x.js' }] }
  assert.equal(validateChangePlan(mkPlan({ conflicts: [codeOk] })).ok, true)
})

test('schema rejects stats that disagree with the plan body', () => {
  const plan = mkPlan()
  plan.stats = { targets: 5, changes: 1, byGrade: { resolved: 1, commit: 0, submitted: 0 } }
  assert.equal(validateChangePlan(plan).ok, false)
  const plan2 = mkPlan()
  plan2.stats = { targets: 1, changes: 1, byGrade: { resolved: 0, commit: 1, submitted: 0 } }
  assert.equal(validateChangePlan(plan2).ok, false)
})

// ---------------------------------------------------------------------------
// validatePlan (§9 checklist)
// ---------------------------------------------------------------------------

test('validatePlan passes a clean tree-mode plan and snapshot', () => {
  const result = validatePlan(mkPlan(), mkSnapshot())
  assert.deepEqual(result.checks, [])
  assert.equal(result.ok, true)
})

test('validatePlan surfaces schema errors and stops', () => {
  const result = validatePlan(mkPlan({ runId: '' }), mkSnapshot())
  assert.equal(result.ok, false)
  assert.ok(result.checks.every((c) => c.code === 'SCHEMA' && c.level === 'error'))
})

test('validatePlan rejects malformed snapshots', () => {
  assert.equal(validatePlan(mkPlan(), null).ok, false)
  assert.equal(validatePlan(mkPlan(), { navigation: { mode: 'tree' }, targets: [], plannedFiles: [] }).ok, false)
})

test('navigation: tree mode requires update targets to be registered', () => {
  const result = validatePlan(mkPlan(), mkSnapshot({ targets: { navRegistered: false } }))
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('NAV_TREE'))
})

test('navigation: tree mode root update only as paired registration', () => {
  const plan = mkPlan({ targets: [mkTarget({ file: 'AGENTS.md' })] })
  const snap = mkSnapshot({ targets: { file: 'AGENTS.md' } })
  const result = validatePlan(plan, snap)
  assert.ok(codes(result).includes('NAV_ROOT'))
})

test('navigation: create requires paired AGENTS.md update and plannedFiles entry', () => {
  const createChange = mkChange({ id: 'cn', kind: 'create-file', sectionAnchor: undefined, proposedText: '# New\n\nbody' })
  const plan = mkPlan({ targets: [mkTarget({ file: 'docs/new.md', action: 'create', fileBaseHash: null, changes: [createChange] })] })
  const snap = mkSnapshot({
    targets: { file: 'docs/new.md', exists: false, content: undefined, fileBaseHash: null, anchors: [], navRegistered: false },
    plannedFiles: ['docs/new.md'],
  })
  const result = validatePlan(plan, snap)
  assert.ok(codes(result).includes('NAV_CREATE_PAIR'))
  // Add the paired AGENTS.md navigation-registration update -> passes.
  const agentsChange = mkChange({ id: 'ca', kind: 'append-section', sectionAnchor: undefined, proposedText: '## 0. Nav\n\n- docs/new.md' })
  const paired = mkPlan({
    targets: [
      mkTarget({ file: 'docs/new.md', action: 'create', fileBaseHash: null, changes: [createChange] }),
      mkTarget({ file: 'AGENTS.md', changes: [agentsChange] }),
    ],
  })
  const pairedSnap = {
    navigation: { content: 'tree', mode: 'tree' },
    targets: [
      { file: 'docs/new.md', exists: false, fileBaseHash: null, anchors: [], navRegistered: false },
      { file: 'AGENTS.md', exists: true, content: '# AGENTS\n', fileBaseHash: HASH, anchors: collectAtxAnchors('# AGENTS\n'), navRegistered: true },
    ],
    plannedFiles: ['docs/new.md'],
  }
  const pairedResult = validatePlan(paired, pairedSnap)
  assert.deepEqual(pairedResult.checks, [])
  assert.equal(pairedResult.ok, true)
})

test('navigation: fallback mode only allows root updates, never create', () => {
  const plan = mkPlan({ navigation: { source: 'fallback', mode: 'fallback', fallback: true } })
  const snap = mkSnapshot({ navigation: { content: '', mode: 'fallback' } })
  const docsResult = validatePlan(plan, snap)
  assert.ok(codes(docsResult).includes('NAV_FALLBACK'))
  const rootPlan = mkPlan({ navigation: { source: 'fallback', mode: 'fallback', fallback: true }, targets: [mkTarget({ file: 'README.md' })] })
  const rootSnap = mkSnapshot({ navigation: { content: '', mode: 'fallback' }, targets: { file: 'README.md' } })
  assert.equal(validatePlan(rootPlan, rootSnap).ok, true)
  const createChange = mkChange({ id: 'cn', kind: 'create-file', sectionAnchor: undefined, proposedText: '# N\n\nx' })
  const createPlan = mkPlan({ navigation: { source: 'fallback', mode: 'fallback', fallback: true }, targets: [mkTarget({ file: 'AGENTS.md', action: 'create', fileBaseHash: null, changes: [createChange] })] })
  const createSnap = mkSnapshot({ navigation: { content: '', mode: 'fallback' }, targets: { file: 'AGENTS.md', exists: false, content: undefined, fileBaseHash: null, anchors: [] }, plannedFiles: ['AGENTS.md'] })
  assert.ok(codes(validatePlan(createPlan, createSnap)).includes('NAV_FALLBACK_CREATE'))
})

test('navigation: plan/snapshot mode mismatch is an error', () => {
  const result = validatePlan(mkPlan(), mkSnapshot({ navigation: { content: '', mode: 'fallback' } }))
  assert.ok(codes(result).includes('NAV_MODE'))
})

test('baseline: hash mismatch, missing file, vanished update and missing content', () => {
  assert.ok(codes(validatePlan(mkPlan(), mkSnapshot({ targets: { fileBaseHash: OTHER_HASH } }))).includes('BASELINE_HASH'))
  assert.ok(codes(validatePlan(mkPlan(), mkSnapshot({ targets: { exists: false } }))).includes('UPDATE_MISSING'))
  const noContent = mkSnapshot()
  delete noContent.targets[0].content
  assert.ok(codes(validatePlan(mkPlan(), noContent)).includes('SNAPSHOT_INCOMPLETE'))
  const createChange = mkChange({ id: 'cn', kind: 'create-file', sectionAnchor: undefined, proposedText: '# N\n\nx' })
  const createPlan = mkPlan({
    targets: [
      mkTarget({ file: 'docs/new.md', action: 'create', fileBaseHash: null, changes: [createChange] }),
      mkTarget({ file: 'AGENTS.md', changes: [mkChange({ id: 'ca', kind: 'append-section', sectionAnchor: undefined, proposedText: '## Nav\n\n- docs/new.md' })] }),
    ],
  })
  const existsSnap = {
    navigation: { content: 'tree', mode: 'tree' },
    targets: [
      { file: 'docs/new.md', exists: true, content: '# already here\n', fileBaseHash: null, anchors: [], navRegistered: false },
      { file: 'AGENTS.md', exists: true, content: '# AGENTS\n', fileBaseHash: HASH, anchors: collectAtxAnchors('# AGENTS\n'), navRegistered: true },
    ],
    plannedFiles: ['docs/new.md'],
  }
  assert.ok(codes(validatePlan(createPlan, existsSnap)).includes('CREATE_EXISTS'))
})

test('plannedFiles and create-file targets must agree in both directions', () => {
  const extra = validatePlan(mkPlan(), mkSnapshot({ plannedFiles: ['docs/ghost.md'] }))
  assert.ok(codes(extra).includes('PLANNED_FILES'))
  const createChange = mkChange({ id: 'cn', kind: 'create-file', sectionAnchor: undefined, proposedText: '# N\n\nx' })
  const plan = mkPlan({
    targets: [
      mkTarget({ file: 'docs/new.md', action: 'create', fileBaseHash: null, changes: [createChange] }),
      mkTarget({ file: 'AGENTS.md', changes: [mkChange({ id: 'ca', kind: 'append-section', sectionAnchor: undefined, proposedText: '## Nav\n\n- docs/new.md' })] }),
    ],
  })
  const snap = {
    navigation: { content: 'tree', mode: 'tree' },
    targets: [
      { file: 'docs/new.md', exists: false, fileBaseHash: null, anchors: [], navRegistered: false },
      { file: 'AGENTS.md', exists: true, content: '# AGENTS\n', fileBaseHash: HASH, anchors: collectAtxAnchors('# AGENTS\n'), navRegistered: true },
    ],
    plannedFiles: [],
  }
  assert.ok(codes(validatePlan(plan, snap)).includes('PLANNED_FILES'))
})

test('change closure: docs/arch update needs a ChangeLog row and forbids wholesale replace', () => {
  const archContent = '# Finding\n\n## 变更历史 (ChangeLog)\n\n| 版本 | 日期 |\n|---|---|\n\n## 1. 实体\n\nbody\n'
  const archTarget = mkTarget({ file: 'docs/arch/models/finding.md', changes: [mkChange({ sectionAnchor: '## 1. 实体', proposedText: 'no changelog row here' })] })
  const snap = mkSnapshot({ content: archContent, targets: { file: 'docs/arch/models/finding.md' } })
  const missing = validatePlan(mkPlan({ targets: [archTarget] }), snap)
  assert.ok(codes(missing).includes('CHANGELOG'))
  const row = '| **v9.9** | 2026-11-11 | Test | 已交付 | 新增行 | spec |'
  const withRow = mkPlan({ targets: [mkTarget({ file: 'docs/arch/models/finding.md', changes: [mkChange({ sectionAnchor: '## 1. 实体', proposedText: row })] })] })
  assert.equal(validatePlan(withRow, snap).ok, true)
  const wholesale = mkPlan({ targets: [mkTarget({ file: 'docs/arch/models/finding.md', changes: [mkChange({ kind: 'replace-block', sectionAnchor: '# Finding', proposedText: `${row}\n\nrewritten everything` })] })] })
  assert.ok(codes(validatePlan(wholesale, snap)).includes('ARCH_WHOLESALE'))
})

test('structural: duplicate and missing anchors are errors', () => {
  const dupContent = '# T\n\n## A\n\none\n\n## A\n\ntwo\n'
  const dup = validatePlan(mkPlan(), mkSnapshot({ content: dupContent }))
  assert.ok(codes(dup).includes('ANCHOR_DUPLICATE'))
  const missing = validatePlan(mkPlan({ targets: [mkTarget({ changes: [mkChange({ sectionAnchor: '## Ghost' })] })] }), mkSnapshot())
  assert.ok(codes(missing).includes('ANCHOR_MISSING'))
})

test('structural: unparseable anchors (setext/plain/7 hashes/4 spaces) are errors', () => {
  for (const anchor of ['A', '####### A', '    ## A', 'A\n---']) {
    const result = validatePlan(mkPlan({ targets: [mkTarget({ changes: [mkChange({ sectionAnchor: anchor })] })] }), mkSnapshot())
    assert.ok(codes(result).includes('ANCHOR_PARSE'), anchor)
  }
})

test('structural: fenced pseudo headings are not anchors', () => {
  const content = ['# Title', '', '```', '# Fake', '```', '', '## A', '', 'real', ''].join('\n')
  const result = validatePlan(mkPlan({ targets: [mkTarget({ changes: [mkChange({ sectionAnchor: '# Fake' })] })] }), mkSnapshot({ content }))
  assert.ok(codes(result).includes('ANCHOR_MISSING'))
})

test('structural: stale snapshot anchors are rejected', () => {
  const snap = mkSnapshot()
  snap.targets[0].anchors = [{ text: 'A', level: 2, startLine: 99, endLine: 100 }]
  assert.ok(codes(validatePlan(mkPlan(), snap)).includes('ANCHOR_MISMATCH'))
  const badShape = mkSnapshot()
  badShape.targets[0].anchors = [{ text: 'A', level: 9, startLine: 0, endLine: 1 }]
  assert.ok(codes(validatePlan(mkPlan(), badShape)).includes('ANCHOR_SHAPE'))
})

test('structural: replace-block cannot share a section; parent/child ranges overlap', () => {
  const replaceAndInsert = mkPlan({
    targets: [mkTarget({
      changes: [mkChange({ id: 'c1', kind: 'replace-block', proposedText: 'new body' }), mkChange({ id: 'c2' })],
    })],
  })
  assert.ok(codes(validatePlan(replaceAndInsert, mkSnapshot())).includes('SECTION_CONFLICT'))
  const parentChild = mkPlan({
    targets: [mkTarget({
      changes: [mkChange({ id: 'c1', sectionAnchor: '## A' }), mkChange({ id: 'c2', sectionAnchor: '### A1' })],
    })],
  })
  assert.ok(codes(validatePlan(parentChild, mkSnapshot())).includes('SECTION_OVERLAP'))
  const titleAndChild = mkPlan({
    targets: [mkTarget({
      changes: [mkChange({ id: 'c1', sectionAnchor: '# Title' }), mkChange({ id: 'c2', sectionAnchor: '## B' })],
    })],
  })
  assert.ok(codes(validatePlan(titleAndChild, mkSnapshot())).includes('SECTION_OVERLAP'))
})

test('structural: append anchor must be the last section', () => {
  const notLast = mkPlan({ targets: [mkTarget({ changes: [mkChange({ kind: 'append-section', sectionAnchor: '## A', proposedText: '## C\n\nx' })] })] })
  assert.ok(codes(validatePlan(notLast, mkSnapshot())).includes('APPEND_ANCHOR'))
  const last = mkPlan({ targets: [mkTarget({ changes: [mkChange({ kind: 'append-section', sectionAnchor: '## B', proposedText: '## C\n\nx' })] })] })
  assert.equal(validatePlan(last, mkSnapshot()).ok, true)
})

test('warn rows: unresolved conflicts, test-baseline numbers and cross links', () => {
  const claim = { sessionId: 's1', messageId: 'm1', claim: 'x', evidenceGrade: 'resolved', turn: 1 }
  const plan = mkPlan({
    targets: [mkTarget({ changes: [mkChange({ proposedText: '基线 512 项全绿，见 [指南](guide.md#title) 与 [缺失](missing.md) 和 [坏锚](guide.md#nope)' })] })],
    conflicts: [{ topic: '未决', claims: [claim, { ...claim, sessionId: 's2' }], resolvedBy: 'unresolved' }],
  })
  const result = validatePlan(plan, mkSnapshot())
  assert.equal(result.ok, true)
  const warnCodes = result.checks.filter((c) => c.level === 'warn').map((c) => c.code)
  assert.ok(warnCodes.includes('CONFLICT_UNRESOLVED'))
  assert.ok(warnCodes.includes('TEST_BASELINE'))
  assert.ok(warnCodes.includes('LINK_TARGET'))
  assert.ok(warnCodes.includes('LINK_ANCHOR'))
  assert.equal(result.checks.filter((c) => c.level === 'error').length, 0)
})

test('plan volume: file count and byte caps are errors', () => {
  const targets = []
  const snapTargets = []
  for (let i = 0; i < 11; i++) {
    const file = `docs/f${i}.md`
    targets.push(mkTarget({ file, changes: [mkChange({ id: `c${i}` })] }))
    snapTargets.push({ file, exists: true, content: DOC, fileBaseHash: HASH, anchors: collectAtxAnchors(DOC), navRegistered: true })
  }
  const many = validatePlan(mkPlan({ targets }), { navigation: { content: 'tree', mode: 'tree' }, targets: snapTargets, plannedFiles: [] })
  assert.ok(codes(many).includes('SIZE_FILES'))
  const bigContent = 'x'.repeat(LIMITS.maxTotalBytes)
  const big = validatePlan(
    mkPlan({ targets: [mkTarget({ changes: [mkChange({ kind: 'append-section', sectionAnchor: undefined, proposedText: '## New\n\nok' })] })] }),
    mkSnapshot({ content: bigContent }),
  )
  assert.ok(codes(big).includes('SIZE_BYTES'))
})

// ---------------------------------------------------------------------------
// Dependency second validation & default selection
// ---------------------------------------------------------------------------

test('validateDependencySelection refuses missing deps without auto-adding', () => {
  const plan = mkPlan({ targets: [mkTarget({ changes: [mkChange({ id: 'c1' }), mkChange({ id: 'c2', dependsOn: ['c1'] })] })] })
  const partial = validateDependencySelection(plan, ['c2'])
  assert.equal(partial.ok, false)
  assert.deepEqual(partial.missing, [{ changeId: 'c2', dependsOn: ['c1'] }])
  assert.equal(validateDependencySelection(plan, ['c1', 'c2']).ok, true)
  assert.equal(validateDependencySelection(plan, ['ghost']).ok, false)
})

test('defaultSelection never checks submitted and honors error checks', () => {
  const plan = mkPlan({
    targets: [mkTarget({
      changes: [
        mkChange({ id: 'c1' }),
        mkChange({ id: 'c2', evidence: [{ sessionId: 's', messageId: 'm', grade: 'submitted' }], rationale: '待确认：仅提交' }),
        mkChange({ id: 'c3', evidence: [{ sessionId: 's', messageId: 'm', grade: 'commit', commit: 'abc1234' }] }),
      ],
    })],
  })
  assert.deepEqual(defaultSelection(plan), ['c1', 'c3'])
  assert.deepEqual(defaultSelection(plan, [{ level: 'error', code: 'X', changeId: 'c1', message: 'x' }]), ['c3'])
  assert.deepEqual(defaultSelection(plan, [{ level: 'error', code: 'X', file: 'docs/guide.md', message: 'x' }]), [])
  assert.deepEqual(defaultSelection(plan, [{ level: 'error', code: 'SCHEMA', message: 'x' }]), [])
  assert.deepEqual(defaultSelection(plan, [{ level: 'warn', code: 'TEST_BASELINE', changeId: 'c1', message: 'x' }]), ['c1', 'c3'])
})

// ---------------------------------------------------------------------------
// §8.4 deterministic synthesis
// ---------------------------------------------------------------------------

test('synthesize insert-into-section lands after children, before next sibling', () => {
  const result = synthesizeFileContent({ action: 'update', content: DOC, anchors: collectAtxAnchors(DOC), changes: [mkChange()] })
  assert.equal(result.ok, true)
  assert.equal(result.content, '# Title\n\n## A\n\nalpha\n\n### A1\n\nchild\n\ninserted note\n\n## B\n\nbeta\n')
})

test('synthesize insert into the last section lands at EOF', () => {
  const result = synthesizeFileContent({ action: 'update', content: DOC, anchors: collectAtxAnchors(DOC), changes: [mkChange({ sectionAnchor: '## B', proposedText: 'more beta' })] })
  assert.equal(result.content, '# Title\n\n## A\n\nalpha\n\n### A1\n\nchild\n\n## B\n\nbeta\n\nmore beta\n')
})

test('synthesize same-anchor inserts concatenate in changes order', () => {
  const result = synthesizeFileContent({
    action: 'update', content: DOC, anchors: collectAtxAnchors(DOC),
    changes: [mkChange({ id: 'c1', proposedText: 'first' }), mkChange({ id: 'c2', proposedText: 'second' })],
  })
  assert.equal(result.ok, true)
  assert.match(result.content, /child\n\nfirst\n\nsecond\n\n## B/)
})

test('synthesize appends append at EOF in changes order, anchor optional', () => {
  const result = synthesizeFileContent({
    action: 'update', content: DOC, anchors: collectAtxAnchors(DOC),
    changes: [
      mkChange({ id: 'c1', kind: 'append-section', sectionAnchor: undefined, proposedText: '## C\n\ngamma' }),
      mkChange({ id: 'c2', kind: 'append-section', sectionAnchor: '## B', proposedText: '## D\n\ndelta' }),
    ],
  })
  assert.equal(result.ok, true)
  assert.equal(result.content, `${DOC}\n## C\n\ngamma\n\n## D\n\ndelta\n`)
})

test('synthesize append anchor must be the last section', () => {
  const result = synthesizeFileContent({
    action: 'update', content: DOC, anchors: collectAtxAnchors(DOC),
    changes: [mkChange({ kind: 'append-section', sectionAnchor: '## A', proposedText: '## C\n\nx' })],
  })
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'APPEND_ANCHOR')
})

test('synthesize replace-block keeps the heading and replaces body incl. children', () => {
  const result = synthesizeFileContent({
    action: 'update', content: DOC, anchors: collectAtxAnchors(DOC),
    changes: [mkChange({ kind: 'replace-block', proposedText: 'replaced body' })],
  })
  assert.equal(result.ok, true)
  assert.equal(result.content, '# Title\n\n## A\n\nreplaced body\n\n## B\n\nbeta\n')
})

test('synthesize replace-block plus insert in the same section is refused', () => {
  const result = synthesizeFileContent({
    action: 'update', content: DOC, anchors: collectAtxAnchors(DOC),
    changes: [mkChange({ id: 'c1', kind: 'replace-block', proposedText: 'x' }), mkChange({ id: 'c2' })],
  })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.code === 'SECTION_CONFLICT'))
})

test('synthesize parent/child section overlap is refused', () => {
  const result = synthesizeFileContent({
    action: 'update', content: DOC, anchors: collectAtxAnchors(DOC),
    changes: [mkChange({ id: 'c1', sectionAnchor: '## A' }), mkChange({ id: 'c2', sectionAnchor: '### A1' })],
  })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.code === 'SECTION_OVERLAP'))
})

test('synthesize sibling edits use original-snapshot offsets (golden output)', () => {
  const result = synthesizeFileContent({
    action: 'update', content: DOC, anchors: collectAtxAnchors(DOC),
    changes: [
      mkChange({ id: 'c1', sectionAnchor: '## A', proposedText: 'inserted note' }),
      mkChange({ id: 'c2', kind: 'replace-block', sectionAnchor: '## B', proposedText: 'new beta' }),
    ],
  })
  assert.equal(result.ok, true)
  assert.equal(result.content, '# Title\n\n## A\n\nalpha\n\n### A1\n\nchild\n\ninserted note\n\n## B\n\nnew beta\n')
})

test('synthesize mixed insert-at-EOF and append interleave in changes order', () => {
  const result = synthesizeFileContent({
    action: 'update', content: DOC, anchors: collectAtxAnchors(DOC),
    changes: [
      mkChange({ id: 'c1', kind: 'append-section', sectionAnchor: undefined, proposedText: '## C\n\nappended' }),
      mkChange({ id: 'c2', sectionAnchor: '## B', proposedText: 'inserted at eof' }),
    ],
  })
  assert.equal(result.ok, true)
  assert.match(result.content, /beta\n\n## C\n\nappended\n\ninserted at eof\n$/)
})

test('synthesize anchor matching: closing hashes, trailing space, case sensitivity', () => {
  const content = '# T\n\n## Alpha ##\n\nbody\n'
  const anchors = collectAtxAnchors(content)
  const ok = synthesizeFileContent({ action: 'update', content, anchors, changes: [mkChange({ sectionAnchor: '## Alpha   ', proposedText: 'x' })] })
  assert.equal(ok.ok, true)
  const wrongCase = synthesizeFileContent({ action: 'update', content, anchors, changes: [mkChange({ sectionAnchor: '## alpha', proposedText: 'x' })] })
  assert.equal(wrongCase.ok, false)
  assert.equal(wrongCase.errors[0].code, 'ANCHOR_MISSING')
})

test('synthesize duplicate and missing anchors are refused', () => {
  const dupContent = '# T\n\n## A\n\none\n\n## A\n\ntwo\n'
  const dup = synthesizeFileContent({ action: 'update', content: dupContent, anchors: collectAtxAnchors(dupContent), changes: [mkChange()] })
  assert.equal(dup.ok, false)
  assert.equal(dup.errors[0].code, 'ANCHOR_DUPLICATE')
  const missing = synthesizeFileContent({ action: 'update', content: DOC, anchors: collectAtxAnchors(DOC), changes: [mkChange({ sectionAnchor: '## Ghost' })] })
  assert.equal(missing.errors[0].code, 'ANCHOR_MISSING')
})

test('synthesize refuses fenced pseudo headings as anchors', () => {
  const content = ['# Title', '', '```md', '# Fake', '```', '', '## A', '', 'real', ''].join('\n')
  const result = synthesizeFileContent({ action: 'update', content, anchors: collectAtxAnchors(content), changes: [mkChange({ sectionAnchor: '# Fake' })] })
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'ANCHOR_MISSING')
})

test('synthesize normalizes CRLF and BOM in content and fragments', () => {
  const crlf = `\uFEFF${DOC.replace(/\n/g, '\r\n')}`
  const result = synthesizeFileContent({
    action: 'update', content: crlf, anchors: collectAtxAnchors(crlf),
    changes: [mkChange({ proposedText: 'inserted\r\nnote\r\n' })],
  })
  assert.equal(result.ok, true)
  assert.ok(!result.content.includes('\r'))
  assert.ok(!result.content.includes('\uFEFF'))
  assert.match(result.content, /child\n\ninserted\nnote\n\n## B/)
})

test('synthesize create-file produces the full normalized content', () => {
  const change = mkChange({ kind: 'create-file', sectionAnchor: undefined, proposedText: '\uFEFF# New\r\n\r\nbody\r\n' })
  const result = synthesizeFileContent({ action: 'create', changes: [change] })
  assert.equal(result.ok, true)
  assert.equal(result.content, '# New\n\nbody\n')
})

test('synthesize create-file refuses empty, non-ATX and multi-change inputs', () => {
  const empty = synthesizeFileContent({ action: 'create', changes: [mkChange({ kind: 'create-file', sectionAnchor: undefined, proposedText: '  \n\n' })] })
  assert.equal(empty.ok, false)
  assert.equal(empty.errors[0].code, 'EMPTY_TEXT')
  const plain = synthesizeFileContent({ action: 'create', changes: [mkChange({ kind: 'create-file', sectionAnchor: undefined, proposedText: 'no heading' })] })
  assert.equal(plain.ok, false)
  const two = synthesizeFileContent({ action: 'create', changes: [mkChange({ kind: 'create-file', sectionAnchor: undefined, proposedText: '# A\n' }), mkChange({ id: 'c2', kind: 'create-file', sectionAnchor: undefined, proposedText: '# B\n' })] })
  assert.equal(two.ok, false)
  assert.equal(two.errors[0].code, 'CREATE_SHAPE')
})

test('synthesize refuses empty fragments and oversized results', () => {
  const blank = synthesizeFileContent({ action: 'update', content: DOC, anchors: collectAtxAnchors(DOC), changes: [mkChange({ proposedText: '\n \n' })] })
  assert.equal(blank.ok, false)
  assert.equal(blank.errors[0].code, 'EMPTY_TEXT')
  const huge = synthesizeFileContent({ action: 'create', changes: [mkChange({ kind: 'create-file', sectionAnchor: undefined, proposedText: `# Big\n\n${'x'.repeat(LIMITS.maxTotalBytes)}` })] })
  assert.equal(huge.ok, false)
  assert.equal(huge.errors[0].code, 'SIZE')
})

test('synthesize update requires content and refuses missing snapshot', () => {
  const result = synthesizeFileContent({ action: 'update', content: undefined, anchors: [], changes: [mkChange()] })
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'SNAPSHOT_INCOMPLETE')
})

test('synthesize appends to an empty file', () => {
  const result = synthesizeFileContent({
    action: 'update', content: '', anchors: [],
    changes: [mkChange({ kind: 'append-section', sectionAnchor: undefined, proposedText: '## C\n\ngamma' })],
  })
  assert.equal(result.ok, true)
  assert.equal(result.content, '## C\n\ngamma\n')
})

test('synthesize is deterministic and idempotent across repeated runs', () => {
  const input = { action: 'update', content: DOC, anchors: collectAtxAnchors(DOC), changes: [mkChange()] }
  const a = synthesizeFileContent(input)
  const b = synthesizeFileContent(input)
  assert.equal(a.content, b.content)
})

// ---------------------------------------------------------------------------
// §12 fingerprint normalization & equivalence
// ---------------------------------------------------------------------------

test('normalizeForFingerprint applies NFC, LF, trailing-strip and blank folding', () => {
  assert.equal(normalizeForFingerprint('e\u0301'), normalizeForFingerprint('é'))
  assert.equal(normalizeForFingerprint('a\r\nb\rc'), 'a\nb\nc')
  assert.equal(normalizeForFingerprint('a  \nb\t'), 'a\nb')
  assert.equal(normalizeForFingerprint('a\n\n\n\nb'), 'a\n\nb')
  assert.equal(normalizeForFingerprint('a\n\n\nb'), 'a\n\n\nb')
  assert.equal(normalizeForFingerprint('a\n\nb'), 'a\n\nb')
})

test('normalizeForFingerprint keeps heading levels and is idempotent', () => {
  assert.equal(normalizeForFingerprint('##  Foo  '), '##  Foo')
  assert.equal(normalizeForFingerprint('### Bar'), '### Bar')
  const sample = '\uFEFF# T\r\n\r\n\r\n\r\n##  A  \r\nx\t\r\n'
  const once = normalizeForFingerprint(sample)
  assert.equal(normalizeForFingerprint(once), once)
})

test('isEquivalentContent compares final contents modulo normalization', () => {
  assert.equal(isEquivalentContent('\uFEFFa\r\n\r\n\r\n\r\nb  \n', 'a\n\nb\n'), true)
  assert.equal(isEquivalentContent('a\n', 'a'), false)
  assert.equal(isEquivalentContent('e\u0301\n', 'é\n'), true)
  assert.equal(isEquivalentContent('a\n', 'b\n'), false)
  const final = synthesizeFileContent({ action: 'update', content: DOC, anchors: collectAtxAnchors(DOC), changes: [mkChange()] }).content
  assert.equal(isEquivalentContent(final, final.replace(/\n/g, '\r\n')), true)
  assert.equal(isEquivalentContent(final, DOC), false)
})

test('computeFingerprint is stable across equivalent variants and anchor forms', () => {
  const base = { targetFile: 'docs/guide.md', sectionAnchor: '## A', proposedText: 'note\r\n' }
  const hash = computeFingerprint(base)
  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.equal(computeFingerprint({ ...base, proposedText: 'note\n' }), hash)
  assert.equal(computeFingerprint({ ...base, sectionAnchor: '## A ##' }), hash)
  assert.equal(computeFingerprint({ ...base, sectionAnchor: '  ## A   ' }), hash)
  assert.notEqual(computeFingerprint({ ...base, targetFile: 'docs/other.md' }), hash)
  assert.notEqual(computeFingerprint({ ...base, proposedText: 'different' }), hash)
  const noAnchor = computeFingerprint({ targetFile: 'docs/guide.md', proposedText: '## C\n\nx' })
  assert.equal(computeFingerprint({ targetFile: 'docs/guide.md', sectionAnchor: '', proposedText: '## C\n\nx' }), noAnchor)
  assert.equal(fingerprintInput({ targetFile: 'f.md', sectionAnchor: undefined, proposedText: 'x' }), JSON.stringify(['f.md', '', 'x']))
})

test('normalizeNewlines strips BOM and unifies CR/LF idempotently', () => {
  assert.equal(normalizeNewlines('\uFEFFa\r\nb\rc'), 'a\nb\nc')
  assert.equal(normalizeNewlines('a\nb'), 'a\nb')
  assert.equal(normalizeNewlines(null), '')
})

test('changeGrade picks the highest positive evidence grade', () => {
  assert.equal(changeGrade(mkChange()), 'resolved')
  assert.equal(changeGrade(mkChange({ evidence: [{ grade: 'submitted' }, { grade: 'commit', commit: 'x' }] })), 'commit')
  assert.equal(changeGrade(mkChange({ evidence: [{ grade: 'dismissed' }] })), null)
  assert.equal(changeGrade(null), null)
})

test('exports expose the contract enums and limits', () => {
  assert.deepEqual(CHANGE_KINDS, ['append-section', 'insert-into-section', 'replace-block', 'create-file'])
  assert.equal(LIMITS.maxFiles, 10)
  assert.equal(LIMITS.maxTotalBytes, 500 * 1024)
  assert.equal(PLAN_SCHEMA_VERSION, 1)
})