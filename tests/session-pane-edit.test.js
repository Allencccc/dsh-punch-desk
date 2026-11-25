import test from 'node:test'
import assert from 'node:assert/strict'
import { createSubmitService } from '../src/client/platform/submit.js'
import { createFindingRecord } from '../src/domain/entries.js'
import { createGroupRecord, addItemToGroup } from '../src/domain/active-group.js'
import { createSessionPane } from '../src/client/ui/session-pane.js'
import { dictionaries } from '../src/locale.js'

const dicts = dictionaries()
const t = key => dicts.zh[key] ?? key

const h = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: children.flat(Infinity),
})

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
    useLayoutEffect(fn, deps) {
      this.useEffect(fn, deps)
    },
  }

  return {
    React,
    render(Component, props) {
      hookCursor = 0
      effectCursor = 0
      const tree = Component(props)
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
      return expandVNode(tree)
    },
    async flushEffects() {
      for (const item of effects) {
        if (item.pending) {
          item.pending = false
          if (typeof item.cleanup === 'function') item.cleanup()
          item.cleanup = await item.fn()
        }
      }
    },
  }
}

test('editQueued: calls QueueAction.edit in place when supported', async () => {
  const calls = { updateQueue: [] }
  const remote = {
    session: {
      state: async () => ({
        ok: true,
        value: { queue: [{ id: 'q-item-1', rpcId: 'req-edit-1' }] },
      }),
      updateQueue: async (args) => {
        calls.updateQueue.push(args)
        return { ok: true, value: { accepted: true } }
      },
    },
  }
  const submit = createSubmitService({ remote })
  const result = await submit.editQueued('s-1', 'req-edit-1', 'Updated prompt text')

  assert.equal(result.ok, true)
  assert.equal(result.method, 'edit')
  assert.equal(calls.updateQueue.length, 1)
  assert.deepEqual(calls.updateQueue[0], {
    sessionId: 's-1',
    itemId: 'q-item-1',
    action: { kind: 'edit', content: [{ type: 'text', text: 'Updated prompt text' }] },
  })
})

test('editQueued: rejected edit reports failure, keeps the item queued, and never calls remove', async () => {
  const queued = [{ id: 'q-item-2', rpcId: 'req-edit-2' }]
  const calls = { updateQueue: [], stateCalls: 0 }
  const remote = {
    session: {
      state: async () => {
        calls.stateCalls++
        return { ok: true, value: { queue: queued } }
      },
      updateQueue: async (args) => {
        calls.updateQueue.push(args)
        return { ok: false, error: { code: 'queue/edit-unsupported', message: 'edit not supported' } }
      },
    },
  }
  const submit = createSubmitService({ remote })
  const result = await submit.editQueued('s-1', 'req-edit-2', 'Fallback prompt text')

  assert.equal(result.ok, false)
  assert.equal(result.error.message, 'edit not supported')
  assert.equal(calls.updateQueue.length, 1)
  assert.equal(calls.updateQueue[0].action.kind, 'edit')
  // No queue withdrawal: the item must still be queued for the Harness.
  assert.equal(calls.updateQueue.some(call => call.action.kind === 'remove'), false)
  assert.deepEqual(queued, [{ id: 'q-item-2', rpcId: 'req-edit-2' }])
})

test('editQueued: returns not-queued when item was already claimed or consumed', async () => {
  const remote = {
    session: {
      state: async () => ({
        ok: true,
        value: { queue: [] },
      }),
      updateQueue: async () => {
        assert.fail('updateQueue should not be called')
      },
    },
  }
  const submit = createSubmitService({ remote })
  const result = await submit.editQueued('s-1', 'req-missing', 'Text')

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not-queued')
})

test('editQueued: a thrown edit fails without removing the queued item', async () => {
  const calls = []
  const remote = {
    session: {
      state: async () => ({
        ok: true,
        value: { queue: [{ id: 'q-item-3', rpcId: 'req-edit-3' }] },
      }),
      updateQueue: async (args) => {
        calls.push(args)
        throw new Error('harness offline')
      },
    },
  }
  const submit = createSubmitService({ remote })
  const result = await submit.editQueued('s-1', 'req-edit-3', 'Edited text')

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'submit/edit-failed')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action.kind, 'edit')
})

test('editQueued: state read failure reports failure without queue withdrawal', async () => {
  const calls = []
  const remote = {
    session: {
      state: async () => ({ ok: false, error: { code: 'session/offline', message: 'offline' } }),
      updateQueue: async (args) => {
        calls.push(args)
        return { ok: true }
      },
    },
  }
  const submit = createSubmitService({ remote })
  const result = await submit.editQueued('s-1', 'req-edit-4', 'Edited text')

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'session/offline')
  assert.equal(calls.length, 0)
  assert.equal(typeof submit.retractQueued, 'undefined')
  assert.equal(typeof submit.undo, 'undefined')
})

test('SessionPane Drag & Drop assigns finding to active group and triggers submission', async () => {
  const { React, render, flushEffects } = createHookRuntime()

  const g1 = createGroupRecord({ id: 'g-1', groupNumber: 1, sessionId: 's-1', workspaceId: 'session:s-1', items: [] })
  const f1 = createFindingRecord({ id: 'f-pool-1', sessionId: 's-1', text: 'Draggable finding', submissionStatus: 'unsubmitted' })

  const entriesStore = [f1]
  const groupsStore = [g1]
  const promptCalls = []

  const services = {
    t,
    store: {
      listEntries: async () => entriesStore,
      putEntry: async (e) => {
        const idx = entriesStore.findIndex(x => x.id === e.id)
        if (idx >= 0) entriesStore[idx] = e
        else entriesStore.push(e)
      },
      getGroups: async () => groupsStore,
      putGroup: async (g) => {
        const idx = groupsStore.findIndex(x => x.id === g.id)
        if (idx >= 0) groupsStore[idx] = g
        else groupsStore.push(g)
      },
      subscribe: () => () => {},
      quotaWarning: () => false,
    },
    index: {
      listRecent: async () => [],
      start: () => {},
      stop: () => {},
      track: async () => {},
    },
    submit: createSubmitService({
      remote: {
        session: {
          prompt: async (args) => {
            promptCalls.push(args)
            return { ok: true, value: { accepted: true } }
          },
          state: async () => ({ ok: true, value: { queue: [] } }),
        },
      },
      uuid: () => 'req-drop-1',
    }),
    createFinding: (args) => createFindingRecord(args),
    uuid: () => 'uuid-drop-1',
  }

  const SessionPane = createSessionPane({ h, React, services })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  const tree = render(SessionPane, { sessionId: 's-1' })

  // Find the drop target for Group 1
  function findDropTarget(node) {
    if (!node || typeof node !== 'object') return null
    if (typeof node.props?.onDrop === 'function') return node
    for (const child of node.children || []) {
      const found = findDropTarget(child)
      if (found) return found
    }
    return null
  }

  const dropTarget = findDropTarget(tree)
  assert.ok(dropTarget, 'Group card must have onDrop handler')

  // Simulate drop event
  const fakeEvent = {
    preventDefault: () => {},
    dataTransfer: {
      getData: (format) => (format === 'text/plain' ? 'f-pool-1' : null),
    },
  }
  await dropTarget.props.onDrop(fakeEvent)

  // Verify finding was assigned to group and submitted
  const updatedFinding = entriesStore.find(e => e.id === 'f-pool-1')
  assert.equal(updatedFinding.assignedGroupId, 'g-1')
  assert.equal(updatedFinding.submissionStatus, 'submitted')

  // Verify group item was added
  const updatedGroup = groupsStore.find(g => g.id === 'g-1')
  assert.ok(updatedGroup.items.some(it => it.findingId === 'f-pool-1'))

  // Verify prompt was sent
  assert.equal(promptCalls.length, 1)
  assert.equal(promptCalls[0].sessionId, 's-1')
  assert.match(promptCalls[0].content[0].text, /Draggable finding/)
})

test('Expand/collapse shows and hides full text and code formatting', async () => {
  const { React, render, flushEffects } = createHookRuntime()

  const multiLineText = 'Line 1\n```javascript\nconst a = 10\n```\nLine 3'
  const f1 = createFindingRecord({ id: 'f-exp-1', sessionId: 's-1', text: multiLineText, submissionStatus: 'unsubmitted' })

  const entriesStore = [f1]
  const services = {
    t,
    store: {
      listEntries: async () => entriesStore,
      putEntry: async () => {},
      getGroups: async () => [],
      putGroup: async () => {},
      subscribe: () => () => {},
      quotaWarning: () => false,
    },
    index: { listRecent: async () => [] },
    submit: createSubmitService({ remote: { session: {} } }),
    createFinding: (args) => createFindingRecord(args),
    uuid: () => 'uuid-1',
  }

  const SessionPane = createSessionPane({ h, React, services })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  let tree = render(SessionPane, { sessionId: 's-1' })

  function findButtonsByTitle(node, title) {
    const res = []
    if (!node || typeof node !== 'object') return res
    if (node.type === 'button' && (node.props?.title === title || node.props?.['aria-label'] === title)) {
      res.push(node)
    }
    for (const child of node.children || []) {
      res.push(...findButtonsByTitle(child, title))
    }
    return res
  }

  function hasText(node, str) {
    if (!node) return false
    if (typeof node === 'string') return node.includes(str)
    if (Array.isArray(node)) return node.some(child => hasText(child, str))
    if (typeof node === 'object') {
      return hasText(node.children, str)
    }
    return false
  }

  // Find expand button (CaretRight with title '展开详情')
  const expandBtns = findButtonsByTitle(tree, t('finding.expand'))
  assert.ok(expandBtns.length > 0, 'Expand button should be present')

  // Click expand
  expandBtns[0].props.onClick()

  // Re-render
  tree = render(SessionPane, { sessionId: 's-1' })

  // Verify full multi-line text is now present in the tree
  assert.ok(hasText(tree, 'const a = 10'), 'Expanded text must contain code block')

  // Now collapse button should be present
  const collapseBtns = findButtonsByTitle(tree, t('finding.collapse'))
  assert.ok(collapseBtns.length > 0, 'Collapse button should be present when expanded')
  collapseBtns[0].props.onClick()

  // Re-render
  tree = render(SessionPane, { sessionId: 's-1' })
  assert.equal(findButtonsByTitle(tree, t('finding.collapse')).length, 0, 'Collapse button should be gone after collapsing')
})

test('Thought numbering is sequential, stable across drag reordering, and backfilled if missing', async () => {
  const { React, render, flushEffects } = createHookRuntime()
  const f1 = createFindingRecord({ id: 'f-1', sessionId: 's-1', text: 'First card', submissionStatus: 'unsubmitted' })
  const f2 = createFindingRecord({ id: 'f-2', sessionId: 's-1', text: 'Second card', submissionStatus: 'unsubmitted' })
  // f1 and f2 intentionally lack thoughtNo to verify backfill

  const entriesStore = [f1, f2]
  const savedPuts = []

  const services = {
    t,
    store: {
      listEntries: async () => entriesStore,
      putEntry: async (e) => {
        savedPuts.push(e)
        const idx = entriesStore.findIndex(x => x.id === e.id)
        if (idx >= 0) entriesStore[idx] = e
        else entriesStore.push(e)
      },
      putEntries: async (wsKey, list) => {
        entriesStore.length = 0
        entriesStore.push(...list)
      },
      getGroups: async () => [],
      putGroup: async () => {},
      subscribe: () => () => {},
      quotaWarning: () => false,
    },
    index: {
      listRecent: async () => [],
      start: () => {},
      stop: () => {},
      track: async () => {},
    },
    submit: createSubmitService({ remote: { session: {} } }),
    createFinding: (args) => createFindingRecord(args),
    uuid: () => 'uuid-new',
  }

  const SessionPane = createSessionPane({ h, React, services })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  const tree = render(SessionPane, { sessionId: 's-1' })

  function getAllText(node) {
    if (!node) return ''
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(getAllText).join(' ')
    if (typeof node === 'object') return (node.children || []).map(getAllText).join(' ')
    return ''
  }

  const allText = getAllText(tree)
  assert.ok(allText.includes('#1'), 'First card should be assigned #1')
  assert.ok(allText.includes('#2'), 'Second card should be assigned #2')
  assert.ok(!allText.includes('#f-1'), 'Should not display slice of id')

  // Find drag drop nodes
  function findDraggableCards(node) {
    const res = []
    if (!node || typeof node !== 'object') return res
    if (node.props?.draggable) res.push(node)
    for (const child of node.children || []) {
      res.push(...findDraggableCards(child))
    }
    return res
  }

  const dragCards = findDraggableCards(tree)
  assert.equal(dragCards.length, 2, 'Should find 2 draggable cards')

  // Drag card 2 over card 1
  const transferData = new Map()
  const dataTransfer = {
    effectAllowed: '',
    setData: (k, v) => transferData.set(k, v),
    getData: (k) => transferData.get(k),
  }
  dragCards[1].props.onDragStart({ dataTransfer })
  await dragCards[0].props.onDrop({ preventDefault: () => {}, dataTransfer })

  // Re-render
  const reorderedTree = render(SessionPane, { sessionId: 's-1' })
  const reorderedText = getAllText(reorderedTree)

  // Card 2 was dragged to the top, so #2 should appear before #1 in the reordered output!
  assert.ok(reorderedText.indexOf('#2') < reorderedText.indexOf('#1'), 'Card #2 should now appear before Card #1 while keeping their stable thought numbers')
  assert.equal(entriesStore[0].thoughtNo, 2, 'Card 2 keeps thoughtNo 2')
  assert.equal(entriesStore[1].thoughtNo, 1, 'Card 1 keeps thoughtNo 1')
})

test('Expandable cards toggle from the whole card surface in both collapsed and expanded states', async () => {
  const { React, render, flushEffects } = createHookRuntime()

  const finding = createFindingRecord({
    id: 'f-toggle',
    sessionId: 's-1',
    title: 'Toggleable finding',
    text: 'const a = 10\nconst b = 20',
    severity: 'optimize',
    submissionStatus: 'unsubmitted',
  })
  // Domain records keep a single body field; a title lets the collapsed preview
  // differ from the full expanded body text.
  finding.title = 'Toggleable finding'

  const services = {
    t,
    store: {
      listEntries: async () => [finding],
      putEntry: async () => {},
      getGroups: async () => [],
      putGroup: async () => {},
      subscribe: () => () => {},
      quotaWarning: () => false,
    },
    index: { listRecent: async () => [] },
    submit: createSubmitService({ remote: { session: {} } }),
    createFinding: args => createFindingRecord(args),
    uuid: () => 'uuid-toggle',
  }

  const SessionPane = createSessionPane({ h, React, services })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  let tree = render(SessionPane, { sessionId: 's-1' })

  function hasText(node, str) {
    if (!node) return false
    if (typeof node === 'string') return node.includes(str)
    if (Array.isArray(node)) return node.some(child => hasText(child, str))
    if (typeof node === 'object') return hasText(node.children, str)
    return false
  }

  function findCardRoot(node) {
    if (!node || typeof node !== 'object') return null
    if (node.props?.key === 'f-toggle' && typeof node.props?.onClick === 'function') return node
    for (const child of node.children || []) {
      const found = findCardRoot(child)
      if (found) return found
    }
    return null
  }

  // Collapsed card keeps the full text hidden; the card surface itself is clickable.
  assert.equal(hasText(tree, 'const a = 10'), false)
  let card = findCardRoot(tree)
  assert.ok(card, 'finding card must expose a row-level click handler')
  assert.equal(card.props.style.cursor, 'grab')

  // Plain click anywhere on the collapsed card expands it (not just the caret button).
  card.props.onClick({ target: { closest: () => null } })
  tree = render(SessionPane, { sessionId: 's-1' })
  assert.ok(hasText(tree, 'const a = 10'), 'row-level click expands the card')

  // Clicking an inner control (button/checkbox/etc.) must not fold the card.
  card = findCardRoot(tree)
  card.props.onClick({ target: { closest: () => ({ tagName: 'BUTTON' }) } })
  tree = render(SessionPane, { sessionId: 's-1' })
  assert.ok(hasText(tree, 'const a = 10'), 'inner control clicks must not toggle the card')

  // Finishing a text selection must not fold the card either.
  globalThis.window = { getSelection: () => ({ toString: () => 'selected code' }) }
  try {
    card = findCardRoot(tree)
    card.props.onClick({ target: { closest: () => null } })
    tree = render(SessionPane, { sessionId: 's-1' })
    assert.ok(hasText(tree, 'const a = 10'), 'text selection clicks must not toggle the card')
  } finally {
    delete globalThis.window
  }

  // Plain click on the expanded card folds it back — same wide hit area as collapsed.
  card = findCardRoot(tree)
  card.props.onClick({ target: { closest: () => null } })
  tree = render(SessionPane, { sessionId: 's-1' })
  assert.equal(hasText(tree, 'const a = 10'), false, 'row-level click collapses the card again')
})

test('Active group header toggles from the whole header row, not only the caret button', async () => {
  const { React, render, flushEffects } = createHookRuntime()

  const group = createGroupRecord({ id: 'g-1', groupNumber: 1, sessionId: 's-1', workspaceId: 'session:s-1', items: [] })
  const services = {
    t,
    store: {
      listEntries: async () => [],
      putEntry: async () => {},
      getGroups: async () => [group],
      putGroup: async () => {},
      subscribe: () => () => {},
      quotaWarning: () => false,
    },
    index: { listRecent: async () => [] },
    submit: createSubmitService({ remote: { session: {} } }),
    createFinding: args => createFindingRecord(args),
    uuid: () => 'uuid-group-toggle',
  }

  const SessionPane = createSessionPane({ h, React, services })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  let tree = render(SessionPane, { sessionId: 's-1' })

  function textOf(node) {
    if (node === null || node === undefined || node === false) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join(' ')
    return (node.children ?? []).map(textOf).join(' ')
  }

  function findHeader(node) {
    if (!node || typeof node !== 'object') return null
    if (typeof node.props?.onClick === 'function' && node.props?.style?.cursor === 'pointer' && textOf(node).includes(t('group.title').replace('{number}', '1'))) return node
    for (const child of node.children || []) {
      const found = findHeader(child)
      if (found) return found
    }
    return null
  }

  // Groups start force-expanded while the global expand-all toggle is on.
  assert.ok(textOf(tree).includes(t('group.empty')), 'group starts expanded')
  let header = findHeader(tree)
  assert.ok(header, 'active group header must expose a row-level click handler')
  header.props.onClick({ target: { closest: () => null } })
  tree = render(SessionPane, { sessionId: 's-1' })
  assert.equal(textOf(tree).includes(t('group.empty')), false, 'clicking the header row collapses the group')

  header = findHeader(tree)
  header.props.onClick({ target: { closest: () => null } })
  tree = render(SessionPane, { sessionId: 's-1' })
  assert.ok(textOf(tree).includes(t('group.empty')), 'clicking the header row expands the group again')
})

test('Completing a finding records a real git footprint (P0-2 regression)', async () => {
  const { React, render, flushEffects } = createHookRuntime()
  const f1 = createFindingRecord({
    id: 'f-complete-1',
    sessionId: 's-1',
    text: 'Ship the hardening plan',
    submissionStatus: 'submitted',
    status: 'sent',
    workspaceId: 'ws-1',
    assignedGroupId: 'g-1',
  })
  const g1 = createGroupRecord({ id: 'g-1', groupNumber: 1, sessionId: 's-1', workspaceId: 'session:s-1', items: [{ findingId: 'f-complete-1', order: 1 }] })
  const entriesStore = [f1]
  const groupsStore = [g1]
  const fetchCalls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url))
    return { ok: true, json: async () => ({ gitBranch: 'main', gitCommit: 'abc1234' }) }
  }

  try {
    const services = {
      t,
      store: {
        listEntries: async () => entriesStore,
        putEntry: async (e) => {
          const idx = entriesStore.findIndex(x => x.id === e.id)
          if (idx >= 0) entriesStore[idx] = e
          else entriesStore.push(e)
        },
        getGroups: async () => groupsStore,
        putGroup: async (group) => {
          const idx = groupsStore.findIndex(x => x.id === group.id)
          if (idx >= 0) groupsStore[idx] = group
          else groupsStore.push(group)
        },
        subscribe: () => () => {},
        quotaWarning: () => false,
      },
      index: { listRecent: async () => [], start: () => {}, stop: () => {}, track: async () => {} },
      submit: createSubmitService({ remote: { session: {} } }),
      createFinding: (args) => createFindingRecord(args),
      uuid: () => 'uuid-complete-1',
      resolveWorkspaceId: () => 'ws-1',
    }
    const SessionPane = createSessionPane({ h, React, services })
    render(SessionPane, { sessionId: 's-1' })
    await flushEffects()
    const tree = render(SessionPane, { sessionId: 's-1' })

    function findCompleteButton(node) {
      if (!node || typeof node !== 'object') return null
      if (node.type === 'button' && node.props?.title === dicts.zh['finding.action.complete']) return node
      for (const child of node.children || []) {
        const found = findCompleteButton(child)
        if (found) return found
      }
      return null
    }
    const completeBtn = findCompleteButton(tree)
    assert.ok(completeBtn, 'submitted finding must expose a complete action')
    await completeBtn.props.onClick()
    await flushEffects()

    const stored = entriesStore.find(e => e.id === 'f-complete-1')
    assert.equal(stored.reviewStatus, 'resolved')
    assert.ok(stored.gitFootprint, 'gitFootprint must be written on completion')
    assert.equal(stored.gitFootprint.branch, 'main')
    assert.equal(stored.gitFootprint.commit, 'abc1234')
    // The distill maintenance-window poll also fetches (distill-run?workspaceId)
    // once on mount, so only the git-branch call matters here.
    const gitCalls = fetchCalls.filter(url => /git-branch\?workspaceId=ws-1/.test(url))
    assert.equal(gitCalls.length, 1)
    assert.equal(fetchCalls.length, gitCalls.length + 1, 'exactly one extra distill-run poll fetch')
    assert.ok(/distill-run\?workspaceId=/.test(fetchCalls.find(url => !/git-branch/.test(url)) || ''), 'lock poll present')
  } finally {
    globalThis.fetch = originalFetch
  }
})
