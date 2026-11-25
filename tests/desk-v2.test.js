import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { computeAnalytics } from '../src/domain/desk-analytics.js'
import { SPEC_CANVAS_TEMPLATE } from '../src/domain/desk-canvas.js'
import { createWorkspaceRecord } from '../src/domain/workspace.js'
import { createDeskPage } from '../src/client/ui/desk.js'
import { createWorkspaceDashboard } from '../src/client/ui/workspace-dashboard.js'
import { createAnalyticsView } from '../src/client/ui/analytics-view.js'
import { createDraftEditor } from '../src/client/ui/draft-editor.js'
import { DRAFTS_WORKSPACE_KEY } from '../src/domain/desk.js'
import { dictionaries } from '../src/locale.js'

const dict = dictionaries()
const t = key => dict.zh[key] ?? key

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

function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate)
      if (found) return found
    }
    return undefined
  }
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate)
    if (found) return found
  }
  return undefined
}

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
      const set = value => states.set(index, typeof value === 'function' ? value(states.get(index)) : value)
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
      const previous = states.get(index)
      if (!previous || !sameDeps(previous.deps, deps)) {
        const value = fn()
        states.set(index, { deps, value })
        return value
      }
      return previous.value
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

  return {
    React,
    render(Component, props) {
      hookCursor = 0
      effectCursor = 0
      return Component(props)
    },
    async runEffects() {
      for (const effect of effects) {
        if (!effect?.pending) continue
        effect.pending = false
        if (typeof effect.cleanup === 'function') effect.cleanup()
        const cleanup = effect.fn()
        effect.cleanup = typeof cleanup === 'function' ? cleanup : null
      }
    },
    unmount() {
      for (const effect of effects) {
        if (typeof effect?.cleanup === 'function') effect.cleanup()
        if (effect) effect.cleanup = null
      }
    },
  }
}

// --- Migrated domain guards (Task 4.2: retrospective.js retired) ---

test('the retired retrospective implementation is fully removed', () => {
  // spec §15: retrospective.js / retrospective-diff.js are deleted with their
  // consumers rewired; guard against accidental resurrection.
  for (const file of [
    '../src/domain/retrospective.js',
    '../src/client/ui/retrospective-diff.js',
  ]) {
    assert.equal(fs.existsSync(new URL(file, import.meta.url)), false,
      `${file} must not come back`)
  }
})

test('computeAnalytics calculates tag percentages, turn ladders, and conversion rate', () => {
  const findings = [
    { id: 'f1', tag: 'optimize', reviewStatus: 'resolved' },
    { id: 'f2', tag: 'optimize', reviewStatus: 'resolved' },
    { id: 'f3', tag: 'refactor', reviewStatus: 'resolved' },
    { id: 'f4', tag: 'blocker', reviewStatus: 'pending' },
  ]
  const sessions = [
    { sessionId: 's1', turns: 4 },
    { sessionId: 's2', turns: 12 },
    { sessionId: 's3', turns: 25 },
    { sessionId: 's4', turns: 40 },
  ]
  const analytics = computeAnalytics({ findings, sessions })
  assert.equal(analytics.totalFindings, 4)
  assert.equal(analytics.resolvedFindings, 3)
  assert.equal(analytics.resolvedRatio, 75)
  assert.equal(analytics.tagCounts.optimize, 2)
  assert.equal(analytics.tagCounts.refactor, 1)
  assert.equal(analytics.tagCounts.blocker, 1)
  assert.equal(analytics.tagPercentages.optimize, 50)
  assert.equal(analytics.turnsDistribution['1-5'], 1)
  assert.equal(analytics.turnsDistribution['6-15'], 1)
  assert.equal(analytics.turnsDistribution['16-30'], 1)
  assert.equal(analytics.turnsDistribution['30+'], 1)
  assert.equal(analytics.totalTurns, 81)
  assert.ok(analytics.conversionRate > 0)
})

// --- UI Components & Integration Tests ---

test('WorkspaceDashboard renders 4 health metric cards, recent sessions, and upcoming drafts', () => {
  const runtime = createHookRuntime()
  const services = { t }
  const DraftEditor = createDraftEditor({ h, React: runtime.React, services })
  const Dashboard = createWorkspaceDashboard({ h, React: runtime.React, services, DraftEditor })

  const sessions = [
    { sessionId: 's1', turns: 5, findingCount: 3 },
    { sessionId: 's2', turns: 8, findingCount: 1 },
  ]
  const drafts = [
    { id: 'd1', title: 'Draft One', status: 'ready' },
  ]
  const workspaceRecord = createWorkspaceRecord({ id: 'ws-1', name: 'Punch Desk Dev', specSyncStatus: 'synced' })

  let reviewedSessionId = null
  let openedSessionId = null

  const rendered = runtime.render(Dashboard, {
    sessions,
    drafts,
    workspaceRecord,
    canOpenSession: true,
    onReviewSession: id => { reviewedSessionId = id },
    onOpenSession: id => { openedSessionId = id },
  })

  const text = textOf(rendered)
  assert.match(text, /活跃会话/)
  assert.match(text, /规范写回/)
  assert.match(text, /草案储备/)
  assert.match(text, /交互轮次/)
  assert.match(text, /已交付/)
  assert.match(text, /人工确认后写回工程文档/)
  assert.match(text, /近期会话流/)
  assert.match(text, /待开启草案储备/)

  // Actions wired (Task 4.2: the review button follows the renamed tab)
  const reviewBtn = findNode(rendered, item => typeof item.props?.onClick === 'function' && textOf(item).includes('手账精炼'))
  assert.ok(reviewBtn)
  reviewBtn.props.onClick()
  assert.equal(reviewedSessionId, 's1')

  const enterBtn = findNode(rendered, item => typeof item.props?.onClick === 'function' && textOf(item).includes('进入会话'))
  assert.ok(enterBtn)
  enterBtn.props.onClick()
  assert.equal(openedSessionId, 's1')
})

test('Spec Canvas supports template insertion with standard 4-part architecture schema', () => {
  const runtime = createHookRuntime()
  const services = {
    t,
    store: { putEntry: async () => {} },
  }
  const DraftEditor = createDraftEditor({ h, React: runtime.React, services })

  const draft = { id: 'd1', title: 'Architecture spec', body: '', status: 'idea', workspaceKey: DRAFTS_WORKSPACE_KEY }
  const rendered = runtime.render(DraftEditor, { draft, isNew: false })

  const insertBtn = findNode(rendered, item => typeof item.props?.onClick === 'function' && textOf(item).includes('插入规范模板'))
  assert.ok(insertBtn, 'expected template insert button')

  // Click insert template
  insertBtn.props.onClick()

  const updatedView = runtime.render(DraftEditor, { draft, isNew: false })
  const textarea = findNode(updatedView, item => item.type === 'textarea')
  assert.ok(textarea)
  assert.ok(textarea.props.value.includes('## 1. 目标 (Goal)'))
  assert.ok(textarea.props.value.includes('## 2. 架构设计 (Architecture & Design)'))
  assert.ok(textarea.props.value.includes('## 3. 安全边界与硬约束 (Safety & Constraints)'))
  assert.ok(textarea.props.value.includes('## 4. 任务拆解 (Task Breakdown)'))
})

test('AnalyticsView renders tag distribution, turns distribution, and conversion metrics', () => {
  const runtime = createHookRuntime()
  const services = { t }
  const Analytics = createAnalyticsView({ h, React: runtime.React, services })

  const findings = [
    { id: 'f1', tag: 'optimize', reviewStatus: 'resolved' },
    { id: 'f2', tag: 'refactor', reviewStatus: 'resolved' },
    { id: 'f3', tag: 'blocker', status: 'open' },
  ]
  const sessions = [
    { sessionId: 's1', turns: 5 },
    { sessionId: 's2', turns: 10 },
  ]

  const view = runtime.render(Analytics, { findings, sessions })
  const text = textOf(view)

  assert.match(text, /工程统计与效能指标/)
  assert.match(text, /规范沉淀转化率/)
  assert.match(text, /手账分类占比/)
  assert.match(text, /会话经过轮次阶梯分布/)
  assert.match(text, /优化 \(Optimize\)/)
  assert.match(text, /重构 \(Refactor\)/)
  assert.match(text, /问题 \(Blocker\)/)
  assert.match(text, /会话经过轮次反映整体时序跨度/)
})

test('DeskPage allows tab switching between dashboard, canvas, reviews, and analytics', async () => {
  const runtime = createHookRuntime()
  const store = {
    listWorkspaces: async () => [DRAFTS_WORKSPACE_KEY, 'session:s1'],
    listWorkspaceRecords: async () => [
      createWorkspaceRecord({ id: 'ws-main', name: 'Main Workspace', gitBranch: 'feat/v2', specSyncStatus: 'synced' }),
    ],
    listEntries: async () => [],
    listPromptLog: async () => [],
    getPrefs: async () => ({ startSessionBehavior: 'prefill' }),
    subscribe: () => () => {},
  }
  const services = {
    t,
    store,
    canOpenSession: () => false,
  }

  const DeskPage = createDeskPage({ h, React: runtime.React, services })
  const view = () => runtime.render(DeskPage, {})

  assert.match(textOf(view()), /会话手账正在初始化/)
  await runtime.runEffects()

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  const started = Date.now()
  while (textOf(view()).includes('正在初始化')) {
    if (Date.now() - started > 1000) throw new Error('timed out waiting for desk load')
    await delay(5)
  }

  let pageText = textOf(view())
  // Workspace name in sidebar
  assert.match(pageText, /Main Workspace/)

  // 4 tabs are present (Task 4.2: reviews tab renamed to 手账精炼)
  assert.match(pageText, /项目大盘/)
  assert.match(pageText, /架构画布/)
  assert.match(pageText, /手账精炼/)
  assert.match(pageText, /工程统计/)

  // Switch to Analytics tab
  const analyticsTabBtn = findNode(view(), item => item.props?.role === 'tab' && textOf(item).includes('工程统计'))
  assert.ok(analyticsTabBtn)
  analyticsTabBtn.props.onClick()

  pageText = textOf(view())
  assert.match(pageText, /手账分类占比/)
  assert.match(pageText, /规范沉淀转化率/)

  // Switch to Canvas tab
  const canvasTabBtn = findNode(view(), item => item.props?.role === 'tab' && textOf(item).includes('架构画布'))
  assert.ok(canvasTabBtn)
  canvasTabBtn.props.onClick()

  const editorNode = findNode(view(), item => typeof item.props?.onSave === 'function')
  assert.ok(editorNode, 'DraftEditor mounted in canvas tab')

  // Switch to Dashboard tab
  const dashboardTabBtn = findNode(view(), item => item.props?.role === 'tab' && textOf(item).includes('项目大盘'))
  assert.ok(dashboardTabBtn)
  dashboardTabBtn.props.onClick()

  pageText = textOf(view())
  assert.match(pageText, /活跃会话/)
  assert.match(pageText, /草案储备/)

  // Verify settings is NOT a top tab
  const tablist = findNode(view(), item => item.props?.role === 'tablist')
  assert.ok(tablist)
  assert.equal(findNode(tablist, item => textOf(item).includes('设置')), undefined)

  // Switch to Settings from bottom-left entry
  const settingsBtn = findNode(view(), item => item.props?.['aria-label'] === '设置')
  assert.ok(settingsBtn, 'Bottom-left settings button must exist')
  settingsBtn.props.onClick()

  const settingsNode = findNode(view(), item => item.props?.store === store)
  assert.ok(settingsNode, 'SettingsView mounted when switching to settings')

  // In settings, top 4 tabs are replaced by settingsHeader with close button
  assert.equal(findNode(view(), item => item.props?.role === 'tablist'), undefined)
  const closeBtn = findNode(view(), item => item.props?.['aria-label'] === '关闭')
  assert.ok(closeBtn, 'Close button must exist in settings header')

  // Click Close button, should navigate back to previous workbench tab
  closeBtn.props.onClick()
  assert.ok(findNode(view(), item => item.props?.role === 'tablist'), 'Tabs must reappear after closing settings')
  pageText = textOf(view())
  assert.match(pageText, /活跃会话/)
})

test('Dashboard finding rows toggle the detail from the whole row surface', () => {
  const runtime = createHookRuntime()
  const services = { t }
  const DraftEditor = createDraftEditor({ h, React: runtime.React, services })
  const Dashboard = createWorkspaceDashboard({ h, React: runtime.React, services, DraftEditor })

  const finding = {
    id: 'f-dash',
    sessionId: 's1',
    title: 'Dashboard row title',
    text: 'Dashboard row full body',
    tag: 'optimize',
    severity: 'optimize',
    thoughtNo: 1,
    status: 'resolved',
    reviewStatus: 'resolved',
    submittedAt: Date.now(),
    resolvedAt: Date.now(),
  }
  const toggles = []
  const base = {
    sessions: [{ sessionId: 's1', turns: 2, findingCount: 1 }],
    drafts: [],
    workspaceRecord: createWorkspaceRecord({ id: 'ws-1', name: 'Desk' }),
    allFindings: [finding],
    canOpenSession: true,
    onToggleExpandFinding: id => toggles.push(id),
  }

  const rendered = runtime.render(Dashboard, base)
  const row = findNode(rendered, item => item.props?.key === 'f-dash' && typeof item.props?.onClick === 'function')
  assert.ok(row, 'dashboard finding row must expose a row-level click handler')
  assert.equal(textOf(rendered).includes('Dashboard row full body'), false, 'row starts collapsed')

  row.props.onClick({ target: { closest: () => null } })
  assert.deepEqual(toggles, ['f-dash'], 'plain row click asks the host view to toggle')

  row.props.onClick({ target: { closest: () => ({ tagName: 'BUTTON' }) } })
  assert.deepEqual(toggles, ['f-dash'], 'inner control clicks must not toggle the row')

  const expanded = runtime.render(Dashboard, { ...base, expandedFindingIds: new Set(['f-dash']) })
  assert.ok(textOf(expanded).includes('Dashboard row full body'), 'expanded state renders the full body')
})
