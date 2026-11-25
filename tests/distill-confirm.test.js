import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createDistillConfirm } from '../src/client/ui/distill-confirm.js'
import { dictionaries } from '../src/locale.js'

const t = (key) => key

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

function findChangeCheckbox(tree, changeId) {
  const row = collectNodes(tree).find(
    (node) => node.type === 'div' && node.props?.['data-change-id'] === changeId,
  )
  if (!row) return null
  return collectNodes(row).find(
    (node) => node.type === 'input' && node.props?.type === 'checkbox',
  )
}

function findFileCheckbox(tree, file) {
  const group = collectNodes(tree).find(
    (node) => node.type === 'div' && node.props?.['data-target-file'] === file,
  )
  if (!group) return null
  return collectNodes(group).find(
    (node) => node.type === 'input' && node.props?.type === 'checkbox',
  )
}

/**
 * Minimal hook runtime (same shape as tests/distill-view.test.js):
 * index-based state/ref slots and effect registration. DistillConfirm itself
 * uses only useState, but the runtime keeps the same contract so future
 * effects stay testable.
 */
function createHookRuntime() {
  const states = new Map()
  const refs = new Map()
  const effects = []
  let hookCursor = 0
  let effectCursor = 0

  const sameDeps = (left, right) => {
    if (left === undefined || right === undefined) return false
    if (left.length !== right.length) return false
    return left.every((value, index) => Object.is(value, right[index]))
  }

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
    useMemo(fn, deps) {
      const index = hookCursor++
      const prev = states.get(index)
      if (!prev || !sameDeps(prev.deps, deps)) {
        const val = fn()
        states.set(index, { deps, val })
        return val
      }
      return prev.val
    },
    useEffect(fn, deps) {
      const index = effectCursor++
      const previous = effects[index]
      if (!previous || !sameDeps(previous.deps, deps)) {
        effects[index] = { deps, fn, cleanup: previous?.cleanup ?? null, pending: true }
      } else if (previous.pending) {
        previous.fn = fn
      }
    },
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
    effects,
    render(Component, props) {
      hookCursor = 0
      effectCursor = 0
      return expandVNode(Component(props))
    },
    cleanupAll() {
      for (const item of effects) {
        if (typeof item.cleanup === 'function') {
          item.cleanup()
          item.cleanup = null
        }
      }
    },
  }
}

/** globalThis.fetch stub in the shape of tests/distill-lock.test.js. */
function stubFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const call = {
      url: String(url),
      method: options.method || 'GET',
      body: typeof options.body === 'string' ? JSON.parse(options.body) : (options.body ?? null),
    }
    calls.push(call)
    return handler(call)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const jsonResponse = (payload, ok = true) => ({ ok, json: async () => payload })

const RUN = { id: 'run-1', workspaceId: 'ws-1', status: 'ready' }

const PLAN = {
  schemaVersion: 1,
  runId: 'run-1',
  workspaceId: 'ws-1',
  summary: '沉淀了队列对账与组徽章同源两条决议。',
  navigation: { source: 'AGENTS.md#0', mode: 'tree', fallback: false },
  targets: [
    {
      file: 'docs/arch/models/finding.md',
      action: 'update',
      navRef: 'AGENTS.md > docs/arch/models/',
      fileBaseHash: 'a'.repeat(64),
      changes: [
        {
          id: 'c1',
          kind: 'insert-into-section',
          sectionAnchor: '## 4. Commit 归属与 Fork 派生',
          proposedText: 'inserted rule',
          rationale: '原始理由一',
          evidenceSnippet: '证据片段一（结果对节选）',
          evidence: [{ sessionId: 's1', messageId: 'm12', turn: 12, grade: 'resolved' }],
          dependsOn: ['c2'],
        },
        {
          id: 'c2',
          kind: 'append-section',
          proposedText: '# 新章节\n正文',
          rationale: '原始理由二',
          evidenceSnippet: '证据片段二',
          evidence: [{ sessionId: 's2', messageId: 'm8', turn: 8, grade: 'commit', commit: 'a1b2c3d' }],
          dependsOn: [],
        },
      ],
    },
    {
      file: 'AGENTS.md',
      action: 'update',
      navRef: 'AGENTS.md',
      fileBaseHash: 'b'.repeat(64),
      changes: [
        {
          id: 'c3',
          kind: 'replace-block',
          sectionAnchor: '## 0.1 项目一句话',
          proposedText: 'replaced body',
          rationale: '待确认：原始理由三',
          evidenceSnippet: '证据片段三',
          evidence: [{ sessionId: 's3', messageId: 'm2', turn: 2, grade: 'submitted' }],
          dependsOn: [],
        },
      ],
    },
  ],
  conflicts: [
    { topic: '冲突主题甲', claims: [], resolvedBy: 'code', note: '' },
    { topic: '冲突主题乙', claims: [], resolvedBy: 'unresolved', note: '' },
  ],
  stats: { targets: 2, changes: 3, byGrade: { resolved: 1, commit: 1, submitted: 1 } },
  truncated: true,
}

function makeComponent(runtime) {
  return createDistillConfirm({
    h,
    React: runtime.React,
    services: {},
    t,
  })
}

// ------------------------------------------------------------- confirmation

test('DistillConfirm: initial render shows summary, stats, truncation, evidence and kind labels', () => {
  const runtime = createHookRuntime()
  const DistillConfirm = makeComponent(runtime)
  const tree = runtime.render(DistillConfirm, { run: RUN, plan: PLAN, workspaceId: 'ws-1' })

  const text = textOf(tree)
  assert.ok(text.includes(t('distill.confirm.heading')), 'heading renders')
  assert.ok(text.includes(PLAN.summary), 'plan summary text renders')
  assert.ok(text.includes(t('distill.confirm.statFiles')), 'file stat label renders')
  assert.ok(text.includes(`: ${PLAN.stats.targets}`), 'file stat value renders')
  assert.ok(text.includes(`: ${PLAN.stats.changes}`), 'change stat value renders')
  assert.ok(text.includes(`: ${PLAN.conflicts.length}`), 'conflict stat value renders')
  assert.ok(text.includes(t('distill.confirm.truncatedBadge')), 'truncation marker renders')
  assert.ok(text.includes(t('distill.confirm.kind.insert-into-section')), 'kind label renders')
  assert.ok(text.includes(t('distill.confirm.kind.replace-block')), 'replace-block label renders')
  assert.ok(text.includes(t('distill.confirm.structuredNote')), 'structured-change note renders')
  assert.ok(text.includes('证据片段一（结果对节选）'), 'evidence snippet renders')
  // Evidence is human-readable: titles when known, otherwise the turn. Raw
  // session/message ids are never rendered (user feedback: unreadable).
  assert.ok(text.includes(t('distill.confirm.evidence.turn')), 'evidence falls back to the turn label')
  assert.ok(!text.includes('s1 · T12 · m12'), 'raw session/message codes must not render')
  assert.ok(!text.includes('m12'), 'message ids must not render')
  assert.ok(text.includes(t('distill.confirm.grade.submitted')), 'submitted grade badge renders')
  assert.ok(text.includes(t('distill.confirm.conflict.code')), 'conflict resolvedBy=code marker renders')
  assert.ok(text.includes(t('distill.confirm.conflict.unresolved')), 'conflict resolvedBy=unresolved marker renders')

  // defaultSelection: resolved + commit selected, submitted stays off.
  assert.equal(findChangeCheckbox(tree, 'c1').props.checked, true)
  assert.equal(findChangeCheckbox(tree, 'c2').props.checked, true)
  assert.equal(findChangeCheckbox(tree, 'c3').props.checked, false)
})

test('DistillConfirm: file-level checkbox selects and clears all entries of that file', () => {
  const runtime = createHookRuntime()
  const DistillConfirm = makeComponent(runtime)
  const props = { run: RUN, plan: PLAN, workspaceId: 'ws-1' }

  let tree = runtime.render(DistillConfirm, props)
  const docFile = findFileCheckbox(tree, 'docs/arch/models/finding.md')
  assert.equal(docFile.props.checked, true, 'file with all default-selected entries starts checked')

  docFile.props.onChange()
  tree = runtime.render(DistillConfirm, props)
  assert.equal(findChangeCheckbox(tree, 'c1').props.checked, false, 'unchecking the file clears its entries')
  assert.equal(findChangeCheckbox(tree, 'c2').props.checked, false)
  assert.equal(findFileCheckbox(tree, 'docs/arch/models/finding.md').props.checked, false)

  findFileCheckbox(tree, 'docs/arch/models/finding.md').props.onChange()
  tree = runtime.render(DistillConfirm, props)
  assert.equal(findChangeCheckbox(tree, 'c1').props.checked, true, 'checking the file brings every entry back')
  assert.equal(findChangeCheckbox(tree, 'c2').props.checked, true)
  assert.equal(findFileCheckbox(tree, 'docs/arch/models/finding.md').props.checked, true)
})

test('DistillConfirm: missing dependency shows a hint and blocks the apply', () => {
  const runtime = createHookRuntime()
  const DistillConfirm = makeComponent(runtime)
  const props = { run: RUN, plan: PLAN, workspaceId: 'ws-1' }

  let tree = runtime.render(DistillConfirm, props)
  findChangeCheckbox(tree, 'c2').props.onChange() // c1 depends on c2
  tree = runtime.render(DistillConfirm, props)

  const c1Row = collectNodes(tree).find((node) => node.props?.['data-change-id'] === 'c1')
  assert.ok(textOf(c1Row).includes('c2'), 'dependency hint names the missing change id')

  const apply = findButtonByText(tree, t('distill.confirm.applyButton'))
  assert.equal(apply.props.disabled, true, 'apply is disabled while a dependency is missing')
  assert.ok(textOf(tree).includes(t('distill.confirm.applyBlocked')), 'blocked reason renders')
})

test('DistillConfirm: selectQualified only selects resolved/commit and honors error checks', () => {
  const runtime = createHookRuntime()
  const DistillConfirm = makeComponent(runtime)
  const props = { run: RUN, plan: PLAN, workspaceId: 'ws-1' }

  let tree = runtime.render(DistillConfirm, props)
  // Clear everything first (both file-level boxes).
  findFileCheckbox(tree, 'docs/arch/models/finding.md').props.onChange()
  tree = runtime.render(DistillConfirm, props)
  findChangeCheckbox(tree, 'c3').props.onChange() // select c3, then clear via file box
  tree = runtime.render(DistillConfirm, props)
  findFileCheckbox(tree, 'AGENTS.md').props.onChange()
  tree = runtime.render(DistillConfirm, props)
  assert.equal(findChangeCheckbox(tree, 'c1').props.checked, false)
  assert.equal(findChangeCheckbox(tree, 'c2').props.checked, false)
  assert.equal(findChangeCheckbox(tree, 'c3').props.checked, false)

  findButtonByText(tree, t('distill.confirm.selectQualified')).props.onClick()
  tree = runtime.render(DistillConfirm, props)
  assert.equal(findChangeCheckbox(tree, 'c1').props.checked, true, 'resolved entry is selected')
  assert.equal(findChangeCheckbox(tree, 'c2').props.checked, true, 'commit entry is selected')
  assert.equal(findChangeCheckbox(tree, 'c3').props.checked, false, 'submitted entry stays unselected')

  // An error-level check on c1 excludes it from the qualified selection.
  const runtime2 = createHookRuntime()
  const DistillConfirm2 = makeComponent(runtime2)
  const checks = [
    { level: 'error', code: 'NAV_TREE', message: 'update target not registered', file: 'AGENTS.md', changeId: 'c1' },
  ]
  let tree2 = runtime2.render(DistillConfirm2, { ...props, checks })
  findButtonByText(tree2, t('distill.confirm.selectQualified')).props.onClick()
  tree2 = runtime2.render(DistillConfirm2, { ...props, checks })
  assert.equal(findChangeCheckbox(tree2, 'c1').props.checked, false, 'error-blocked change is excluded')
  assert.equal(findChangeCheckbox(tree2, 'c2').props.checked, true)
})

test('DistillConfirm: error-level checks render the validation partition and forbid the apply', () => {
  const runtime = createHookRuntime()
  const DistillConfirm = makeComponent(runtime)
  const checks = [
    { level: 'error', code: 'NAV_TREE', message: 'update target not registered in the navigation tree', file: 'AGENTS.md' },
    { level: 'warn', code: 'CONFLICT_UNRESOLVED', message: 'unresolved conflict must not be written as a rule' },
  ]
  const tree = runtime.render(DistillConfirm, { run: RUN, plan: PLAN, workspaceId: 'ws-1', checks })

  const text = textOf(tree)
  assert.ok(text.includes('update target not registered in the navigation tree'), 'error message renders')
  assert.ok(text.includes('unresolved conflict must not be written as a rule'), 'warn message renders')
  assert.ok(text.includes(t('distill.confirm.checks.errorLabel')), 'error partition label renders')
  assert.ok(text.includes(t('distill.confirm.checks.warnLabel')), 'warn partition label renders')

  const apply = findButtonByText(tree, t('distill.confirm.applyButton'))
  assert.equal(apply.props.disabled, true, 'error-level checks disable the apply')
  assert.ok(text.includes(t('distill.confirm.applyBlocked')), 'blocked hint renders')
})

test('DistillConfirm: rationale edits flow into the apply request as rationaleEdits', async () => {
  const fetchStub = stubFetch(() => jsonResponse({
    ok: true,
    applied: [],
    skipped: [],
    readBackOk: true,
    fingerprints: [],
    runStatus: 'applied',
  }))
  const runtime = createHookRuntime()
  const DistillConfirm = makeComponent(runtime)
  const props = { run: RUN, plan: PLAN, workspaceId: 'ws-1' }
  try {
    let tree = runtime.render(DistillConfirm, props)

    findButtonByText(tree, t('distill.confirm.rationaleEdit')).props.onClick()
    tree = runtime.render(DistillConfirm, props)
    const textarea = collectNodes(tree).find((node) => node.type === 'textarea')
    assert.ok(textarea, 'editing opens an inline textarea')
    textarea.props.onChange({ target: { value: '人工改写后的理由' } })
    tree = runtime.render(DistillConfirm, props)
    findButtonByText(tree, t('distill.confirm.rationaleSave')).props.onClick()
    tree = runtime.render(DistillConfirm, props)
    assert.ok(textOf(tree).includes('人工改写后的理由'), 'edited rationale renders in the card')
    assert.ok(textOf(tree).includes(t('distill.confirm.rationaleEdited')), 'edited marker renders')

    await findButtonByText(tree, t('distill.confirm.applyButton')).props.onClick()
    tree = runtime.render(DistillConfirm, props)
    await findButtonByText(tree, t('distill.confirm.confirmYes')).props.onClick()

    const post = fetchStub.calls.find((call) => call.method === 'POST' && call.url.includes('distill-apply'))
    assert.ok(post, 'apply POST is issued')
    assert.deepEqual(post.body.rationaleEdits, { c1: '人工改写后的理由' },
      'the edited rationale rides along as rationaleEdits')
    assert.deepEqual(post.body.selectedChangeIds, ['c1', 'c2'])
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

test('DistillConfirm: two-step apply — the first click issues no POST and shows the confirmation panel', () => {
  const fetchStub = stubFetch(() => jsonResponse({ ok: true }))
  const runtime = createHookRuntime()
  const DistillConfirm = makeComponent(runtime)
  const props = { run: RUN, plan: PLAN, workspaceId: 'ws-1' }
  try {
    let tree = runtime.render(DistillConfirm, props)
    findButtonByText(tree, t('distill.confirm.applyButton')).props.onClick()
    tree = runtime.render(DistillConfirm, props)

    assert.equal(fetchStub.calls.length, 0, 'first click never touches the network')
    const text = textOf(tree)
    assert.ok(text.includes(t('distill.confirm.confirmTitle')), 'confirmation panel title renders')
    assert.ok(text.includes('1'), 'file count appears (one file carries the selected changes)')
    assert.ok(text.includes(t('distill.confirm.confirmBackup')), 'backup directory label renders')
    assert.ok(text.includes('~/.dsh/storages/punch_desk/backups/'), 'backup directory path renders')
    assert.ok(text.includes(t('distill.confirm.confirmConflicts')), 'conflict count line renders')
    assert.ok(findButtonByText(tree, t('distill.confirm.confirmYes')), 'confirm button renders')
    assert.ok(findButtonByText(tree, t('distill.confirm.confirmNo')), 'back-out button renders')

    findButtonByText(tree, t('distill.confirm.confirmNo')).props.onClick()
    tree = runtime.render(DistillConfirm, props)
    assert.ok(findButtonByText(tree, t('distill.confirm.applyButton')), 'cancel returns to the apply bar')
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

test('DistillConfirm: apply success renders the applied page fields and fires onApplied', async () => {
  const fetchStub = stubFetch(() => jsonResponse({
    ok: true,
    applied: [{
      file: 'docs/arch/models/finding.md',
      action: 'update',
      newHash: 'f'.repeat(64),
      backupPath: '~/.dsh/storages/punch_desk/backups/finding-md/1234-docs%2Farch',
    }],
    skipped: [],
    readBackOk: true,
    fingerprints: ['fp-1', 'fp-2'],
    runStatus: 'applied',
  }))
  const runtime = createHookRuntime()
  const DistillConfirm = makeComponent(runtime)
  const appliedCalls = []
  const props = { run: RUN, plan: PLAN, workspaceId: 'ws-1', onApplied: (payload) => appliedCalls.push(payload) }
  try {
    let tree = runtime.render(DistillConfirm, props)
    await findButtonByText(tree, t('distill.confirm.applyButton')).props.onClick()
    tree = runtime.render(DistillConfirm, props)
    await findButtonByText(tree, t('distill.confirm.confirmYes')).props.onClick()
    tree = runtime.render(DistillConfirm, props)

    const post = fetchStub.calls.find((call) => call.method === 'POST' && call.url.includes('distill-apply'))
    assert.equal(post.url, 'api/punch-desk/distill-apply')
    assert.equal(post.body.runId, 'run-1')
    assert.deepEqual(post.body.selectedChangeIds, ['c1', 'c2'])
    assert.deepEqual(post.body.baseHashes, { 'docs/arch/models/finding.md': 'a'.repeat(64) },
      'baseHashes are assembled from plan.targets for files with selected changes')

    const text = textOf(tree)
    assert.ok(text.includes(t('distill.confirm.applied.heading')), 'applied heading renders')
    assert.ok(text.includes(t('distill.confirm.applied.readBackOk')), 'readBackOk renders')
    assert.ok(text.includes('ffffff'), 'short newHash renders')
    assert.ok(text.includes('punch_desk/backups/finding-md'), 'backupPath renders')
    assert.ok(text.includes('2'), 'fingerprint count renders')
    assert.equal(appliedCalls.length, 1, 'onApplied fires once with the response payload')
    assert.deepEqual(appliedCalls[0].fingerprints, ['fp-1', 'fp-2'])
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

test('DistillConfirm: equivalent-content skipped files render with the skip note', async () => {
  const fetchStub = stubFetch(() => jsonResponse({
    ok: true,
    applied: [],
    skipped: [{ file: 'AGENTS.md', reason: 'equivalent', hash: 'b'.repeat(64) }],
    readBackOk: true,
    fingerprints: [],
    runStatus: 'applied',
  }))
  const runtime = createHookRuntime()
  const DistillConfirm = makeComponent(runtime)
  const props = { run: RUN, plan: PLAN, workspaceId: 'ws-1' }
  try {
    // select only c3 (AGENTS.md) so the skipped file matches the selection
    let tree = runtime.render(DistillConfirm, props)
    findFileCheckbox(tree, 'docs/arch/models/finding.md').props.onChange() // clear c1/c2
    tree = runtime.render(DistillConfirm, props)
    findChangeCheckbox(tree, 'c3').props.onChange()
    tree = runtime.render(DistillConfirm, props)

    await findButtonByText(tree, t('distill.confirm.applyButton')).props.onClick()
    tree = runtime.render(DistillConfirm, props)
    await findButtonByText(tree, t('distill.confirm.confirmYes')).props.onClick()
    tree = runtime.render(DistillConfirm, props)

    const text = textOf(tree)
    assert.ok(text.includes('AGENTS.md'), 'skipped file is listed')
    assert.ok(text.includes(t('distill.confirm.applied.skipped')), 'equivalent-skip note renders')
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

test('DistillConfirm: a 409 CAS_CONFLICT response renders file/expected/actual in the error banner', async () => {
  const fetchStub = stubFetch(() => jsonResponse({
    ok: false,
    code: 'CAS_CONFLICT',
    error: 'baseline hash mismatch',
    file: 'AGENTS.md',
    expected: 'e'.repeat(64),
    actual: 'd'.repeat(64),
    rolledBack: true,
  }, false))
  const runtime = createHookRuntime()
  const DistillConfirm = makeComponent(runtime)
  const props = { run: RUN, plan: PLAN, workspaceId: 'ws-1' }
  try {
    let tree = runtime.render(DistillConfirm, props)
    await findButtonByText(tree, t('distill.confirm.applyButton')).props.onClick()
    tree = runtime.render(DistillConfirm, props)
    await findButtonByText(tree, t('distill.confirm.confirmYes')).props.onClick()
    tree = runtime.render(DistillConfirm, props)

    const alert = collectNodes(tree).find((node) => node.props?.role === 'alert')
    assert.ok(alert, 'error banner renders')
    const text = textOf(alert)
    assert.ok(text.includes(t('distill.confirm.error.code.CAS_CONFLICT')), 'mapped error code key renders')
    assert.ok(text.includes('AGENTS.md'), 'conflicting file renders')
    // The banner explains the meaning; hashes now live in the drift card as a
    // re-anchor preview, never as raw hex in the alert (user feedback).
    assert.ok(text.includes(t('distill.confirm.error.file')), 'the banner names the conflicting file')
    assert.ok(!text.includes('eeeeeee'), 'expected hash is no longer dumped raw')
    assert.ok(!text.includes('ddddddd'), 'actual hash is no longer dumped raw')
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

test('DistillConfirm: RECOVERY_CONFLICT renders targets, backupPath and the manual-handling hint', async () => {
  const fetchStub = stubFetch(() => jsonResponse({
    ok: false,
    code: 'RECOVERY_CONFLICT',
    error: 'external change during recovery',
    rolledBack: false,
    runStatus: 'failed',
    targets: ['docs/arch/models/finding.md', 'AGENTS.md'],
    backupPath: '~/.dsh/storages/punch_desk/backups/finding-md/keep-me',
  }, false))
  const runtime = createHookRuntime()
  const DistillConfirm = makeComponent(runtime)
  const props = { run: RUN, plan: PLAN, workspaceId: 'ws-1' }
  try {
    let tree = runtime.render(DistillConfirm, props)
    await findButtonByText(tree, t('distill.confirm.applyButton')).props.onClick()
    tree = runtime.render(DistillConfirm, props)
    await findButtonByText(tree, t('distill.confirm.confirmYes')).props.onClick()
    tree = runtime.render(DistillConfirm, props)

    const alert = collectNodes(tree).find((node) => node.props?.role === 'alert')
    assert.ok(alert, 'error banner renders')
    const text = textOf(alert)
    assert.ok(text.includes(t('distill.confirm.error.code.RECOVERY_CONFLICT')), 'mapped error code key renders')
    assert.ok(text.includes('docs/arch/models/finding.md'), 'both target files render')
    assert.ok(text.includes('AGENTS.md'), 'target list renders')
    assert.ok(text.includes('keep-me'), 'backupPath renders')
    assert.ok(text.includes(t('distill.confirm.error.manualHint')), 'manual handling hint renders')
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

test('DistillConfirm: an externally canceled run disables the apply with a status note', () => {
  const runtime = createHookRuntime()
  // Use the real zh dictionary for this case so the {status} template fills.
  const zh = dictionaries().zh
  const zhT = (key) => zh[key] ?? key
  const DistillConfirm = createDistillConfirm({ h, React: runtime.React, services: {}, t: zhT })
  const props = { run: { ...RUN, status: 'canceled' }, plan: PLAN, workspaceId: 'ws-1' }

  const tree = runtime.render(DistillConfirm, props)
  const apply = findButtonByText(tree, zhT('distill.confirm.applyButton'))
  assert.equal(apply.props.disabled, true, 'a non-ready run blocks the apply')
  assert.ok(textOf(tree).includes('运行状态已变为 canceled'), 'the filled run-status note renders')
  assert.ok(textOf(tree).includes('确认页已停用'), 'the disabled-page note renders')
})

// ------------------------------------------------------------- result content

test('DistillResultContent: renders summaries with markdown preview blocks and the renew callback', () => {
  const runtime = createHookRuntime()
  const DistillConfirm = makeComponent(runtime)
  const ResultContent = DistillConfirm.ResultContent
  assert.equal(typeof ResultContent, 'function', 'the result content is attached to the component')

  const renewCalls = []
  const run = {
    id: 'run-1',
    status: 'applied',
    summaries: [
      {
        sessionId: 's-1',
        title: '重构 store 的会话',
        markdown: '# 摘要标题\n\n第一段结论。\n\n第二段补充。',
        source: 'digest',
      },
    ],
  }
  const tree = runtime.render(ResultContent, { run, onRenew: (payload) => renewCalls.push(payload) })

  const text = textOf(tree)
  assert.ok(text.includes(t('distill.confirm.result.heading')), 'summaries heading renders')
  assert.ok(text.includes('重构 store 的会话'), 'summary title renders')
  assert.ok(text.includes('摘要标题'), 'markdown heading block renders')
  assert.ok(text.includes('第一段结论。'), 'markdown paragraph renders')
  assert.ok(text.includes('第二段补充。'), 'second paragraph renders as a separate block')
  assert.ok(text.includes(t('distill.confirm.result.source.digest')), 'digest source badge renders')

  const renew = findButtonByText(tree, t('distill.confirm.result.renew'))
  assert.ok(renew, 'renew button renders')
  renew.props.onClick()
  assert.equal(renewCalls.length, 1, 'the renew callback fires')
  assert.equal(renewCalls[0].summary.sessionId, 's-1', 'the callback carries the summary')
})

test('DistillResultContent: empty summaries render the explicit empty state', () => {
  const runtime = createHookRuntime()
  const DistillConfirm = makeComponent(runtime)
  const ResultContent = DistillConfirm.ResultContent

  for (const run of [{ id: 'run-1', status: 'applied', summaries: [] }, null]) {
    const tree = runtime.render(ResultContent, { run })
    assert.ok(textOf(tree).includes(t('distill.confirm.result.empty')),
      'explicit empty copy renders for missing/empty summaries')
    assert.equal(findButtonByText(tree, t('distill.confirm.result.renew')), undefined,
      'no renew button without summaries')
  }
})

// ------------------------------------------------------------- locale parity

test('locale: every distill.confirm.* key referenced by the component exists in zh and en', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const source = readFileSync(path.join(ROOT, 'src/client/ui/distill-confirm.js'), 'utf8')
  const used = [...new Set([...source.matchAll(/'(distill\.confirm\.[a-zA-Z0-9_.-]+)'/g)].map((m) => m[1]))]

  const dicts = dictionaries()
  const zhKeys = new Set(Object.keys(dicts.zh || {}))
  const enKeys = new Set(Object.keys(dicts.en || {}))
  const zhPrefix = new Set([...zhKeys].filter((key) => key.startsWith('distill.confirm.')))
  const enPrefix = new Set([...enKeys].filter((key) => key.startsWith('distill.confirm.')))

  assert.ok(used.length >= 70, `expected a full key surface, found ${used.length}`)
  const missing = used.filter((key) => !zhKeys.has(key) || !enKeys.has(key))
  assert.deepEqual(missing, [], `keys referenced by the component but missing from zh/en:\n${missing.join('\n')}`)

  const zhOnly = [...zhPrefix].filter((key) => !enPrefix.has(key))
  const enOnly = [...enPrefix].filter((key) => !zhPrefix.has(key))
  assert.deepEqual(zhOnly, [], `zh-only distill.confirm keys:\n${zhOnly.join('\n')}`)
  assert.deepEqual(enOnly, [], `en-only distill.confirm keys:\n${enOnly.join('\n')}`)

  const unused = [...zhPrefix].filter((key) => !used.includes(key))
  assert.deepEqual(unused, [], `defined but never referenced keys:\n${unused.join('\n')}`)
  assert.equal(zhPrefix.size, enPrefix.size, 'zh/en prefix key sets are the same size')
})
