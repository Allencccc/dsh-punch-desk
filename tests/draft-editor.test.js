import test from 'node:test'
import assert from 'node:assert/strict'
import { DRAFTS_WORKSPACE_KEY } from '../src/domain/desk.js'
import { createDraftEditor } from '../src/client/ui/draft-editor.js'

const LABELS = {
  'desk.draft.new': 'New draft',
  'desk.draft.untitled': 'Untitled draft',
  'desk.draft.select': 'Pick a draft',
  'desk.draft.title': 'Title',
  'desk.draft.titlePlaceholder': 'Draft title',
  'desk.draft.body': 'Body',
  'desk.draft.bodyPlaceholder': 'Write an idea…',
  'desk.draft.status': 'Status',
  'desk.draft.visibility': 'Visibility',
  'desk.draft.visibilityGlobal': 'Global',
  'desk.draft.visibilityWorkspace': 'This workspace',
  'desk.draft.visibilityGlobalHint': 'Visible in every workspace',
  'desk.draft.visibilityWorkspaceHint': 'Visible only in the current workspace',
  'desk.draft.visibilityNeedsWorkspace': 'No workspace is available to scope this draft to.',
  'desk.draft.save': 'Save',
  'desk.draft.saved': 'Saved',
  'desk.draft.dirty': 'Unsaved',
  'desk.draft.delete': 'Delete',
  'desk.draft.confirmDelete': 'Confirm delete',
  'desk.draft.required': 'Write something before saving.',
  'desk.draft.error': 'Could not save.',
  'desk.draft.statusLocked': 'Status locked.',
  'desk.draft.start': 'Start session',
  'desk.draft.startEmpty': 'Body empty.',
  'desk.draft.startPrefilled': 'Prefilled.',
  'desk.draft.startManual': 'Manual.',
  'desk.draft.startNoWorkspace': 'No workspace.',
  'desk.draft.startUnavailable': 'Unavailable.',
  'desk.draft.startError': 'Start failed.',
  'desk.draft.cancelPrefill': 'Cancel prefill',
  'desk.draft.cancelPrefillDone': 'Prefill cancelled.',
  'draft.status.idea': 'Idea',
  'draft.status.ready': 'Ready',
  'draft.status.archived': 'Archived',
  'draft.status.prefilled': 'Prefilled',
  'draft.status.started': 'Started',
}
const t = key => LABELS[key] ?? key

function createHookRuntime() {
  const states = new Map()
  const refs = new Map()
  const effectFns = []
  let hookCursor = 0
  let effectCursor = 0
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
    useEffect(fn) {
      const index = effectCursor++
      if (!effectFns[index]) effectFns[index] = fn
    },
  }
  return {
    React,
    render(Component, props) {
      hookCursor = 0
      effectCursor = 0
      return Component(props)
    },
    runEffects() {
      return effectFns.filter(Boolean).map(fn => fn())
    },
  }
}

const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return node.children.map(textOf).join(' ')
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

function findAction(node, needle) {
  return findNode(node, item => typeof item.props?.onClick === 'function' && textOf(item).includes(needle))
}

/** Store double recording the writes a draft action makes. */
function createStore() {
  const calls = { puts: [], deletes: [], handoffs: [] }
  return {
    calls,
    async putEntry(entry) { calls.puts.push({ ...entry }) },
    async deleteEntry(workspaceKey, id) { calls.deletes.push([workspaceKey, id]) },
    async deleteHandoff(sessionId) { calls.handoffs.push(sessionId) },
  }
}

function draftOf(over = {}) {
  return {
    id: 'd1',
    schemaVersion: 1,
    kind: 'draft',
    workspaceKey: DRAFTS_WORKSPACE_KEY,
    title: 'Login fixes',
    body: '实现空密码校验',
    status: 'idea',
    createdAt: 10,
    updatedAt: 20,
    ...over,
  }
}

function mountEditor(draft, store, extra = {}, extraProps = {}) {
  const saved = []
  const deleted = []
  const services = { t, store, now: () => 1000, uuid: () => 'draft-1', ...extra }
  const runtime = createHookRuntime()
  const Editor = createDraftEditor({ h, React: runtime.React, services })
  const props = {
    draft,
    onSave: entry => saved.push(entry),
    onDelete: id => deleted.push(id),
    onNew: () => {},
    onCreate: entry => saved.push(entry),
    ...extraProps,
  }
  runtime.render(Editor, props)
  runtime.runEffects()
  return {
    runtime,
    Editor,
    props,
    saved,
    deleted,
    view: () => runtime.render(Editor, props),
  }
}

test('cancelling a prefilled draft clears the handoff and returns it to ready', async () => {
  const store = createStore()
  const draft = draftOf({ status: 'prefilled', sessionId: 's1' })
  const editor = mountEditor(draft, store)

  const cancel = findAction(editor.view(), 'Cancel prefill')
  assert.ok(cancel, 'expected a cancel-prefill action')
  await cancel.props.onClick()

  assert.deepEqual(store.calls.handoffs, ['s1'])
  assert.equal(store.calls.puts.length, 1)
  assert.equal(store.calls.puts[0].id, 'd1')
  assert.equal(store.calls.puts[0].status, 'ready')
  assert.equal('sessionId' in store.calls.puts[0], false)
  assert.equal(editor.saved.length, 1)
  assert.match(textOf(editor.view()), /Prefill cancelled/)
  assert.match(textOf(editor.view()), /Ready/)
})

test('cancelling a prefilled draft still persists when the form was cleared', async () => {
  const store = createStore()
  const draft = draftOf({ status: 'prefilled', sessionId: 's1' })
  const editor = mountEditor(draft, store)

  findNode(editor.view(), item => item.type === 'input' && item.props?.type === 'text')
    .props.onChange({ target: { value: '' } })
  findNode(editor.view(), item => item.type === 'textarea')
    .props.onChange({ target: { value: '' } })
  await findAction(editor.view(), 'Cancel prefill').props.onClick()

  assert.deepEqual(store.calls.handoffs, ['s1'])
  assert.equal(store.calls.puts.length, 1)
  assert.equal(store.calls.puts[0].body, '实现空密码校验')
  assert.equal(store.calls.puts[0].status, 'ready')
  assert.equal('sessionId' in store.calls.puts[0], false)
})

test('a started draft cannot be cancelled back to ready', () => {
  const store = createStore()
  const draft = draftOf({ status: 'started', sessionId: 's1', promptLogId: 'm1' })
  const editor = mountEditor(draft, store)
  assert.equal(findAction(editor.view(), 'Cancel prefill'), undefined)
})

test('deleting a prefilled draft also deletes its parked handoff', async () => {
  const store = createStore()
  const draft = draftOf({ status: 'prefilled', sessionId: 's1' })
  const editor = mountEditor(draft, store)

  await findAction(editor.view(), 'Delete').props.onClick()
  const confirm = findAction(editor.view(), 'Confirm delete')
  assert.ok(confirm, 'expected the second click to confirm the delete')
  await confirm.props.onClick()

  assert.deepEqual(store.calls.deletes, [[DRAFTS_WORKSPACE_KEY, 'd1']])
  assert.deepEqual(store.calls.handoffs, ['s1'])
  assert.deepEqual(editor.deleted, ['d1'])
})

test('saving an existing draft persists the edited form', async () => {
  const store = createStore()
  const draft = draftOf()
  const editor = mountEditor(draft, store)

  await findAction(editor.view(), 'Save').props.onClick()
  assert.equal(store.calls.puts.length, 1)
  assert.equal(store.calls.puts[0].title, 'Login fixes')
  assert.equal(store.calls.puts[0].body, '实现空密码校验')
  assert.equal(store.calls.puts[0].status, 'idea')
  assert.equal(editor.saved.length, 1)
  assert.match(textOf(editor.view()), /Saved/)
})

test('the canvas body flexes with the window and keeps the action toolbar pinned to the bottom', () => {
  const editor = mountEditor(draftOf(), createStore(), {}, { workspaceId: 'ws-a', workspaceName: 'Alpha' })
  const view = editor.view()

  // The root card participates in the desk's flex column instead of growing
  // with its content, so its height follows the viewport.
  assert.equal(view.props.style.height, '100%')
  assert.equal(view.props.style.display, 'flex')
  assert.equal(view.props.style.flexDirection, 'column')
  assert.equal(view.props.style.minHeight, 0)

  const textarea = findNode(view, item => item.type === 'textarea')
  assert.ok(textarea, 'expected the canvas body textarea')
  assert.equal(textarea.props.style.flex, 1)
  assert.equal(textarea.props.style.minHeight, 0)
  assert.equal(textarea.props.style.resize, 'none')

  const toolbar = findNode(view, item => item.props?.style?.borderTop && textOf(item).includes('Visibility'))
  assert.ok(toolbar, 'expected the visibility action toolbar')
  assert.equal(toolbar.props.style.flexShrink, 0)
})

test('the editor defaults legacy drafts to the global scope and offers both scopes', () => {
  const store = createStore()
  const editor = mountEditor(draftOf(), store, {}, { workspaceId: 'ws-a', workspaceName: 'Alpha' })
  const view = editor.view()
  const visibilitySelect = findNode(view, item => item.type === 'select' && item.props?.['aria-label'] === 'Visibility')
  assert.ok(visibilitySelect, 'expected a draft visibility select')
  assert.deepEqual(visibilitySelect.children.map(option => option.props.value), ['global', 'workspace'])
  assert.equal(visibilitySelect.props.value, 'global')
  // Both buttons are enabled because the desk supplied an active workspace.
  assert.equal(visibilitySelect.children[1].props.disabled, false)
})

test('the workspace scope is disabled when no workspace is available', () => {
  const store = createStore()
  const editor = mountEditor(draftOf(), store)
  const visibilitySelect = findNode(editor.view(), item => item.type === 'select' && item.props?.['aria-label'] === 'Visibility')
  assert.equal(visibilitySelect.children[1].props.disabled, true)
})

test('saving a draft as workspace-only persists its owning workspace', async () => {
  const store = createStore()
  const editor = mountEditor(draftOf(), store, {}, { workspaceId: 'ws-a', workspaceName: 'Alpha' })
  const visibilitySelect = findNode(editor.view(), item => item.type === 'select' && item.props?.['aria-label'] === 'Visibility')
  visibilitySelect.props.onChange({ target: { value: 'workspace' } })

  await findAction(editor.view(), 'Save').props.onClick()
  assert.equal(store.calls.puts.length, 1)
  assert.equal(store.calls.puts[0].visibility, 'workspace')
  assert.equal(store.calls.puts[0].workspaceId, 'ws-a')
  assert.match(textOf(editor.view()), /Saved/)
})

test('switching a workspace draft back to global clears its owning workspace', async () => {
  const store = createStore()
  const draft = draftOf({ visibility: 'workspace', workspaceId: 'ws-a' })
  const editor = mountEditor(draft, store, {}, { workspaceId: 'ws-a' })
  const visibilitySelect = findNode(editor.view(), item => item.type === 'select' && item.props?.['aria-label'] === 'Visibility')
  assert.equal(visibilitySelect.props.value, 'workspace')
  visibilitySelect.props.onChange({ target: { value: 'global' } })

  await findAction(editor.view(), 'Save').props.onClick()
  assert.equal(store.calls.puts.length, 1)
  assert.equal(store.calls.puts[0].visibility, 'global')
  assert.equal('workspaceId' in store.calls.puts[0], false)
})

test('the start action targets the workspace a scoped draft belongs to', async () => {
  const started = []
  const store = createStore()
  const draft = draftOf({ visibility: 'workspace', workspaceId: 'ws-a' })
  const editor = mountEditor(draft, store, {
    startFromDraft: async input => {
      started.push(input)
      return { ok: true, mode: input.behavior, sessionId: 's9' }
    },
  }, { workspaceId: 'ws-b', startBehavior: 'prefill' })

  await findAction(editor.view(), 'Start session').props.onClick()
  assert.equal(started.length, 1)
  assert.equal(started[0].workspaceId, 'ws-a')
})

test('a new draft defaults to the current workspace scope', async () => {
  const store = createStore()
  const editor = mountEditor(null, store, {}, { isNew: true, workspaceId: 'ws-a', workspaceName: 'Alpha' })
  const visibilitySelect = findNode(editor.view(), item => item.type === 'select' && item.props?.['aria-label'] === 'Visibility')
  assert.equal(visibilitySelect.props.value, 'workspace')

  findNode(editor.view(), item => item.type === 'input' && item.props?.type === 'text')
    .props.onChange({ target: { value: 'New scoped draft' } })
  findNode(editor.view(), item => item.type === 'textarea')
    .props.onChange({ target: { value: 'body' } })
  await findAction(editor.view(), 'Save').props.onClick()

  assert.equal(store.calls.puts.length, 1)
  assert.equal(store.calls.puts[0].visibility, 'workspace')
  assert.equal(store.calls.puts[0].workspaceId, 'ws-a')
})

test('a new draft falls back to the global scope without a workspace', () => {
  const store = createStore()
  const editor = mountEditor(null, store, {}, { isNew: true })
  const visibilitySelect = findNode(editor.view(), item => item.type === 'select' && item.props?.['aria-label'] === 'Visibility')
  assert.equal(visibilitySelect.props.value, 'global')
  assert.equal(visibilitySelect.children[1].props.disabled, true)
})

test('a new draft respects draftDefaultVisibility preference (Gate B)', () => {
  const store = createStore()
  const editor = mountEditor(null, store, {}, { isNew: true, workspaceId: 'ws-a', workspaceName: 'Alpha', defaultVisibility: 'global' })
  const visibilitySelect = findNode(editor.view(), item => item.type === 'select' && item.props?.['aria-label'] === 'Visibility')
  assert.equal(visibilitySelect.props.value, 'global')
})

test('the draft editor renders inline start hint according to startBehavior (Gate B)', () => {
  const store = createStore()
  const prefillEditor = mountEditor(draftOf(), store, {}, { startBehavior: 'prefill' })
  const prefillHint = findNode(prefillEditor.view(), item => item.props?.id === 'draftStartHint')
  assert.ok(prefillHint, 'start hint must be rendered')
  assert.equal(textOf(prefillHint), t('desk.canvas.startHintPrefill'))

  const autoEditor = mountEditor(draftOf(), store, {}, { startBehavior: 'auto' })
  const autoHint = findNode(autoEditor.view(), item => item.props?.id === 'draftStartHint')
  assert.ok(autoHint, 'start hint must be rendered')
  assert.equal(textOf(autoHint), t('desk.canvas.startHintAuto'))
})
