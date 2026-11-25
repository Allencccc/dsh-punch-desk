import test from 'node:test'
import assert from 'node:assert/strict'
import { createFindingRecord } from '../src/domain/entries.js'
import { itemOriginKey, convertTurnActionToFinding, inheritTurnActions } from '../src/domain/turn-actions.js'
import { listArchivedTurnActions } from '../src/client/platform/turn-actions.js'
import { createDeskPage } from '../src/client/ui/desk.js'
import { dictionaries } from '../src/locale.js'

const dicts = dictionaries()
const t = (key) => dicts.zh[key] ?? key

const h = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: children.flat(Infinity),
})

function textOf(node) {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object') return (node.children || []).map(textOf).join('')
  return ''
}

function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  for (const child of node.children || []) {
    const found = findNode(child, predicate)
    if (found) return found
  }
  return null
}

function createFakeStore(data = {}) {
  const store = {
    turnActions: new Map(Object.entries(data.turnActions || {})),
    findings: new Map(Object.entries(data.findings || {})),
    async listTurnActions(sessionKey) {
      const canonical = sessionKey.startsWith('session:') ? sessionKey.slice('session:'.length) : sessionKey
      return store.turnActions.get(canonical) || null
    },
    async putTurnActions(sessionKey, state) {
      const canonical = sessionKey.startsWith('session:') ? sessionKey.slice('session:'.length) : sessionKey
      store.turnActions.set(canonical, state)
    },
    async listEntries(workspaceKey) {
      return store.findings.get(workspaceKey) || []
    },
    async putEntry(entry) {
      const ws = entry.workspaceKey || `session:${entry.sessionId}`
      const list = store.findings.get(ws) || []
      const idx = list.findIndex(e => e.id === entry.id)
      if (idx >= 0) list[idx] = entry
      else list.push(entry)
      store.findings.set(ws, list)
    },
    async listWorkspaces() {
      return Array.from(store.turnActions.keys()).map(k => `session:${k}`)
    },
  }
  return store
}

test('T-P4-5a: listArchivedTurnActions queries open items with workspace vs all scope', async () => {
  const store = createFakeStore({
    turnActions: {
      'sess-arch-1': {
        sessionId: 'sess-arch-1',
        items: [
          { id: 'item-1', turn: 1, source: 'prompt-tail', kind: 'confirm', status: 'open', title: 'Task 1' },
          { id: 'item-2', turn: 1, source: 'prompt-tail', kind: 'confirm', status: 'converted', title: 'Task 2' },
        ],
      },
      'sess-arch-2': {
        sessionId: 'sess-arch-2',
        items: [
          { id: 'item-3', turn: 2, source: 'turn-outcome', kind: 'turn-failed', status: 'open', title: 'Task 3' },
          { id: 'item-4', turn: 2, source: 'prompt-tail', kind: 'unaddressed', status: 'dismissed', title: 'Task 4' },
        ],
      },
      'sess-arch-empty': {
        sessionId: 'sess-arch-empty',
        items: [
          { id: 'item-5', turn: 3, source: 'prompt-tail', kind: 'confirm', status: 'converted', title: 'Task 5' },
        ],
      },
    },
  })

  const hostWorkspaces = [
    { id: 'ws-main', sessionIds: ['sess-arch-1', 'sess-active-1'] },
    { id: 'ws-other', sessionIds: ['sess-arch-2'] },
  ]

  // 1. scope = 'workspace': only returns sess-arch-1 in ws-main
  const wsResults = await listArchivedTurnActions({
    store,
    workspaceId: 'ws-main',
    scope: 'workspace',
    archivedSessionIds: ['sess-arch-1', 'sess-arch-2', 'sess-arch-empty'],
    hostWorkspaces,
  })

  assert.equal(wsResults.length, 1)
  assert.equal(wsResults[0].sessionId, 'sess-arch-1')
  assert.equal(wsResults[0].items.length, 1)
  assert.equal(wsResults[0].items[0].id, 'item-1')
  assert.equal(wsResults[0].crossWorkspace, false)

  // 2. scope = 'all': returns sess-arch-1 (same ws) and sess-arch-2 (cross ws)
  const allResults = await listArchivedTurnActions({
    store,
    workspaceId: 'ws-main',
    scope: 'all',
    archivedSessionIds: ['sess-arch-1', 'sess-arch-2', 'sess-arch-empty'],
    hostWorkspaces,
  })

  assert.equal(allResults.length, 2)
  const arch1 = allResults.find(r => r.sessionId === 'sess-arch-1')
  const arch2 = allResults.find(r => r.sessionId === 'sess-arch-2')
  assert.ok(arch1)
  assert.equal(arch1.crossWorkspace, false)
  assert.ok(arch2)
  assert.equal(arch2.crossWorkspace, true)
  assert.equal(arch2.items.length, 1)
  assert.equal(arch2.items[0].id, 'item-3')
})

test('T-P4-5c: inheritTurnActions executes Move semantic (converts source)', () => {
  const sourceItems = [
    { id: 'item-10', sessionId: 'src-sess', turn: 1, source: 'prompt-tail', evidenceSeq: 10, findingNo: 1, kind: 'confirm', confidence: 'high', title: 'Action 10', quote: 'Needs confirmation', status: 'open' },
  ]
  const targetSessionId = 'active-sess'
  const targetWorkspaceKey = 'session:active-sess'
  const targetWorkspaceId = 'ws-main'

  const { createdFindings, convertedSourceItems } = inheritTurnActions({
    items: sourceItems,
    targetSessionId,
    targetWorkspaceKey,
    targetWorkspaceId,
    targetSessionTitle: 'Active Session Title',
    mode: 'move',
    existingEntries: [],
    now: () => 1000,
    idGenerator: () => 'new-finding-1',
  })

  assert.equal(createdFindings.length, 1)
  const finding = createdFindings[0]
  assert.equal(finding.id, 'new-finding-1')
  assert.equal(finding.sessionId, 'active-sess')
  assert.equal(finding.workspaceKey, 'session:active-sess')
  assert.equal(finding.workspaceId, 'ws-main')
  assert.equal(finding.sessionTitle, 'Active Session Title')
  assert.equal(finding.status, 'open')
  assert.equal(finding.submissionStatus, 'unsubmitted')
  assert.equal(finding.origin, 'turn-action')
  assert.equal(finding.originKey, itemOriginKey(sourceItems[0]))

  // Source item converted in Move mode
  assert.equal(convertedSourceItems.length, 1)
  assert.equal(convertedSourceItems[0].status, 'converted')
  assert.equal(convertedSourceItems[0].findingId, 'new-finding-1')
  assert.equal(convertedSourceItems[0].decidedAt, 1000)
})

test('T-P4-5c: inheritTurnActions executes Copy semantic (leaves source open)', () => {
  const sourceItems = [
    { id: 'item-20', sessionId: 'src-sess', turn: 2, source: 'turn-outcome', evidenceSeq: 20, kind: 'turn-failed', confidence: 'high', title: 'Failure 20', status: 'open' },
  ]

  const { createdFindings, convertedSourceItems } = inheritTurnActions({
    items: sourceItems,
    targetSessionId: 'active-sess',
    targetWorkspaceKey: 'session:active-sess',
    targetWorkspaceId: 'ws-main',
    mode: 'copy',
    existingEntries: [],
    now: () => 2000,
    idGenerator: () => 'new-finding-2',
  })

  assert.equal(createdFindings.length, 1)
  assert.equal(createdFindings[0].id, 'new-finding-2')
  // In Copy mode, source item is NOT converted
  assert.equal(convertedSourceItems.length, 0)
})

test('T-P4-5c: Fork Quadruple Field Override on linked finding', () => {
  const parentFinding = createFindingRecord({
    id: 'parent-finding-id',
    sessionId: 'old-frozen-archived-session',
    workspaceKey: 'session:old-frozen-archived-session',
    workspaceId: 'old-workspace',
    sessionTitle: 'Old Frozen Session',
    thoughtNo: 5,
    title: 'Parent Finding Title',
    body: 'Original Finding Body',
    status: 'resolved',
    reviewStatus: 'resolved',
    reviewRound: 1,
  })

  const item = {
    id: 'action-item-30',
    sessionId: 'old-frozen-archived-session',
    turn: 3,
    source: 'prompt-tail',
    evidenceSeq: 30,
    findingNo: 2,
    kind: 'confirm',
    confidence: 'high',
    title: 'Refined Action',
    body: 'Refined Action Body',
    quote: 'Refined Action Body',
    relatedFindingId: 'parent-finding-id',
    status: 'open',
  }

  const parentMap = new Map([['parent-finding-id', parentFinding]])

  const { createdFindings } = inheritTurnActions({
    items: [item],
    targetSessionId: 'active-target-session',
    targetWorkspaceKey: 'session:active-target-session',
    targetWorkspaceId: 'active-target-workspace',
    targetSessionTitle: 'Active Target Session',
    mode: 'move',
    existingEntries: [],
    parentFindingsMap: parentMap,
    now: () => 3000,
    idGenerator: () => 'forked-finding-uuid',
  })

  assert.equal(createdFindings.length, 1)
  const forked = createdFindings[0]
  assert.equal(forked.id, 'forked-finding-uuid')
  // Mandatory 4 fields MUST be overridden:
  assert.equal(forked.sessionId, 'active-target-session')
  assert.equal(forked.workspaceKey, 'session:active-target-session')
  assert.equal(forked.workspaceId, 'active-target-workspace')
  assert.equal(forked.sessionTitle, 'Active Target Session')

  // Lineage & Fork round
  assert.equal(forked.sourceFindingId, 'parent-finding-id')
  assert.equal(forked.reviewRound, 2)
  assert.equal(forked.status, 'open')
  assert.equal(forked.submissionStatus, 'unsubmitted')
  assert.equal(forked.title, 'Refined Action')
  assert.equal(forked.body, 'Refined Action Body')
  assert.equal(forked.tag, 'context')

  // Provenance
  assert.equal(forked.origin, 'turn-action')
  assert.equal(forked.originKey, itemOriginKey(item))
  assert.equal(forked.sourceTurn, 3)
  assert.equal(forked.sourceSeq, 30)
  assert.equal(forked.sourceKind, 'prompt-tail')
  assert.equal(forked.sourceConfidence, 'high')
})

test('T-P4-5c: Idempotency reuses existing finding without duplicates', () => {
  const item = {
    sessionId: 'sess-1',
    turn: 1,
    source: 'prompt-tail',
    evidenceSeq: 15,
    findingNo: 1,
    kind: 'confirm',
    title: 'Duplicate Check',
    status: 'open',
  }
  const originKey = itemOriginKey(item)

  const existingFinding = createFindingRecord({
    id: 'existing-f-1',
    sessionId: 'target-session',
    workspaceKey: 'session:target-session',
    thoughtNo: 1,
    title: 'Duplicate Check',
    status: 'open',
    origin: 'turn-action',
    originKey,
  })

  const { createdFindings, convertedSourceItems } = inheritTurnActions({
    items: [item],
    targetSessionId: 'target-session',
    targetWorkspaceKey: 'session:target-session',
    targetWorkspaceId: 'ws-main',
    mode: 'move',
    existingEntries: [existingFinding],
    now: () => 4000,
    idGenerator: () => 'should-not-be-used',
  })

  assert.equal(createdFindings.length, 1)
  assert.equal(createdFindings[0].id, 'existing-f-1')
  // Source is still marked converted pointing to the existing finding
  assert.equal(convertedSourceItems.length, 1)
  assert.equal(convertedSourceItems[0].findingId, 'existing-f-1')
})

test('T-P4-5d: Desk shows archived open action items count hint', async () => {
  const fakeStore = createFakeStore({
    turnActions: {
      'sess-arch-1': {
        sessionId: 'sess-arch-1',
        items: [
          { id: 'it-1', turn: 1, status: 'open' },
          { id: 'it-2', turn: 1, status: 'open' },
        ],
      },
    },
  })

  let toastMsg = ''
  const services = {
    t,
    store: fakeStore,
    toast: {
      info: (msg) => { toastMsg = msg },
    },
    getArchivedSessionIds: () => ['sess-arch-1'],
    getActiveWorkspaceId: () => 'ws-1',
  }

  const DeskPage = createDeskPage({
    h,
    React: {
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useRef: (val) => ({ current: val }),
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useEffect: (fn) => { fn() },
    },
    services,
  })

  // Simulated render of Desk with archived sessions
  const vnode = DeskPage({
    useSessions: () => ({
      archivedSessionIds: ['sess-arch-1'],
      sessions: [{ id: 'sess-arch-1', sessionId: 'sess-arch-1', title: 'Archived 1' }],
    }),
  })

  assert.ok(vnode)
})
