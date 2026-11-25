/**
 * Agent E — UX round 2 of the confirmation / applied page.
 *
 * Covers the seven user complaints that belong to
 * src/client/ui/distill-confirm.js:
 *   - the action bar is sticky at the top (back to index, pending filter,
 *     select-qualified, selected count, apply) and the disabled reason is shown
 *     in the bar instead of at the page tail;
 *   - the two-step confirmation opens directly under that bar (inside the
 *     sticky block), never at the end of the page, with in-place `applying`
 *     feedback and no scroll jump;
 *   - the applied page order is conclusion → plan summary → written-back detail
 *     → write-back stats → persistence hint, reading `run.applyResult`, with a
 *     sticky back-to-index entry and an honest "stats missing" line;
 *   - every review card compares `change.beforeText` with `change.proposedText`
 *     (create-file / older batches degrade explicitly, long bodies expand);
 *   - the rationale area explains its purpose (write-back record only, never
 *     re-evaluated by the model) and keeps the edit entry before the apply;
 *   - the not-adopted marker still toggles through distill-review.
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

function findByAttr(node, name, value) {
  return collectNodes(node).find((item) => {
    const actual = item.props?.[name]
    return value === undefined ? actual !== undefined : actual === value
  })
}

function findRow(tree, changeId) {
  return collectNodes(tree).find(
    (node) => node.type === 'div' && node.props?.['data-change-id'] === changeId,
  )
}

function findMarker(row, marker) {
  if (!row) return undefined
  return collectNodes(row).find((node) => node.props?.['data-marker'] === marker)
}

function findCheckbox(node) {
  if (!node) return undefined
  return collectNodes(node).find(
    (item) => item.type === 'input' && item.props?.type === 'checkbox',
  )
}

/** Minimal index-based hook runtime (same contract as tests/distill-view.test.js). */
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
    const ok = payload && payload.ok !== false
    return { ok, status: ok ? 200 : 409, json: async () => payload }
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const FILE = 'docs/arch/models/finding.md'
const NEW_FILE = 'docs/arch/models/new-topic.md'

const RUN = {
  id: 'run-1',
  workspaceId: 'ws-1',
  status: 'ready',
  summaries: [{ sessionId: 'sess-alpha', title: '队列对账决议', markdown: '', source: 'llm' }],
}

const LONG_BEFORE = `${'旧的第四节正文。'.repeat(80)}`

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
      fileBaseHash: 'a'.repeat(64),
      changes: [
        {
          id: 'c1',
          kind: 'insert-into-section',
          sectionAnchor: '## 4. Commit 归属与 Fork 派生',
          beforeText: LONG_BEFORE,
          proposedText: '新的第四节正文',
          rationale: '原始理由一',
          evidenceSnippet: '',
          evidence: [{ sessionId: 'sess-alpha', messageId: 'msg-1', turn: 12, grade: 'resolved' }],
          dependsOn: [],
        },
        {
          id: 'c2',
          kind: 'replace-block',
          sectionAnchor: '## 5. 结项操作',
          proposedText: '替换后的结项段落',
          rationale: '原始理由二',
          evidenceSnippet: '',
          evidence: [{ sessionId: 'sess-alpha', messageId: 'msg-2', turn: 8, grade: 'commit' }],
          dependsOn: [],
        },
      ],
    },
    {
      file: NEW_FILE,
      action: 'create',
      fileBaseHash: null,
      changes: [
        {
          id: 'c3',
          kind: 'create-file',
          proposedText: '# 新主题\n正文',
          rationale: '原始理由三',
          evidenceSnippet: '',
          evidence: [{ sessionId: 'sess-alpha', messageId: 'msg-3', turn: 4, grade: 'submitted' }],
          dependsOn: [],
        },
      ],
    },
  ],
  conflicts: [],
  stats: { targets: 2, changes: 3, byGrade: { resolved: 1, commit: 1, submitted: 1 } },
  truncated: false,
}

function makeComponent() {
  const runtime = createHookRuntime()
  const DistillConfirm = createDistillConfirm({ h, React: runtime.React, services: {}, t })
  return { runtime, DistillConfirm }
}

// ------------------------------------------------ sticky bar + in-place confirm

test('sticky bar: all actions pinned at the top, two-step confirmation opens right below it', () => {
  const { runtime, DistillConfirm } = makeComponent()
  const props = { run: RUN, plan: PLAN, workspaceId: 'ws-1' }
  const tree = runtime.render(DistillConfirm, props)

  const bar = findByAttr(tree, 'data-action-bar', 'confirm')
  assert.ok(bar, 'confirmation page renders a sticky action bar')
  assert.equal(bar.props.style.position, 'sticky', 'the bar sticks while scrolling')
  assert.equal(bar.props.style.top, 0, 'the bar pins to the top of the scrollport')
  assert.ok(String(bar.props.style.background).includes('--pd-bg'), 'the bar uses a page/card background token')
  assert.ok(String(bar.props.style.borderBottom).includes('1px'), 'the bar carries a bottom hairline')
  assert.ok(bar.props.style.zIndex !== undefined, 'the bar stacks above scrolling content')

  // Left cluster: label + caption. Right cluster: every action in one place.
  const barText = textOf(bar)
  assert.ok(barText.includes(t('distill.confirm.actionBar')), 'bar carries the actionBar label')
  assert.ok(barText.includes(t('distill.confirm.actionBarHint')), 'bar explains that it stays pinned')
  assert.ok(barText.includes(t('distill.confirm.selectedCount').replace('{count}', '2')),
    'selected count lives in the bar')
  for (const label of [
    'distill.confirm.backToIndex',
    'distill.confirm.filter.onlyPending',
    'distill.confirm.selectQualified',
    'distill.confirm.applyButton',
  ]) {
    assert.equal(typeof findButtonByText(bar, t(label))?.props.onClick, 'function',
      `${label} is an actionable button inside the sticky bar`)
  }
  // Without an onBack prop the back entry is present but honestly disabled.
  assert.equal(findButtonByText(bar, t('distill.confirm.backToIndex')).props.disabled, true,
    'back-to-index is disabled while the host passes no onBack')

  const fetchStub = stubFetch({})
  try {
    findButtonByText(bar, t('distill.confirm.applyButton')).props.onClick()
    const confirmed = runtime.render(DistillConfirm, props)
    assert.equal(fetchStub.calls.length, 0, 'the first click never touches the network')

    const confirmedBar = findByAttr(confirmed, 'data-action-bar', 'confirm')
    const panel = findByAttr(confirmed, 'data-confirm-panel', 'apply')
    assert.ok(panel, 'the confirmation panel renders after the first click')
    assert.ok(collectNodes(confirmedBar).includes(panel),
      'the confirmation panel lives inside the sticky block, not at the page tail')
    const rowIndex = confirmedBar.children.findIndex(
      (child) => child?.props?.['data-action-bar-row'] === 'main',
    )
    const panelIndex = confirmedBar.children.indexOf(panel)
    assert.ok(panelIndex > rowIndex, 'the confirmation panel sits directly below the bar row')
    assert.equal(panelIndex, rowIndex + 2,
      'only the in-place reason line separates the bar row from the confirmation panel')

    const panelText = textOf(panel)
    assert.ok(panelText.includes(t('distill.confirm.confirmTitle')), 'confirmation title renders in place')
    assert.ok(panelText.includes('~/.dsh/storages/punch_desk/backups/'), 'backup directory renders in place')
    assert.ok(collectNodes(panel).some(
      (node) => node.type === 'button' && textOf(node).includes(t('distill.confirm.confirmYes')),
    ), 'confirm-yes lives inside the confirmation panel')
    assert.ok(collectNodes(panel).some(
      (node) => node.type === 'button' && textOf(node).includes(t('distill.confirm.confirmNo')),
    ), 'confirm-no lives inside the confirmation panel')
  } finally {
    fetchStub.restore()
  }
})

test('sticky bar: disabled reason and back-to-index are in place, no page hunting', () => {
  const { runtime, DistillConfirm } = makeComponent()
  const backCalls = []
  const props = {
    run: RUN,
    plan: PLAN,
    workspaceId: 'ws-1',
    onBack: () => backCalls.push('back'),
  }
  let tree = runtime.render(DistillConfirm, props)

  // Live apply: the two-step hint is printed in the bar.
  const hintReason = findByAttr(tree, 'data-apply-reason', 'hint')
  assert.ok(hintReason, 'the ready state prints its reason row in the bar')
  assert.ok(textOf(hintReason).includes(t('distill.confirm.applyHint')), 'apply hint renders in the bar')

  const back = findButtonByText(findByAttr(tree, 'data-action-bar', 'confirm'), t('distill.confirm.backToIndex'))
  assert.equal(back.props.disabled, false, 'back-to-index is enabled when the host passes onBack')
  back.props.onClick()
  assert.deepEqual(backCalls, ['back'], 'back-to-index calls props.onBack (no navigation side effect)')

  // Empty selection: the apply is disabled and the reason is right next to it.
  const fileCheckbox = findCheckbox(findByAttr(tree, 'data-target-file', FILE))
  fileCheckbox.props.onChange() // clear c1 + c2 (c3 is unselected by default)
  tree = runtime.render(DistillConfirm, props)
  const emptyReason = findByAttr(tree, 'data-apply-reason', 'empty')
  assert.ok(emptyReason, 'empty selection reports its reason in the bar')
  assert.ok(textOf(emptyReason).includes(t('distill.confirm.applyEmpty')), 'applyEmpty renders in the bar')
  const emptyApply = findButtonByText(tree, t('distill.confirm.applyButton'))
  assert.equal(emptyApply.props.disabled, true, 'the apply is disabled while nothing is selected')
  emptyApply.props.onClick()
  tree = runtime.render(DistillConfirm, props)
  assert.equal(findByAttr(tree, 'data-confirm-panel', 'apply'), undefined,
    'a disabled apply never opens the confirmation panel')

  // Error-level check: blocked reason, still in the bar.
  const blocked = makeComponent()
  const blockedTree = blocked.runtime.render(blocked.DistillConfirm, {
    ...props,
    checks: [{ level: 'error', code: 'ANCHOR_MISSING', message: '目标锚点不存在', file: FILE }],
  })
  const blockedReason = findByAttr(blockedTree, 'data-apply-reason', 'blocked')
  assert.ok(blockedReason, 'the blocked state reports its reason in the bar')
  assert.ok(textOf(blockedReason).includes(t('distill.confirm.applyBlocked')),
    'applyBlocked renders in the bar')
  assert.equal(findButtonByText(blockedTree, t('distill.confirm.applyButton')).props.disabled, true,
    'error-level checks disable the apply')
})

// ---------------------------------------------- applied page from run.applyResult

test('applied page: run.applyResult drives conclusion → summary → detail → stats → hint with a sticky exit', () => {
  const { runtime, DistillConfirm } = makeComponent()
  const backCalls = []
  const viewCalls = []
  const run = {
    ...RUN,
    status: 'applied',
    createdAt: 1000,
    appliedAt: 61000,
    applyResult: {
      ok: true,
      appliedAt: 61000,
      applied: [{
        file: FILE,
        action: 'update',
        newHash: 'f'.repeat(64),
        backupPath: '~/.dsh/storages/punch_desk/backups/finding-md/1234-file',
      }],
      skipped: [],
      fingerprints: ['fp-1'],
      readBackOk: true,
      selectedChangeIds: ['c1', 'c2'],
      ignoredSkipped: ['c9'],
      alreadyPresentSkipped: ['c8'],
    },
  }
  const tree = runtime.render(DistillConfirm, {
    run,
    plan: PLAN,
    workspaceId: 'ws-1',
    onBack: () => backCalls.push('back'),
    onViewResult: (payload) => viewCalls.push(payload),
  })

  const sticky = findByAttr(tree, 'data-sticky-bar', 'applied')
  assert.ok(sticky, 'the applied page renders its sticky bar')
  assert.equal(sticky.props.style.position, 'sticky', 'the applied bar sticks too')
  assert.equal(sticky.props.style.top, 0, 'the applied bar pins to the top')
  const back = findButtonByText(sticky, t('distill.confirm.applied.backToIndex'))
  assert.ok(back, 'the applied bar carries the back-to-index entry')
  back.props.onClick()
  assert.deepEqual(backCalls, ['back'], 'back-to-index calls props.onBack')
  const viewResult = findButtonByText(sticky, t('distill.confirm.gotoResult'))
  viewResult.props.onClick()
  assert.equal(viewCalls.length, 1, 'view-result fires when the host exposes it')

  // Section order is the contract: conclusion → summary → detail → stats → hint.
  const conclusion = findByAttr(tree, 'data-applied-conclusion', 'ok')
  const summary = findByAttr(tree, 'data-applied-summary', 'plan')
  const detail = findByAttr(tree, 'data-bucket', 'applied')
  const stats = findByAttr(tree, 'data-stats', 'applied')
  const hint = findByAttr(tree, 'data-applied-hint', 'persisted')
  for (const node of [conclusion, summary, detail, stats, hint]) assert.ok(node, 'applied page section renders')
  const order = [sticky, conclusion, summary, detail, stats, hint]
  const positions = order.map((node) => tree.children.indexOf(node))
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right),
    'applied page sections appear in the contracted order')
  assert.equal(positions[0], 0, 'the sticky bar is the first block of the applied page')

  assert.ok(textOf(conclusion).includes(t('distill.confirm.applied.readBackOk')),
    'read-back conclusion badge renders')
  assert.ok(textOf(summary).includes(t('distill.confirm.applied.summaryHeading')), 'plan summary heading renders')
  assert.ok(textOf(summary).includes(PLAN.summary), 'plan summary text renders')
  assert.ok(textOf(detail).includes(t('distill.confirm.bucket.applied')), 'written-back detail renders')
  assert.ok(textOf(detail).includes('ffffff'), 'new content hash stays available for audit')

  const statsText = textOf(stats)
  assert.ok(statsText.includes(t('distill.confirm.stats.files').replace('{count}', '1')), 'file count renders')
  assert.ok(statsText.includes(t('distill.confirm.stats.changes').replace('{count}', '2')), 'change count renders')
  assert.ok(/用时 \d+:\d\d/.test(statsText), 'duration renders as m:ss')
  assert.ok(statsText.includes(`${t('distill.confirm.marker.ignored')}: 1`), 'ignoredSkipped count renders')
  assert.ok(statsText.includes(`${t('distill.confirm.applied.skipped')}: 1`), 'alreadyPresentSkipped count renders')
  assert.ok(textOf(hint).includes(t('distill.confirm.applied.persistedHint')),
    'persistence hint closes the page')
  assert.ok(textOf(tree).includes(t('distill.confirm.actionBarHint')),
    'the pinned bar explains itself on the applied page')
})

test('applied page: failure record and minimal record degrade honestly (no fabricated stats)', () => {
  const failure = makeComponent()
  const failureTree = failure.runtime.render(failure.DistillConfirm, {
    run: {
      ...RUN,
      status: 'failed',
      applyResult: {
        ok: false,
        code: 'CAS_CONFLICT',
        message: 'baseline hash mismatch',
        file: FILE,
        targets: [FILE],
        rolledBack: true,
        at: 1794,
      },
    },
    plan: PLAN,
    workspaceId: 'ws-1',
  })
  const failedConclusion = findByAttr(failureTree, 'data-applied-conclusion', 'failed')
  assert.ok(failedConclusion, 'a persisted failure renders the failure conclusion')
  assert.ok(textOf(failedConclusion).includes(t('distill.confirm.error.code.CAS_CONFLICT')),
    'the failure code is localized, not a raw code')
  assert.ok(textOf(failedConclusion).includes('baseline hash mismatch'), 'the failure message renders')
  assert.equal(findByAttr(failureTree, 'data-stats', 'applied'), undefined,
    'a failed apply never shows write-back stats')
  const missing = findByAttr(failureTree, 'data-stats', 'missing')
  assert.ok(missing, 'a record without stats data shows the stats-missing line')
  assert.ok(textOf(missing).includes(t('distill.confirm.applied.statsMissing')), 'statsMissing copy renders')

  // A minimal (older) success record has no applied/skipped lists: same honest line.
  const minimal = makeComponent()
  const minimalTree = minimal.runtime.render(minimal.DistillConfirm, {
    run: { ...RUN, status: 'applied', appliedAt: 2000, applyResult: { ok: true, appliedAt: 2000 } },
    plan: PLAN,
    workspaceId: 'ws-1',
  })
  assert.ok(findByAttr(minimalTree, 'data-applied-conclusion', 'ok'), 'the success conclusion still renders')
  assert.equal(findByAttr(minimalTree, 'data-stats', 'applied'), undefined,
    'minimal records do not fabricate zeroed stats')
  assert.ok(textOf(findByAttr(minimalTree, 'data-stats', 'missing')).includes(
    t('distill.confirm.applied.statsMissing')), 'minimal records also show statsMissing')
})

// ------------------------------------------------------------ before/after diff

test('diff: before/after comparison renders from the plan snapshot and degrades explicitly', () => {
  const { runtime, DistillConfirm } = makeComponent()
  const props = { run: RUN, plan: PLAN, workspaceId: 'ws-1' }
  let tree = runtime.render(DistillConfirm, props)

  // c1: both sides captured, anchor named, "only this section" explainer.
  const diff1 = findByAttr(tree, 'data-diff', 'c1')
  assert.ok(diff1, 'the review card carries a before/after comparison')
  const diff1Text = textOf(diff1)
  assert.ok(diff1Text.includes(t('distill.confirm.diff.before')), 'before label renders')
  assert.ok(diff1Text.includes(t('distill.confirm.diff.after')), 'after label renders')
  assert.ok(diff1Text.includes(
    t('distill.confirm.diff.anchor').replace('{anchor}', '## 4. Commit 归属与 Fork 派生'),
  ), 'the section anchor is named in the comparison')
  assert.ok(diff1Text.includes(t('distill.confirm.diff.unchangedHint')),
    'the structural note explains that only this section changes')
  const before1 = findByAttr(diff1, 'data-diff-text', 'before')
  const after1 = findByAttr(diff1, 'data-diff-text', 'after')
  assert.equal(textOf(before1), LONG_BEFORE, 'the before block renders change.beforeText verbatim')
  assert.equal(textOf(after1), '新的第四节正文', 'the after block renders change.proposedText')
  assert.equal(before1.type, 'pre', 'the before block is a read-only code panel')
  assert.ok(String(before1.props.style.fontFamily).includes('monospace'), 'code panels stay monospace')

  // Long bodies scroll inside a capped read-only panel: the fold/expand toggle was
  // removed on purpose (users found it pointless), so there must be no toggle at all.
  assert.equal(before1.props.style.maxHeight, 260, 'long code blocks stay capped for scanning')
  assert.equal(before1.props.style.overflowY, 'auto', 'the capped block scrolls instead of truncating')
  assert.equal(findButtonByText(diff1, t('finding.expand')), undefined,
    'no expand toggle remains on the comparison')

  // c2: older batch without the snapshot → explicit copy, never a fake "before".
  const diff2 = findByAttr(tree, 'data-diff', 'c2')
  const noBefore = findByAttr(diff2, 'data-diff-empty', 'no-before')
  assert.ok(noBefore, 'a missing beforeText renders the no-before note')
  assert.ok(textOf(noBefore).includes(t('distill.confirm.diff.noBefore')), 'noBefore copy renders')
  assert.equal(findByAttr(diff2, 'data-diff-text', 'before'), undefined,
    'no fabricated before block for older batches')

  // c3: create-file → "new file, nothing before it", after side still shown.
  const diff3 = findByAttr(tree, 'data-diff', 'c3')
  const newFile = findByAttr(diff3, 'data-diff-empty', 'new-file')
  assert.ok(newFile, 'create-file renders the new-file note')
  assert.ok(textOf(newFile).includes(t('distill.confirm.diff.newFile')), 'newFile copy renders')
  assert.equal(textOf(findByAttr(diff3, 'data-diff-text', 'after')), '# 新主题\n正文',
    'the proposed body of a new file still renders')
})

// -------------------------------------------------------------- rationale area

test('rationale: the card says the text is a record only (never re-evaluated) and editing still works', () => {
  const { runtime, DistillConfirm } = makeComponent()
  const props = { run: RUN, plan: PLAN, workspaceId: 'ws-1' }
  let tree = runtime.render(DistillConfirm, props)

  const rationale = findByAttr(tree, 'data-rationale', 'c1')
  assert.ok(rationale, 'the rationale area is its own block')
  const rationaleText = textOf(rationale)
  assert.ok(rationaleText.includes(t('distill.confirm.rationaleLabel')), 'rationale label renders')
  assert.ok(rationaleText.includes('原始理由一'), 'rationale body renders')
  assert.ok(rationaleText.includes(t('distill.confirm.rationaleHint'))
    || textOf(findByAttr(rationale, 'data-rationale-hint')).includes(t('distill.confirm.rationaleHint')),
  'the purpose hint renders next to the rationale')
  assert.ok(textOf(findByAttr(rationale, 'data-rationale-hint')).includes('模型'),
    'the hint states the text is never sent back to the model')

  findButtonByText(rationale, t('distill.confirm.rationaleEdit')).props.onClick()
  tree = runtime.render(DistillConfirm, props)
  const textarea = collectNodes(findByAttr(tree, 'data-rationale', 'c1'))
    .find((node) => node.type === 'textarea')
  assert.ok(textarea, 'the edit entry still opens an inline textarea')
  textarea.props.onChange({ target: { value: '人工改写后的理由' } })
  tree = runtime.render(DistillConfirm, props)
  findButtonByText(tree, t('distill.confirm.rationaleSave')).props.onClick()
  tree = runtime.render(DistillConfirm, props)
  const saved = findByAttr(tree, 'data-rationale', 'c1')
  assert.ok(textOf(saved).includes('人工改写后的理由'), 'the edited rationale renders')
  assert.ok(textOf(saved).includes(t('distill.confirm.rationaleEdited')), 'the edited marker renders')
})

// --------------------------------------------------------- not-adopted marker

test('marker: the not-adopted toggle still writes distill-review and rolls back on failure', async () => {
  const fetchStub = stubFetch({ 'distill-review': { ok: true, review: { ignoredChangeIds: ['c2'], at: 1 } } })
  const { runtime, DistillConfirm } = makeComponent()
  const props = { run: RUN, plan: PLAN, workspaceId: 'ws-1' }
  try {
    let tree = runtime.render(DistillConfirm, props)
    findButtonByText(findRow(tree, 'c2'), t('distill.confirm.ignoreAction')).props.onClick()
    await tick()
    tree = runtime.render(DistillConfirm, props)

    const post = fetchStub.calls.find((call) => call.url.includes('distill-review'))
    assert.ok(post, 'distill-review POST is issued')
    assert.deepEqual(post.body.ignoredChangeIds, ['c2'], 'the ignored id is persisted')

    const ignoredRow = findRow(tree, 'c2')
    assert.ok(findMarker(ignoredRow, 'ignored'), 'the not-adopted marker renders on the row')
    assert.equal(findCheckbox(ignoredRow).props.disabled, true, 'an ignored change is not selectable')
    assert.equal(findCheckbox(ignoredRow).props.checked, false, 'an ignored change is not selected')

    findButtonByText(ignoredRow, t('distill.confirm.undoIgnore')).props.onClick()
    await tick()
    tree = runtime.render(DistillConfirm, props)
    assert.equal(findMarker(findRow(tree, 'c2'), 'ignored'), undefined, 'restore clears the marker')
    assert.equal(findCheckbox(findRow(tree, 'c2')).props.checked, true, 'restore brings the selection back')
  } finally {
    fetchStub.restore()
  }

  // A failed write rolls the optimistic marker back and surfaces the error.
  const failing = stubFetch({
    'distill-review': { ok: false, error: { code: 'REVIEW_NOT_ALLOWED', message: 'run is not ready' } },
  })
  const second = makeComponent()
  try {
    let tree = second.runtime.render(second.DistillConfirm, props)
    findButtonByText(findRow(tree, 'c1'), t('distill.confirm.ignoreAction')).props.onClick()
    await tick()
    tree = second.runtime.render(second.DistillConfirm, props)
    assert.equal(findMarker(findRow(tree, 'c1'), 'ignored'), undefined, 'a failed write rolls the marker back')
    assert.equal(findCheckbox(findRow(tree, 'c1')).props.checked, true, 'a failed write restores the selection')
  } finally {
    failing.restore()
  }
})
