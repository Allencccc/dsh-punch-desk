/**
 * Agent C — confirmation/result page UX rework.
 *
 * Covers the user-facing contract of src/client/ui/distill-confirm.js:
 *   - three-bucket ledger (applied / review / conflict), no separate "ignored"
 *     bucket: not-adopted is a light marker with a restore entry;
 *   - blocked-by-validation badge (real reason on the tooltip) plus the
 *     "only pending" filter;
 *   - optimistic distill-review write-back with rollback on failure;
 *   - human-readable evidence (no bare sessionId / commit hash);
 *   - baseline drift: CAS failure → conflict bucket → rebase preview →
 *     apply:true swaps in the refreshed plan;
 *   - applied page keeps read-back / backup / fingerprint info and adds the
 *     write-back stats block.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createDistillConfirm } from '../src/client/ui/distill-confirm.js'
import { dictionaries } from '../src/locale.js'

const zh = dictionaries().zh
const t = (key) => zh[key] ?? key

const h = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: children.flat(Infinity),
})

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return (node.children ?? []).map(textOf).join(' ')
}

function collectNodes(node, out = []) {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) collectNodes(child, out)
  return out
}

function findButtonByText(tree, fragment) {
  return collectNodes(tree).find(
    (node) => node.type === 'button' && textOf(node).includes(fragment),
  )
}

function findRow(tree, changeId) {
  return collectNodes(tree).find(
    (node) => node.type === 'div' && node.props?.['data-change-id'] === changeId,
  )
}

function findButtonInRow(row, fragment) {
  if (!row) return undefined
  return collectNodes(row).find(
    (node) => node.type === 'button' && textOf(node).includes(fragment),
  )
}

function findCheckboxInRow(row) {
  if (!row) return undefined
  return collectNodes(row).find(
    (node) => node.type === 'input' && node.props?.type === 'checkbox',
  )
}

function findBucket(tree, name) {
  return collectNodes(tree).find(
    (node) => node.type === 'div' && node.props?.['data-bucket'] === name,
  )
}

function findMarker(row, marker) {
  if (!row) return undefined
  return collectNodes(row).find(
    (node) => node.props?.['data-marker'] === marker,
  )
}

/**
 * Minimal hook runtime: index-based state/ref slots, same contract as
 * tests/distill-view.test.js. DistillConfirm currently only uses useState and
 * useRef, but the runtime stays effect-compatible.
 */
function createHookRuntime() {
  const states = new Map()
  const refs = new Map()
  let hookCursor = 0

  const React = {
    useState(initial) {
      const index = hookCursor++
      if (!states.has(index)) states.set(index, typeof initial === 'function' ? initial() : initial)
      const set = (value) => states.set(index, typeof value === 'function' ? value(states.get(index)) : value)
      return [states.get(index), set]
    },
    useRef(initial) {
      const index = hookCursor++
      if (!refs.has(index)) refs.set(index, { current: initial })
      return refs.get(index)
    },
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
    useEffect() {},
  }

  function expandVNode(node) {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(expandVNode)
    if (typeof node.type === 'function') {
      const p = { ...(node.props || {}) }
      if (node.children?.length) p.children = node.children.length === 1 ? node.children[0] : node.children
      return expandVNode(node.type(p))
    }
    return {
      ...node,
      children: (node.children || []).map(expandVNode),
    }
  }

  return {
    React,
    render(Component, props) {
      hookCursor = 0
      return expandVNode(Component(props))
    },
  }
}

/** fetch stub with per-route handlers; records every call. */
function stubFetch(handlers) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const call = {
      url: String(url),
      method: options.method || 'GET',
      body: typeof options.body === 'string' ? JSON.parse(options.body) : (options.body ?? null),
    }
    calls.push(call)
    const route = Object.keys(handlers).find((key) => call.url.includes(key))
    const payload = typeof handlers[route] === 'function'
      ? await handlers[route](call)
      : (handlers[route] ?? { ok: true })
    const ok = payload && payload.ok !== false && payload.__httpOk !== false
    return { ok, status: ok ? 200 : 409, json: async () => payload }
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** Let the optimistic review promise settle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const FILE = 'docs/arch/models/finding.md'

const RUN = {
  id: 'run-1',
  workspaceId: 'ws-1',
  status: 'ready',
  summaries: [
    { sessionId: 'sess-alpha', title: '队列对账决议', markdown: '', source: 'llm' },
  ],
}

const PLAN = {
  schemaVersion: 1,
  runId: 'run-1',
  workspaceId: 'ws-1',
  summary: '沉淀了队列对账与组徽章同源两条决议。',
  navigation: { source: 'AGENTS.md#0', mode: 'tree', fallback: false },
  targets: [
    {
      file: FILE,
      action: 'update',
      navRef: 'AGENTS.md > docs/arch/models/',
      fileBaseHash: 'a'.repeat(64),
      changes: [
        {
          id: 'c1',
          kind: 'insert-into-section',
          sectionAnchor: '## 4. Commit 归属与 Fork 派生',
          proposedText: '插入的规则正文',
          rationale: '原始理由一',
          evidenceSnippet: '证据片段一（结果对节选）',
          evidence: [{ sessionId: 'sess-alpha', messageId: 'msg-1', turn: 12, grade: 'resolved' }],
          dependsOn: [],
        },
        {
          id: 'c2',
          kind: 'append-section',
          proposedText: '# 新章节\n正文',
          rationale: '原始理由二',
          evidenceSnippet: '证据片段二',
          evidence: [{ sessionId: 'sess-beta', messageId: 'msg-2', turn: 8, grade: 'commit', commit: 'deadbeef' }],
          dependsOn: [],
        },
      ],
    },
  ],
  conflicts: [
    {
      topic: '冲突主题甲',
      claims: [{ sessionId: 'sess-alpha', messageId: 'msg-1', claim: '甲说法', evidenceGrade: 'resolved', turn: 12 }],
      resolvedBy: 'unresolved',
      note: '',
    },
    {
      topic: '冲突主题乙',
      claims: [{ sessionId: 'sess-beta', messageId: 'msg-2', claim: '乙说法', evidenceGrade: 'commit', turn: 8 }],
      resolvedBy: 'code',
      codeEvidence: [{ commit: 'deadbeef', committedAt: 100, path: 'docs/arch/models/finding.md' }],
      note: '以提交时间裁决',
    },
  ],
  stats: { targets: 1, changes: 2, byGrade: { resolved: 1, commit: 1, submitted: 0 } },
  truncated: false,
}

function makeComponent() {
  const runtime = createHookRuntime()
  const DistillConfirm = createDistillConfirm({ h, React: runtime.React, services: {}, t })
  return { runtime, DistillConfirm }
}

// ------------------------------------------------------- three-bucket ledger

test('ledger: ready plan renders review + conflict buckets and human-readable evidence', () => {
  const { runtime, DistillConfirm } = makeComponent()
  const tree = runtime.render(DistillConfirm, {
    run: RUN,
    plan: PLAN,
    workspaceId: 'ws-1',
    sessionTitles: { 'sess-beta': '组徽章同源' },
  })

  const text = textOf(tree)
  // Review bucket (heading + one-line hint) and the conflict bucket.
  assert.ok(text.includes(t('distill.confirm.bucket.review')), 'review bucket heading renders')
  assert.ok(text.includes(t('distill.confirm.bucket.reviewHint')), 'review bucket hint renders')
  assert.ok(text.includes(t('distill.confirm.bucket.conflict')), 'conflict bucket heading renders')
  assert.ok(text.includes(t('distill.confirm.bucket.conflictHint')), 'conflict bucket hint renders')
  // There is no fourth "ignored" bucket.
  assert.equal(findBucket(tree, 'applied'), undefined, 'nothing is written back before an apply')
  assert.equal(findBucket(tree, 'ignored'), undefined, 'not-adopted is a marker, never a bucket')

  // Evidence: title comes from run.summaries for one session, from the props map
  // for the other — never the raw session id / message id / commit hash.
  assert.ok(text.includes('队列对账决议 · 第 12 轮'), 'summary title + turn render for evidence')
  assert.ok(text.includes('组徽章同源 · 第 8 轮'), 'prop title map + turn render for evidence')
  for (const forbidden of ['sess-alpha', 'sess-beta', 'msg-1', 'msg-2', 'deadbeef']) {
    assert.ok(!text.includes(forbidden), `raw identifier must not render: ${forbidden}`)
  }
  // Unresolved claims live in the conflict bucket, human readable.
  const conflictBucket = findBucket(tree, 'conflict')
  assert.ok(textOf(conflictBucket).includes('甲说法'), 'unresolved conflict claim text renders')
  assert.ok(
    textOf(conflictBucket).includes(t('distill.confirm.conflict.unresolved')),
    'unresolved adjudication badge renders in the conflict bucket',
  )

  // Already adjudicated conflicts are context, not pending work: they stay
  // visible (and readable) but never sit in the "conflicts to resolve" bucket.
  const adjudicated = collectNodes(tree).find(
    (node) => node.type === 'div' && node.props?.['data-conflicts'] === 'adjudicated',
  )
  assert.ok(adjudicated, 'adjudicated conflicts get their own read-only note')
  assert.ok(textOf(adjudicated).includes('冲突主题乙'), 'adjudicated conflict topic renders')
  assert.ok(textOf(adjudicated).includes(t('distill.confirm.conflict.code')), 'code adjudication badge renders')
  assert.ok(!textOf(conflictBucket).includes('冲突主题乙'), 'adjudicated conflict is not in the conflict bucket')
})

test('evidence: missing title degrades to turn, then to the session-level fallback', () => {
  const { runtime, DistillConfirm } = makeComponent()
  const plan = {
    schemaVersion: 1,
    runId: 'run-1',
    workspaceId: 'ws-1',
    summary: '证据降级。',
    navigation: { source: 'AGENTS.md#0', mode: 'tree', fallback: false },
    targets: [{
      file: FILE,
      action: 'update',
      fileBaseHash: 'a'.repeat(64),
      changes: [
        {
          id: 'c1',
          kind: 'append-section',
          proposedText: '# 甲\n正文',
          rationale: '理由甲',
          evidenceSnippet: '',
          evidence: [{ sessionId: 'unknown-session-1', messageId: 'm1', turn: 3, grade: 'resolved' }],
          dependsOn: [],
        },
        {
          id: 'c2',
          kind: 'append-section',
          proposedText: '# 乙\n正文',
          rationale: '理由乙',
          evidenceSnippet: '',
          evidence: [{ sessionId: 'unknown-session-2', messageId: 'm2', grade: 'resolved' }],
          dependsOn: [],
        },
      ],
    }],
    conflicts: [],
    stats: { targets: 1, changes: 2, byGrade: { resolved: 2, commit: 0, submitted: 0 } },
    truncated: false,
  }
  const tree = runtime.render(DistillConfirm, { run: { id: 'run-1', status: 'ready' }, plan })
  const text = textOf(tree)
  assert.ok(text.includes('第 3 轮'), 'turn-only evidence renders the turn template')
  assert.ok(text.includes(t('distill.confirm.evidence.noTurn')), 'turn-less evidence uses the fallback copy')
  assert.ok(!text.includes('unknown-session-1'), 'no bare session id')
  assert.ok(!text.includes('unknown-session-2'), 'no bare session id')
})

// -------------------------------------------- blocked marker + pending filter

test('markers: blocked badge carries the real reason and cannot be selected; filter hides accepted rows', () => {
  const { runtime, DistillConfirm } = makeComponent()
  const checks = [{
    level: 'error',
    code: 'ANCHOR_MISSING',
    message: '目标锚点在磁盘上不存在',
    file: FILE,
    changeId: 'c1',
  }]
  const props = { run: RUN, plan: PLAN, workspaceId: 'ws-1', checks }

  let tree = runtime.render(DistillConfirm, props)
  const c1 = findRow(tree, 'c1')
  const blockedMarker = findMarker(c1, 'blocked')
  assert.ok(blockedMarker, 'blocked marker badge renders')
  assert.ok(textOf(blockedMarker).includes(t('distill.confirm.marker.blocked')), 'blocked badge label renders')
  const tipNode = collectNodes(c1).find(
    (node) => String(node.props?.['data-pd-tip'] || '').includes('目标锚点在磁盘上不存在'),
  )
  assert.ok(tipNode, 'blocked tooltip carries the real validation reason')
  const c1Checkbox = findCheckboxInRow(c1)
  assert.equal(c1Checkbox.props.checked, false, 'blocked change is not checked by default')
  assert.equal(c1Checkbox.props.disabled, true, 'blocked change cannot be selected / applied')

  // c2 is accepted by default (commit grade), c1 stays pending because blocked.
  assert.equal(findCheckboxInRow(findRow(tree, 'c2')).props.checked, true, 'c2 is accepted by default')

  findButtonByText(tree, t('distill.confirm.filter.onlyPending')).props.onClick()
  tree = runtime.render(DistillConfirm, props)
  assert.equal(findRow(tree, 'c2'), undefined, 'only-pending hides the already-accepted row')
  assert.ok(findRow(tree, 'c1'), 'only-pending keeps the still-pending row')
})

// --------------------------------------- optimistic distill-review write-back

test('review write: ignore marker posts distill-review, restore re-adopts, failure rolls back', async () => {
  const fetchStub = stubFetch({
    'distill-review': {
      ok: true,
      review: { ignoredChangeIds: ['c2'], reviewedChangeIds: ['c2'], at: 1 },
    },
  })
  const { runtime, DistillConfirm } = makeComponent()
  const props = { run: RUN, plan: PLAN, workspaceId: 'ws-1' }
  try {
    let tree = runtime.render(DistillConfirm, props)
    findButtonInRow(findRow(tree, 'c2'), t('distill.confirm.ignoreAction')).props.onClick()
    await tick()
    tree = runtime.render(DistillConfirm, props)

    const first = fetchStub.calls.find((call) => call.url.includes('distill-review'))
    assert.ok(first, 'distill-review POST is issued')
    assert.equal(first.url, 'api/punch-desk/distill-review')
    assert.deepEqual(first.body.ignoredChangeIds, ['c2'], 'ignored id is persisted')
    assert.deepEqual(first.body.reviewedChangeIds, ['c2'], 'the decision is also recorded as reviewed')

    const ignoredRow = findRow(tree, 'c2')
    assert.ok(findMarker(ignoredRow, 'ignored'), 'not-adopted marker renders on the row')
    assert.equal(findCheckboxInRow(ignoredRow).props.disabled, true, 'ignored change is not selectable')
    assert.equal(findCheckboxInRow(ignoredRow).props.checked, false, 'ignored change is unselected')
    // Still inside the review bucket, not in a fourth bucket.
    assert.ok(findBucket(tree, 'review'))

    findButtonInRow(ignoredRow, t('distill.confirm.undoIgnore')).props.onClick()
    await tick()
    tree = runtime.render(DistillConfirm, props)
    const restoreCall = fetchStub.calls.filter((call) => call.url.includes('distill-review')).at(-1)
    assert.deepEqual(restoreCall.body.ignoredChangeIds, [], 'restore clears the ignored id')
    const restored = findRow(tree, 'c2')
    assert.equal(findMarker(restored, 'ignored'), undefined, 'marker disappears after restore')
    assert.equal(findCheckboxInRow(restored).props.checked, true, 'restore brings the pre-ignore selection back')
  } finally {
    fetchStub.restore()
  }

  // Failure: the optimistic marker rolls back and the error is surfaced.
  const failing = stubFetch({
    'distill-review': { ok: false, error: { code: 'REVIEW_NOT_ALLOWED', message: 'run is not ready' } },
  })
  const second = makeComponent()
  try {
    let tree = second.runtime.render(second.DistillConfirm, props)
    findButtonInRow(findRow(tree, 'c1'), t('distill.confirm.ignoreAction')).props.onClick()
    await tick()
    tree = second.runtime.render(second.DistillConfirm, props)
    assert.equal(findMarker(findRow(tree, 'c1'), 'ignored'), undefined, 'failed write rolls the marker back')
    assert.equal(findCheckboxInRow(findRow(tree, 'c1')).props.checked, true, 'failed write restores the selection')
    const alert = collectNodes(tree).find((node) => node.props?.role === 'alert')
    assert.ok(alert, 'review error banner renders')
    assert.ok(
      textOf(alert).includes(t('distill.view.error.code.REVIEW_NOT_ALLOWED')),
      'review error is localized',
    )
  } finally {
    failing.restore()
  }
})

// -------------------------------------------------- drift → rebase (option A)

test('drift: CAS failure lands in the conflict bucket, preview then re-anchor swaps the plan', async () => {
  const UPDATE_PLAN = {
    ...PLAN,
    summary: '重新对齐后的方案摘要。',
    targets: [{
      file: FILE,
      action: 'update',
      fileBaseHash: 'd'.repeat(64),
      changes: [{
        id: 'c9',
        kind: 'append-section',
        proposedText: '# 对齐后的章节\n正文',
        rationale: '对齐后的理由',
        evidenceSnippet: '',
        evidence: [{ sessionId: 'sess-alpha', messageId: 'msg-9', turn: 12, grade: 'resolved' }],
        dependsOn: [],
      }],
    }],
    stats: { targets: 1, changes: 1, byGrade: { resolved: 1, commit: 0, submitted: 0 } },
  }
  const fetchStub = stubFetch({
    'distill-apply': {
      ok: false,
      code: 'CAS_CONFLICT',
      error: 'baseline hash mismatch',
      file: FILE,
      expected: 'e'.repeat(64),
      actual: 'd'.repeat(64),
    },
    'distill-rebase': (call) => (call.body.apply === false
      ? {
        ok: true,
        rebase: {
          filePath: FILE,
          planHash: 'a'.repeat(64),
          currentHash: 'd'.repeat(64),
          canReanchor: true,
          alreadyApplied: [],
          previews: [{
            changeId: 'c1',
            anchor: '## 4. Commit 归属与 Fork 派生',
            proposedText: '计划里的新正文',
            currentText: '当前磁盘上的正文',
          }],
        },
      }
      : { ok: true, plan: UPDATE_PLAN }),
  })
  const { runtime, DistillConfirm } = makeComponent()
  const props = { run: RUN, plan: PLAN, workspaceId: 'ws-1' }
  try {
    let tree = runtime.render(DistillConfirm, props)
    findButtonByText(tree, t('distill.confirm.applyButton')).props.onClick()
    tree = runtime.render(DistillConfirm, props)
    await findButtonByText(tree, t('distill.confirm.confirmYes')).props.onClick()
    tree = runtime.render(DistillConfirm, props)

    const alert = collectNodes(tree).find((node) => node.props?.role === 'alert')
    assert.ok(alert, 'apply error banner renders')
    // The old hash-only detail is replaced by the readable drift entry.
    assert.ok(!textOf(tree).includes('eeeeeee'), 'plan baseline hash is not rendered')
    assert.ok(!textOf(tree).includes('ddddddd'), 'disk hash is not rendered')

    const conflictBucket = findBucket(tree, 'conflict')
    assert.ok(conflictBucket, 'conflict bucket renders after the CAS failure')
    const driftCard = collectNodes(tree).find(
      (node) => node.type === 'div' && node.props?.['data-drift-file'] === FILE,
    )
    assert.ok(driftCard, 'drifted file gets a conflict-bucket card')
    assert.ok(textOf(driftCard).includes(FILE), 'drift card names the file')
    assert.ok(textOf(driftCard).includes(t('distill.confirm.drift.heading')), 'drift heading renders')
    assert.ok(
      textOf(driftCard).includes(t('distill.confirm.drift.body').replace('{file}', FILE)),
      'drift body names the file',
    )

    // Step 1: preview (apply:false) — read-only comparison, no write.
    findButtonByText(tree, t('distill.confirm.drift.rebaseAction')).props.onClick()
    await tick()
    tree = runtime.render(DistillConfirm, props)
    const previewCall = fetchStub.calls.find(
      (call) => call.url.includes('distill-rebase') && call.body.apply === false,
    )
    assert.ok(previewCall, 'rebase preview POST is issued')
    assert.equal(previewCall.body.filePath, FILE)
    assert.equal(previewCall.body.runId, 'run-1')
    const preview = collectNodes(tree).find(
      (node) => node.type === 'div' && node.props?.['data-rebase-preview'] === FILE,
    )
    assert.ok(preview, 'preview block renders')
    const previewText = textOf(preview)
    assert.ok(previewText.includes('## 4. Commit 归属与 Fork 派生'), 'anchor renders')
    assert.ok(previewText.includes('计划里的新正文'), 'proposed text renders')
    assert.ok(previewText.includes('当前磁盘上的正文'), 'current disk text renders')
    assert.ok(previewText.includes(t('distill.confirm.error.expected')), 'plan-side label renders')
    assert.ok(previewText.includes(t('distill.confirm.error.actual')), 'disk-side label renders')
    assert.ok(previewText.includes(t('distill.confirm.drift.rebaseHint')), 'rebase hint renders')

    // Step 2: confirm — apply:true, swap in the refreshed plan.
    findButtonByText(tree, t('distill.confirm.drift.rebaseAction')).props.onClick()
    await tick()
    tree = runtime.render(DistillConfirm, props)
    const applyCall = fetchStub.calls.find(
      (call) => call.url.includes('distill-rebase') && call.body.apply === true,
    )
    assert.ok(applyCall, 'rebase apply POST is issued')
    assert.equal(applyCall.body.filePath, FILE)
    assert.equal(
      collectNodes(tree).find((node) => node.props?.['data-drift-file'] === FILE),
      undefined,
      'resolved drift card is cleared',
    )
    assert.ok(textOf(tree).includes('重新对齐后的方案摘要。'), 'returned plan becomes the local plan')
    assert.ok(findRow(tree, 'c9'), 're-anchored change is back in the review bucket')
    assert.ok(findRow(tree, 'c9'), 're-anchored change is reviewable')
    assert.equal(collectNodes(tree).find((node) => node.props?.role === 'alert'), undefined,
      'the CAS error banner clears after a successful re-anchor')
  } finally {
    fetchStub.restore()
  }
})

// ------------------------------------------------- applied page + statistics

test('applied: written-back bucket keeps audit info and adds the write-back stats block', async () => {
  const fetchStub = stubFetch({
    'distill-apply': {
      ok: true,
      applied: [{
        file: FILE,
        action: 'update',
        newHash: 'f'.repeat(64),
        backupPath: '~/.dsh/storages/punch_desk/backups/finding-md/1234-file',
      }],
      skipped: [],
      readBackOk: true,
      fingerprints: ['fp-1', 'fp-2'],
      runStatus: 'applied',
    },
  })
  const { runtime, DistillConfirm } = makeComponent()
  const props = { run: RUN, plan: PLAN, workspaceId: 'ws-1' }
  try {
    let tree = runtime.render(DistillConfirm, props)
    findButtonByText(tree, t('distill.confirm.applyButton')).props.onClick()
    tree = runtime.render(DistillConfirm, props)
    await findButtonByText(tree, t('distill.confirm.confirmYes')).props.onClick()
    tree = runtime.render(DistillConfirm, props)

    assert.ok(textOf(tree).includes(t('distill.confirm.applied.heading')), 'applied page heading renders')
    const appliedBucket = findBucket(tree, 'applied')
    assert.ok(appliedBucket, 'applied bucket renders')
    const appliedText = textOf(appliedBucket)
    assert.ok(appliedText.includes(t('distill.confirm.bucket.applied')), 'written-back bucket heading renders')
    assert.ok(appliedText.includes(t('distill.confirm.bucket.appliedHint')), 'written-back hint renders')
    // Existing audit information survives.
    assert.ok(textOf(tree).includes(t('distill.confirm.applied.readBackOk')), 'read-back badge renders')
    assert.ok(textOf(tree).includes(t('distill.confirm.applied.fingerprints').replace('{count}', '2')),
      'fingerprint count renders')
    assert.ok(appliedText.includes('~/.dsh/storages/punch_desk/backups/finding-md/1234-file'), 'backup path renders')
    assert.ok(appliedText.includes('ffffff'), 'new content hash stays available for audit')
    // Original text + rationale stay readable, and nothing is editable anymore.
    assert.ok(appliedText.includes('插入的规则正文'), 'proposed text is kept for audit')
    assert.ok(appliedText.includes('原始理由一'), 'rationale is kept for audit')
    assert.equal(collectNodes(appliedBucket).find((node) => node.type === 'textarea'), undefined,
      'written-back entries are not editable')
    assert.equal(collectNodes(appliedBucket).find((node) => node.props?.type === 'checkbox'), undefined,
      'written-back entries cannot be re-selected')

    const statsBlock = collectNodes(tree).find(
      (node) => node.type === 'div' && node.props?.['data-stats'] === 'applied',
    )
    assert.ok(statsBlock, 'write-back stats block renders')
    const statsText = textOf(statsBlock)
    assert.ok(statsText.includes(t('distill.confirm.stats.heading')), 'stats heading renders')
    assert.ok(statsText.includes(t('distill.confirm.stats.files').replace('{count}', '1')),
      'written file count renders')
    assert.ok(statsText.includes(t('distill.confirm.stats.changes').replace('{count}', '2')),
      'written change count renders')
    assert.match(statsText, /用时 \d+:\d\d/, 'duration renders as m:ss')
    assert.ok(statsText.includes('未采纳 0 条'), 'not-adopted count renders in the stats buckets line')
    assert.ok(statsText.includes('冲突 1 条'), 'conflict count renders in the stats buckets line')
  } finally {
    fetchStub.restore()
  }
})

// -------------------------------------- re-anchored plan: already-present skip

test('already-present: a re-anchored equivalent change reads as written back and cannot be re-selected', () => {
  const plan = {
    ...PLAN,
    targets: [{
      ...PLAN.targets[0],
      changes: [{ ...PLAN.targets[0].changes[0], id: 'cA', skipReason: 'already-present' }],
    }],
    stats: { targets: 1, changes: 1, byGrade: { resolved: 1, commit: 0, submitted: 0 } },
  }
  const { runtime, DistillConfirm } = makeComponent()
  const props = { run: { id: 'run-1', status: 'ready' }, plan }

  let tree = runtime.render(DistillConfirm, props)
  const row = findRow(tree, 'cA')
  assert.ok(textOf(row).includes(t('distill.confirm.applied.skipped')),
    'equivalent content is labelled as already present')
  const checkbox = findCheckboxInRow(row)
  assert.equal(checkbox.props.checked, false, 'already-present content is never checked again')
  assert.equal(checkbox.props.disabled, true, 'already-present content is not selectable')
  const apply = findButtonByText(tree, t('distill.confirm.applyButton'))
  assert.equal(apply.props.disabled, true, 'nothing writable left means the apply is empty')

  findButtonByText(tree, t('distill.confirm.filter.onlyPending')).props.onClick()
  tree = runtime.render(DistillConfirm, props)
  assert.equal(findRow(tree, 'cA'), undefined, 'the pending filter hides already-written content')
})

test('applied: a captured payload passed back down rebuilds the ledger without another POST', () => {
  const { runtime, DistillConfirm } = makeComponent()
  const applied = {
    ok: true,
    applied: [{
      file: FILE,
      action: 'update',
      newHash: 'f'.repeat(64),
      backupPath: '~/.dsh/storages/punch_desk/backups/finding-md/1234-file',
    }],
    skipped: [],
    readBackOk: true,
    fingerprints: ['fp-1'],
    runStatus: 'applied',
  }
  const run = { id: 'run-1', status: 'applied', createdAt: 1000, appliedAt: 61000 }
  const tree = runtime.render(DistillConfirm, { run, plan: PLAN, applied })

  assert.ok(findBucket(tree, 'applied'), 'applied bucket renders from the captured payload')
  const statsBlock = collectNodes(tree).find(
    (node) => node.type === 'div' && node.props?.['data-stats'] === 'applied',
  )
  assert.ok(statsBlock, 'stats block renders')
  const statsText = textOf(statsBlock)
  assert.ok(statsText.includes(t('distill.confirm.stats.files').replace('{count}', '1')), 'file count renders')
  assert.ok(statsText.includes(t('distill.confirm.stats.changes').replace('{count}', '2')),
    'change count is rebuilt from the written files')
  assert.ok(statsText.includes('1:00'), 'duration is derived from the run timestamps')
  assert.equal(findButtonByText(tree, t('distill.confirm.applyButton')), undefined,
    'the writable apply bar is gone once the payload is applied')
})
