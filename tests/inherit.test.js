import test from 'node:test'
import assert from 'node:assert/strict'
import {
  filterInheritableFindings,
  inheritFindings,
} from '../src/domain/entries.js'
import { dictionaries } from '../src/locale.js'
import { createSessionPane } from '../src/client/ui/session-pane.js'

test('filterInheritableFindings filters only open, unsubmitted findings', () => {
  const entries = [
    { id: 'f1', kind: 'finding', status: 'open' },
    { id: 'f2', kind: 'finding', status: 'open', submissionStatus: 'unsubmitted' },
    { id: 'f3', kind: 'finding', status: 'queued' }, // in queue
    { id: 'f4', kind: 'finding', status: 'submitted', submissionStatus: 'submitted' }, // submitted
    { id: 'f5', kind: 'finding', status: 'open', assignedGroupId: 'group-1' }, // in active group
    { id: 'f6', kind: 'finding', status: 'open', submittedAt: Date.now() }, // submitted
    { id: 'f7', kind: 'finding', status: 'resolved', reviewStatus: 'resolved' }, // resolved
    { id: 'f8', kind: 'finding', status: 'dismissed', reviewStatus: 'dismissed' }, // dismissed
    { id: 'd1', kind: 'draft', status: 'idea' }, // draft
  ]

  const inheritable = filterInheritableFindings(entries)
  assert.equal(inheritable.length, 2)
  assert.deepEqual(inheritable.map(f => f.id), ['f1', 'f2'])
})

test('inheritFindings in move mode transfers ownership and removes from source', () => {
  const sourceFindings = [
    { id: 'f1', kind: 'finding', sessionId: 'session-a', severity: 'optimize', title: 'Task 1' },
    { id: 'f2', kind: 'finding', sessionId: 'session-a', severity: 'blocker', title: 'Task 2' },
  ]

  const result = inheritFindings({
    findings: sourceFindings,
    targetSessionId: 'session-b',
    mode: 'move',
    existingThoughtNos: [1, 2, 3],
  })

  // upsertTarget has targetSessionId and target workspaceKey
  assert.equal(result.upsertTarget.length, 2)
  // Moved entries are renumbered inside the target session, so a source No can
  // never collide with an existing No of the destination (real 2026-11-09 bug).
  assert.deepEqual(result.upsertTarget.map(f => f.thoughtNo), [4, 5])
  assert.equal(result.upsertTarget[0].id, 'f1')
  assert.equal(result.upsertTarget[0].sessionId, 'session-b')
  assert.equal(result.upsertTarget[0].workspaceKey, 'session:session-b')
  assert.equal(result.upsertTarget[0].status, 'open')
  assert.equal(result.upsertTarget[0].submissionStatus, 'unsubmitted')

  // deleteSource specifies original source findings to delete
  assert.equal(result.deleteSource.length, 2)
  assert.deepEqual(result.deleteSource.map(f => f.id), ['f1', 'f2'])
})

test('inheritFindings in copy mode clones findings with new IDs and keeps source', () => {
  let counter = 100
  const mockUuid = () => `uuid-${counter++}`

  const sourceFindings = [
    { id: 'f1', kind: 'finding', sessionId: 'session-a', severity: 'optimize', title: 'Task 1' },
    { id: 'f2', kind: 'finding', sessionId: 'session-a', severity: 'refactor', title: 'Task 2' },
  ]

  const result = inheritFindings({
    findings: sourceFindings,
    targetSessionId: 'session-b',
    mode: 'copy',
    existingThoughtNos: [7],
    uuidGenerator: mockUuid,
  })

  // upsertTarget has new IDs and targetSessionId
  assert.equal(result.upsertTarget.length, 2)
  assert.deepEqual(result.upsertTarget.map(f => f.thoughtNo), [8, 9])
  assert.equal(result.upsertTarget[0].id, 'uuid-100')
  assert.equal(result.upsertTarget[0].sessionId, 'session-b')
  assert.equal(result.upsertTarget[0].workspaceKey, 'session:session-b')
  assert.equal(result.upsertTarget[0].title, 'Task 1')

  assert.equal(result.upsertTarget[1].id, 'uuid-101')
  assert.equal(result.upsertTarget[1].sessionId, 'session-b')
  assert.equal(result.upsertTarget[1].workspaceKey, 'session:session-b')
  assert.equal(result.upsertTarget[1].title, 'Task 2')

  // deleteSource is empty in copy mode
  assert.equal(result.deleteSource.length, 0)
})

test('inheritFindings safely handles empty or invalid inputs', () => {
  assert.deepEqual(inheritFindings({ findings: [], targetSessionId: 'session-b' }), { upsertTarget: [], deleteSource: [] })
  assert.deepEqual(inheritFindings({ findings: null, targetSessionId: 'session-b' }), { upsertTarget: [], deleteSource: [] })
  assert.deepEqual(inheritFindings({ findings: [{ id: 'f1' }], targetSessionId: '' }), { upsertTarget: [], deleteSource: [] })
})

test('SessionPane renders inherit button in toolbar with localized title', () => {
  const h = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity),
  })

  const states = new Map()
  let hookCursor = 0
  const React = {
    useState(initial) {
      const idx = hookCursor++
      if (!states.has(idx)) states.set(idx, typeof initial === 'function' ? initial() : initial)
      const set = val => states.set(idx, typeof val === 'function' ? val(states.get(idx)) : val)
      return [states.get(idx), set]
    },
    useRef(initial) {
      return { current: initial }
    },
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
    useEffect() {},
    useLayoutEffect() {},
  }

  const dicts = dictionaries()
  const t = k => dicts.zh[k] ?? k

  const SessionPane = createSessionPane({
    h,
    React,
    services: {
      t,
      store: {
        listEntries: async () => [],
        listWorkspaces: async () => ['session:other-1'],
        putEntry: async () => {},
        deleteEntry: async () => {},
        subscribe: () => () => {},
      },
      uuid: () => 'uuid-1',
    },
  })

  hookCursor = 0
  const tree = SessionPane({ sessionId: 'session-curr' })
  assert.ok(tree)

  // Verify inherit button is present in the tree
  function findByTitle(node, title) {
    if (!node) return null
    if (node.props?.title === title) return node
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        const found = findByTitle(child, title)
        if (found) return found
      }
    }
    return null
  }

  const inheritBtn = findByTitle(tree, '资产继承与调度')
  assert.ok(inheritBtn, 'Toolbar should contain the inherit button')
  assert.equal(inheritBtn.children?.[0], '继承')
})


test('filterInheritableFindings scope=all reaches other workspaces but keeps safety filters', () => {
  const findings = [
    { id: 'a1', kind: 'finding', status: 'open', submissionStatus: 'unsubmitted', workspaceId: 'ws-alpha' },
    { id: 'b1', kind: 'finding', status: 'open', submissionStatus: 'unsubmitted', workspaceId: 'ws-beta' },
    { id: 'a2', kind: 'finding', status: 'open', submissionStatus: 'unsubmitted', workspaceId: 'ws-alpha', assignedGroupId: 'g-1' },
    { id: 'b2', kind: 'finding', status: 'queued', submissionStatus: 'submitted', workspaceId: 'ws-beta' },
  ]

  assert.deepEqual(
    filterInheritableFindings(findings, 'ws-alpha').map(f => f.id),
    ['a1'],
    'default scope stays inside the target workspace',
  )
  assert.deepEqual(
    filterInheritableFindings(findings, 'ws-alpha', { scope: 'all' }).map(f => f.id),
    ['a1', 'b1'],
    'scope=all adds other workspaces without loosening the queued/grouped guards',
  )
})

test('inheritFindings stamps inheritedFrom when a source is supplied', () => {
  const result = inheritFindings({
    findings: [{ id: 'f1', kind: 'finding', sessionId: 's-a', workspaceId: 'ws-alpha', title: 'T' }],
    targetSessionId: 's-b',
    mode: 'copy',
    source: { sessionId: 's-a', workspaceId: 'ws-alpha' },
    uuidGenerator: () => 'new-id',
    now: () => 1000,
  })
  assert.deepEqual(result.upsertTarget[0].inheritedFrom, {
    sessionId: 's-a',
    workspaceId: 'ws-alpha',
    at: 1000,
  })
})
