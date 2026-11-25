/**
 * Agent F — UX round 3 of the confirmation page.
 *
 * User report: "确认 diff 阶段，展开详情这个功能非常鸡肋，直接取消" — the
 * before/after code blocks had an expand/collapse toggle that added friction
 * without adding information. The fold is gone; every code body is now shown
 * in full, capped only by a scrollable window:
 *   - both sides always render, with no expand / collapse button anywhere;
 *   - a long body scrolls inside a 260px `overflowY: 'auto'` window and is
 *     never truncated (no fold, no fade, no mask, no state);
 *   - the applied page's written-back audit copy uses the exact same shape.
 *
 * These tests drive the hook runtime and assert the plain rendered tree.
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

function findByAttr(node, name, value) {
  return collectNodes(node).find((item) => (value === undefined
    ? item.props?.[name] !== undefined
    : item.props?.[name] === value))
}

/** Panel wrapper whose stable id ends with the requested suffix. */
function findPanel(tree, idSuffix) {
  return collectNodes(tree).find((node) => {
    const id = node.props?.['data-code-panel']
    return typeof id === 'string' && id.endsWith(idSuffix)
  })
}

function findButtonIn(node, fragment) {
  if (!node) return undefined
  return collectNodes(node).find(
    (item) => item.type === 'button' && textOf(item).includes(fragment),
  )
}

function findPre(node) {
  if (!node) return undefined
  return collectNodes(node).find((item) => item.type === 'pre')
}

/** Minimal index-based hook runtime (same contract as tests/distill-ux2-confirm.test.js). */
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

const FILE = 'docs/arch/models/finding.md'

const RUN = {
  id: 'run-1',
  workspaceId: 'ws-1',
  status: 'ready',
  summaries: [],
}

// One logical line far past the 260px window, plus a second one.
const LONG_BEFORE = '旧的第四节正文。'.repeat(80)
const LONG_AFTER = `${'新的第四节正文，补充了队列对账与组徽章同源。'.repeat(24)}\n${'第二批补充说明。'.repeat(30)}`
const SHORT_AFTER = '替换后的结项段落'

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
          kind: 'replace-block',
          sectionAnchor: '## 4. Commit 归属与 Fork 派生',
          beforeText: LONG_BEFORE,
          proposedText: LONG_AFTER,
          rationale: '原始理由一',
          evidenceSnippet: '',
          evidence: [{ sessionId: 'sess-alpha', messageId: 'msg-1', turn: 12, grade: 'resolved' }],
          dependsOn: [],
        },
        {
          id: 'c2',
          kind: 'replace-block',
          sectionAnchor: '## 5. 结项操作',
          proposedText: SHORT_AFTER,
          rationale: '原始理由二',
          evidenceSnippet: '',
          evidence: [],
          dependsOn: [],
        },
      ],
    },
  ],
  conflicts: [],
  stats: { targets: 1, changes: 2, byGrade: {} },
  truncated: false,
}

function makeComponent() {
  const runtime = createHookRuntime()
  const DistillConfirm = createDistillConfirm({ h, React: runtime.React, services: {}, t })
  return { runtime, DistillConfirm }
}

function renderConfirm(runtime, DistillConfirm) {
  return runtime.render(DistillConfirm, { run: RUN, plan: PLAN, workspaceId: 'ws-1' })
}

// ------------------------------------------- no expand / collapse affordance

test('diff: before/after both render and no expand/collapse control exists', () => {
  const { runtime, DistillConfirm } = makeComponent()
  const tree = renderConfirm(runtime, DistillConfirm)

  for (const side of ['before', 'after']) {
    const panel = findPanel(tree, `:${side}`)
    assert.ok(panel, `${side} block renders`)
    assert.equal(textOf(findPre(panel)), side === 'before' ? LONG_BEFORE : LONG_AFTER,
      `${side} body renders the full text verbatim`)
    assert.ok(textOf(panel).includes(t(`distill.confirm.diff.${side}`)),
      `${side} label still names the side`)
    assert.equal(findButtonIn(panel, t('finding.expand')), undefined,
      `${side} block has no expand button`)
    assert.equal(findButtonIn(panel, t('finding.collapse')), undefined,
      `${side} block has no collapse button`)
  }

  // Nothing left of the removed fold: no toggle rows, fade masks or state hooks.
  assert.equal(findButtonIn(tree, t('finding.expand')), undefined, 'the page has no expand button')
  assert.equal(findButtonIn(tree, t('finding.collapse')), undefined, 'the page has no collapse button')
  assert.equal(findByAttr(tree, 'data-code-toggle-row'), undefined, 'no toggle row remains')
  assert.equal(findByAttr(tree, 'data-code-fade'), undefined, 'no bottom fade remains')
  assert.equal(findByAttr(tree, 'data-code-state'), undefined, 'no folded/expanded state remains')
})

// ------------------------------------------ scrollable, never truncated body

test('diff: long bodies scroll inside an auto-overflow window and keep every line', () => {
  const { runtime, DistillConfirm } = makeComponent()
  const tree = renderConfirm(runtime, DistillConfirm)

  for (const side of ['before', 'after']) {
    const pre = findPre(findPanel(tree, `:${side}`))
    const style = pre.props.style
    assert.equal(style.maxHeight, 260, `${side} body is capped by a scroll window`)
    assert.equal(style.overflowY, 'auto', `${side} body scrolls instead of folding`)
    assert.equal(style.whiteSpace, 'pre-wrap', `${side} body wraps long lines`)
    assert.ok(String(style.fontFamily).includes('monospace'), `${side} body stays monospace`)
    assert.ok(String(style.background).includes('--pd-bg-panel'), `${side} uses the panel background`)
    assert.ok(String(style.border).includes('1px solid'), `${side} keeps a thin hairline border`)
    assert.ok(!String(style.background).includes('shadow'), `${side} body has no shadow`)
    assert.equal(textOf(pre).length, (side === 'before' ? LONG_BEFORE : LONG_AFTER).length,
      `${side} body keeps the whole text (no truncation)`)
  }

  // A short body uses the same shape; the cap simply never engages.
  const shortPre = findPre(findPanel(tree, ':c2:after'))
  assert.equal(textOf(shortPre), SHORT_AFTER, 'short body renders verbatim')
  assert.equal(shortPre.props.style.overflowY, 'auto', 'short body keeps the same scroll container')
})

// ------------------------------------------------ applied page audit copy

test('applied page: the written-back body is shown directly with the same scroll shape', () => {
  const { runtime, DistillConfirm } = makeComponent()
  const run = {
    ...RUN,
    status: 'applied',
    appliedAt: 2000,
    applyResult: {
      ok: true,
      appliedAt: 2000,
      applied: [{ file: FILE, action: 'update', newHash: 'f'.repeat(64) }],
      skipped: [],
      selectedChangeIds: ['c1', 'c2'],
    },
  }
  const tree = runtime.render(DistillConfirm, { run, plan: PLAN, workspaceId: 'ws-1' })

  const panel = findPanel(tree, `applied:run-1:${FILE}:c1`)
  assert.ok(panel, 'the written-back body renders')
  const pre = findPre(panel)
  assert.equal(textOf(pre), LONG_AFTER, 'the audit copy keeps the full written body')
  assert.equal(pre.props.style.maxHeight, 260, 'the audit copy uses the same scroll window')
  assert.equal(pre.props.style.overflowY, 'auto', 'the audit copy scrolls, never folds')
  assert.equal(findButtonIn(panel, t('finding.expand')), undefined, 'no expand button on the audit copy')
  assert.equal(findButtonIn(panel, t('finding.collapse')), undefined, 'no collapse button on the audit copy')
  assert.equal(findByAttr(panel, 'data-code-toggle-row'), undefined, 'no toggle row on the audit copy')
})
