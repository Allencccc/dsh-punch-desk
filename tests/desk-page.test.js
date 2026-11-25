import test from 'node:test'
import assert from 'node:assert/strict'
import { DRAFTS_WORKSPACE_KEY } from '../src/domain/desk.js'
import { countText } from '../src/client/ui/bits.js'
import { createDeskPage } from '../src/client/ui/desk.js'
import { createDraftEditor } from '../src/client/ui/draft-editor.js'
import { createHookRuntime, h, textOf, findNode, findButtonByLabel } from './helpers/desk-harness.js'

const LABELS = {
  'desk.title': 'Punch Desk',
  'desk.tab.journal': 'Journal',
  'desk.tab.worklog': 'Work log',
  'desk.tab.reviews': 'Session reviews',
  'desk.section.drafts': 'Drafts',
  'desk.section.sessions': 'Sessions',
  'desk.session.archivedCount': 'Archived {count}',
  'desk.session.archivedHint': 'Archived in Harness',
  'session.archivedBadge': 'Archived',
  'session.archivedLocked': 'Archived session is locked.',
  'desk.draft.new': 'New draft',
  'desk.draft.untitled': 'Untitled draft',
  'desk.draft.empty': 'No drafts yet.',
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
  'desk.workspace.select': 'Workspace',
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
  'desk.draft.startAutoSent': 'The first prompt was sent automatically.',
  'desk.draft.cancelPrefill': 'Cancel prefill',
  'desk.draft.cancelPrefillDone': 'Prefill cancelled.',
  'desk.pref.autoStart': 'Send the first prompt automatically',
  'desk.pref.autoStartHint': 'Auto start hint.',
  'desk.pref.autoStartWarning': 'Automatic sending is on.',
  'desk.pref.saveError': 'Could not save the preference.',
  'desk.session.empty': 'No sessions yet.',
  'desk.session.untitled': 'Untitled session',
  'desk.session.findings': '{count} finding|{count} findings',
  'desk.session.openFindings': '{count} open',
  'desk.worklog.loading': 'Loading the work log…',
  'tab.placeholder': 'Punch Desk is initializing…',
  'store.quota': 'Quota exceeded.',
  'draft.status.idea': 'Idea',
  'draft.status.ready': 'Ready',
  'draft.status.archived': 'Archived',
  'draft.status.prefilled': 'Prefilled',
  'draft.status.started': 'Started',
  'desk.workspace.option': '{name}（{sessions} 会话 · {drafts} 草稿）',
}
const t = key => LABELS[key] ?? key

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, label) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error(`timed out waiting for ${label}`)
    await delay(2)
  }
}

function findAction(node, needle) {
  return findNode(node, item => typeof item.props?.onClick === 'function' && textOf(item).includes(needle))
}

function findCheckbox(node) {
  return findNode(node, item => item.type === 'input' && item.props?.type === 'checkbox')
}

function draftOf(id, over = {}) {
  return {
    id,
    schemaVersion: 1,
    kind: 'draft',
    workspaceKey: DRAFTS_WORKSPACE_KEY,
    title: id,
    body: `body ${id}`,
    status: 'idea',
    createdAt: 10,
    updatedAt: 20,
    ...over,
  }
}

/** In-memory store with revisions, notifications, and write recording. */
function createDeskStore(options = {}) {
  const entries = new Map([
    [DRAFTS_WORKSPACE_KEY, [
      draftOf('d3', { status: 'prefilled', sessionId: 's2', title: 'Prefilled draft', updatedAt: 300 }),
      draftOf('d2', { title: 'Second draft', updatedAt: 200 }),
      draftOf('d1', { title: 'Ship it', updatedAt: 100 }),
    ]],
    ['session:s1', [
      { id: 'f1', kind: 'finding', workspaceKey: 'session:s1', title: 'Login bug', status: 'open', createdAt: 100, updatedAt: 100 },
    ]],
    ['session:s2', []],
  ])
  const logs = new Map([
    ['session:s1', []],
    ['session:s2', [{ messageId: 'm2', sessionId: 's2', time: 9000, excerpt: 'prompt two' }]],
  ])
  const extraWorkspaces = Array.isArray(options.extraWorkspaces) ? options.extraWorkspaces : []
  const revisions = new Map()
  const reads = { entries: [], prompts: [], workspaces: 0 }
  const calls = { puts: [], deletes: [], prefs: [], handoffs: [], starts: [] }
  const listeners = new Set()
  let prefs = { startSessionBehavior: 'prefill' }

  const notify = () => {
    for (const listener of listeners) listener()
  }
  const bump = key => revisions.set(key, (revisions.get(key) ?? 0) + 1)

  return {
    reads,
    calls,
    async listWorkspaces() {
      reads.workspaces += 1
      return [DRAFTS_WORKSPACE_KEY, 'session:s1', 'session:s2', ...extraWorkspaces]
    },
    async listEntries(workspaceKey) {
      reads.entries.push(workspaceKey)
      return (entries.get(workspaceKey) ?? []).map(entry => ({ ...entry }))
    },
    async listPromptLog(workspaceKey) {
      reads.prompts.push(workspaceKey)
      return (logs.get(workspaceKey) ?? []).map(row => ({ ...row }))
    },
    revision(workspaceKey) {
      return revisions.get(workspaceKey) ?? 0
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async putEntry(entry) {
      calls.puts.push({ ...entry })
      const list = entries.get(entry.workspaceKey) ?? []
      entries.set(entry.workspaceKey, [...list.filter(item => item.id !== entry.id), { ...entry }])
      bump(entry.workspaceKey)
      notify()
    },
    async deleteEntry(workspaceKey, id) {
      calls.deletes.push([workspaceKey, id])
      const list = entries.get(workspaceKey) ?? []
      entries.set(workspaceKey, list.filter(item => item.id !== id))
      bump(workspaceKey)
      notify()
    },
    async getPrefs() {
      return { ...prefs }
    },
    async setPrefs(next) {
      calls.prefs.push({ ...next })
      prefs = next
    },
    async deleteHandoff(sessionId) {
      calls.handoffs.push(sessionId)
    },
    async startFromDraft(input) {
      calls.starts.push(input)
      return { ok: true, mode: input.behavior, sessionId: 's9' }
    },
    canOpenSession() {
      return false
    },
    emit() {
      notify()
    },
    bumpRevision(key) {
      bump(key)
    },
  }
}

test('DeskPage loads, reuses revision cache, toggles prefs, and starts from the selected draft', async () => {
  const store = createDeskStore()
  const services = {
    store,
    t,
    uuid: () => 'generated-1',
    backfillSession: async () => ({ ok: true }),
    startFromDraft: input => store.startFromDraft(input),
    canOpenSession: () => false,
  }
  const runtime = createHookRuntime()
  const DeskPage = createDeskPage({ h, React: runtime.React, services })
  const view = () => runtime.render(DeskPage, { defaultTab: 'canvas' })

  assert.match(textOf(view()), /Punch Desk is initializing/)
  await runtime.runEffects()
  await waitFor(() => textOf(view()).includes('Prefilled draft'), 'initial load')

  // Sessions are ordered by prompt-log activity: s2 has a 9000 ms prompt row,
  // while s1 only has a 100 ms finding.
  let text = textOf(view())
  assert.ok(text.indexOf('s2 0 findings') < text.indexOf('s1 1 finding'), 'recent prompt session first')
  assert.match(text, /0 findings/)
  assert.match(text, /1 finding/)

  // Prefs keep the safe prefill default.

  // No revision moved: the store notification rereads nothing.
  const entryReadsBefore = [...store.reads.entries]
  const promptReadsBefore = [...store.reads.prompts]
  store.emit()
  await delay(10)
  assert.deepEqual(store.reads.entries, entryReadsBefore)
  assert.deepEqual(store.reads.prompts, promptReadsBefore)

  // Only the bumped session is re-read; its cached draft/sibling stay put.
  store.bumpRevision('session:s2')
  store.emit()
  await waitFor(
    () => store.reads.entries.filter(key => key === 'session:s2').length > entryReadsBefore.filter(key => key === 'session:s2').length,
    'session revision refresh',
  )
  assert.equal(
    store.reads.entries.filter(key => key === 'session:s1').length,
    entryReadsBefore.filter(key => key === 'session:s1').length,
  )
  assert.equal(
    store.reads.prompts.filter(key => key === 'session:s1').length,
    promptReadsBefore.filter(key => key === 'session:s1').length,
  )

  await runtime.runEffects()

  await waitFor(() => {
    const editor = findNode(view(), item => typeof item.type === 'function' && item.props?.draft)
    return editor?.props.draft.id === 'd3'
  }, 'newest draft selection')

  // Removing the selected draft falls back to the next newest one.
  await store.deleteEntry(DRAFTS_WORKSPACE_KEY, 'd3')
  await waitFor(() => !textOf(view()).includes('Prefilled draft'), 'draft removal')
  await runtime.runEffects()
  let editor = findNode(view(), item => typeof item.type === 'function' && item.props?.draft)
  assert.equal(editor.props.draft.id, 'd2')

  // Draft save is wired to the store through the editor the desk renders.
  const editorRuntime = createHookRuntime()
  const Editor = createDraftEditor({ h, React: editorRuntime.React, services })
  editorRuntime.render(Editor, editor.props)
  await editorRuntime.runEffects()
  await findAction(editorRuntime.render(Editor, editor.props), 'Save').props.onClick()
  assert.ok(store.calls.puts.some(entry => entry.id === 'd2'))

  // Draft delete removes it and the desk selection falls back to d1.
  let editorView = editorRuntime.render(Editor, editor.props)
  await findAction(editorView, 'Delete').props.onClick()
  const confirmDelete = findAction(editorRuntime.render(Editor, editor.props), 'Confirm delete')
  assert.ok(confirmDelete, 'expected the second click to confirm the delete')
  await confirmDelete.props.onClick()
  assert.ok(store.calls.deletes.some(([workspaceKey, id]) => workspaceKey === DRAFTS_WORKSPACE_KEY && id === 'd2'))
  await waitFor(() => !textOf(view()).includes('Second draft'), 'draft delete refresh')
  await runtime.runEffects()
  editor = findNode(view(), item => typeof item.type === 'function' && item.props?.draft)
  assert.equal(editor.props.draft.id, 'd1')
  assert.equal(editor.props.startBehavior, 'prefill')

  // Start uses the selected draft and prefill behavior.
  const startRuntime = createHookRuntime()
  const StartEditor = createDraftEditor({ h, React: startRuntime.React, services })
  startRuntime.render(StartEditor, editor.props)
  await startRuntime.runEffects()
  await findAction(startRuntime.render(StartEditor, editor.props), 'Start session').props.onClick()
  assert.equal(store.calls.starts.length, 1)
  assert.equal(store.calls.starts[0].draft.id, 'd1')
  assert.equal(store.calls.starts[0].behavior, 'prefill')

  runtime.unmount()
})

test('DeskPage discovers host workspaces and isolates session lists per workspace', async () => {
  const store = createDeskStore({
    entries: [
      {
        key: 'session:s-dsh',
        items: [
          { id: 'f-1', kind: 'finding', sessionId: 's-dsh', workspaceKey: 'session:s-dsh', workspaceId: 'dsh-plugins', text: 'Finding for dsh', submissionStatus: 'submitted' },
        ],
      },
      {
        key: 'session:s-xiehe',
        items: [
          { id: 'f-2', kind: 'finding', sessionId: 's-xiehe', workspaceKey: 'session:s-xiehe', workspaceId: 'xiehe', text: 'Finding for xiehe', submissionStatus: 'submitted' },
        ],
      },
    ],
  })

  const services = {
    store,
    t,
    uuid: () => 'uuid-1',
    backfillSession: async () => ({ ok: true }),
    startFromDraft: input => store.startFromDraft(input),
    canOpenSession: () => false,
  }

  const mockWorkspaces = {
    items: [
      { workspaceId: 'dsh-plugins', name: 'dsh-plugins', sessionIds: ['s1'] },
      { workspaceId: 'xiehe', name: 'xiehe', sessionIds: ['s2'] },
    ],
    activeWorkspaceId: 'dsh-plugins',
  }

  const mockSessions = {
    byId: {
      s1: { id: 's1', title: 'DSH Session', workspaceId: 'dsh-plugins', updatedAt: 100 },
      s2: { id: 's2', title: 'Xiehe Session', workspaceId: 'xiehe', updatedAt: 200 },
    },
  }

  const useWorkspaces = (selector) => (typeof selector === 'function' ? selector(mockWorkspaces) : mockWorkspaces)
  useWorkspaces.items = mockWorkspaces.items
  const useSessions = (selector) => (typeof selector === 'function' ? selector(mockSessions) : mockSessions)
  useSessions.byId = mockSessions.byId

  const runtime = createHookRuntime()
  const DeskPage = createDeskPage({ h, React: runtime.React, services })
  const view = () => runtime.render(DeskPage, { useWorkspaces, useSessions })

  view()
  await runtime.runEffects()
  await waitFor(() => !textOf(view()).includes('initializing'), 'desk loaded')

  const rendered = view()

  // Find workspace select dropdown
  const selectNode = findNode(rendered, item => item.type === 'select' && item.props?.['aria-label'])
  assert.ok(selectNode, 'Workspace select dropdown must exist')

  // Both workspaces must be options in the select dropdown
  const options = (selectNode.children || []).filter(c => c && c.type === 'option')
  const optionValues = options.map(o => o.props?.value)
  assert.ok(optionValues.includes('dsh-plugins'), 'dsh-plugins option must be in dropdown')
  assert.ok(optionValues.includes('xiehe'), 'xiehe option must be in dropdown')

  // Default active workspace is dsh-plugins -> should see DSH Session and NOT Xiehe Session
  const textDefault = textOf(rendered)
  assert.ok(textDefault.includes('DSH Session'), 'DSH Session must be visible under dsh-plugins')
  assert.ok(!textDefault.includes('Xiehe Session'), 'Xiehe Session must NOT leak into dsh-plugins')

  // Switch workspace to xiehe
  await selectNode.props.onChange({ target: { value: 'xiehe' } })
  await runtime.runEffects()

  const renderedXiehe = view()
  const textXiehe = textOf(renderedXiehe)
  assert.ok(textXiehe.includes('Xiehe Session'), 'Xiehe Session must be visible under xiehe')
  assert.ok(!textXiehe.includes('DSH Session'), 'DSH Session must NOT leak into xiehe')

  runtime.unmount()
})

test('countText understands English singular and plural forms', () => {
  assert.equal(countText('{count} finding|{count} findings', 1), '1 finding')
  assert.equal(countText('{count} finding|{count} findings', 2), '2 findings')
  assert.equal(countText('{count} 条发现', 2), '2 条发现')
})

test('DeskPage scopes drafts to the active workspace while keeping global drafts visible', async () => {
  const store = createDeskStore()
  // Drop the seeded legacy drafts so the workspace counts below are exact.
  for (const id of ['d1', 'd2', 'd3']) await store.deleteEntry(DRAFTS_WORKSPACE_KEY, id)
  await store.putEntry(draftOf('d-global', { title: 'Shared idea', updatedAt: 400 }))
  await store.putEntry(draftOf('d-alpha', {
    title: 'Alpha only', updatedAt: 500, visibility: 'workspace', workspaceId: 'ws-a',
  }))
  await store.putEntry(draftOf('d-beta', {
    title: 'Beta only', updatedAt: 600, visibility: 'workspace', workspaceId: 'ws-b',
  }))

  const services = {
    store,
    t,
    uuid: () => 'uuid-1',
    backfillSession: async () => ({ ok: true }),
    startFromDraft: input => store.startFromDraft(input),
    canOpenSession: () => false,
  }

  const mockWorkspaces = {
    items: [
      { workspaceId: 'ws-a', name: 'Alpha', sessionIds: ['s1'] },
      { workspaceId: 'ws-b', name: 'Beta', sessionIds: ['s2'] },
    ],
    activeWorkspaceId: 'ws-a',
  }
  const useWorkspaces = selector => (typeof selector === 'function' ? selector(mockWorkspaces) : mockWorkspaces)
  useWorkspaces.items = mockWorkspaces.items

  const runtime = createHookRuntime()
  const DeskPage = createDeskPage({ h, React: runtime.React, services })
  const view = () => runtime.render(DeskPage, { useWorkspaces, defaultTab: 'canvas' })

  view()
  await runtime.runEffects()
  await waitFor(() => !textOf(view()).includes('initializing'), 'desk loaded')
  await runtime.runEffects()

  // Active workspace is Alpha: shared + Alpha-only drafts are listed, the Beta draft is hidden.
  let text = textOf(view())
  assert.ok(text.includes('Shared idea'), 'the global draft must be visible in Alpha')
  assert.ok(text.includes('Alpha only'), 'the Alpha workspace draft must be visible in Alpha')
  assert.ok(!text.includes('Beta only'), 'the Beta workspace draft must NOT leak into Alpha')

  // The canvas editor is bound to the active workspace, so a new draft
  // created from it defaults to the "this workspace" visibility.
  const editorNode = findNode(view(), item => typeof item.type === 'function' && item.props?.draft)
  assert.equal(editorNode.props.workspaceId, 'ws-a')

  // Each workspace option counts only the drafts visible in that workspace.
  const selectNode = findNode(view(), item => item.type === 'select' && item.props?.['aria-label'] === 'Workspace')
  assert.ok(selectNode, 'workspace select must exist')
  const alphaOption = (selectNode.children || []).find(child => child?.props?.value === 'ws-a')
  const betaOption = (selectNode.children || []).find(child => child?.props?.value === 'ws-b')
  assert.match(textOf(alphaOption), /2 草稿/, 'Alpha counts the shared draft plus its own')
  assert.match(textOf(betaOption), /2 草稿/, 'Beta counts the shared draft plus its own')

  // Switching to Beta swaps the visible workspace-scoped draft.
  await selectNode.props.onChange({ target: { value: 'ws-b' } })
  await runtime.runEffects()
  text = textOf(view())
  assert.ok(text.includes('Shared idea'), 'the global draft must still be visible in Beta')
  assert.ok(text.includes('Beta only'), 'the Beta workspace draft must be visible in Beta')
  assert.ok(!text.includes('Alpha only'), 'the Alpha workspace draft must NOT leak into Beta')

  runtime.unmount()
})

test('DeskPage hides sessions archived in Harness and surfaces the archived count', async () => {
  const store = createDeskStore()
  const services = {
    store,
    t,
    uuid: () => 'uuid-1',
    backfillSession: async () => ({ ok: true }),
    startFromDraft: input => store.startFromDraft(input),
    canOpenSession: () => false,
    getArchivedSessionIds: () => ['s2'],
    subscribeWorkspaceSnapshot: () => () => {},
  }

  const mockWorkspaces = {
    items: [{ workspaceId: 'dsh-plugins', name: 'dsh-plugins', sessionIds: ['s1', 's2'] }],
    activeWorkspaceId: 'dsh-plugins',
    archivedSessionIds: ['s2'],
  }
  const mockSessions = {
    byId: {
      s1: { id: 's1', title: 'Active Session', workspaceId: 'dsh-plugins', updatedAt: 100 },
      s2: { id: 's2', title: 'Archived Session', workspaceId: 'dsh-plugins', updatedAt: 200 },
    },
  }
  const useWorkspaces = selector => (typeof selector === 'function' ? selector(mockWorkspaces) : mockWorkspaces)
  useWorkspaces.items = mockWorkspaces.items
  const useSessions = selector => (typeof selector === 'function' ? selector(mockSessions) : mockSessions)
  useSessions.byId = mockSessions.byId

  const runtime = createHookRuntime()
  const DeskPage = createDeskPage({ h, React: runtime.React, services })
  const view = () => runtime.render(DeskPage, { useWorkspaces, useSessions, defaultTab: 'dashboard' })

  view()
  await runtime.runEffects()
  await waitFor(() => !textOf(view()).includes('initializing'), 'desk loaded')
  await runtime.runEffects()
  const rendered = view()
  const text = textOf(rendered)

  assert.ok(text.includes('Active Session'), 'active sessions must stay visible')
  assert.ok(!text.includes('Archived Session'), 'archived sessions must be hidden by default')
  assert.match(text, /Archived 1/, 'the archived count badge must show the hidden session')

  // The workspace switcher's per-workspace session count excludes archived rows.
  const selectNode = findNode(rendered, item => item.type === 'select' && item.props?.['aria-label'] === 'Workspace')
  assert.ok(selectNode, 'workspace select must exist')
  const option = (selectNode.children || []).find(child => child?.props?.value === 'dsh-plugins')
  assert.match(textOf(option), /1 会话/, 'the workspace count must exclude the archived session')

  runtime.unmount()
})

test('DeskPage hides a store session key whose rows were all deleted', async () => {
  // The Desk derives its session list from the plugin store's workspace index,
  // not from the Harness session tree. A key that outlived its rows (the last
  // finding / prompt-log row was deleted) used to render as an untitled card
  // labelled with the raw Harness session id; it must be filtered out instead.
  const store = createDeskStore({ extraWorkspaces: ['session:s-phantom'] })
  const services = {
    store,
    t,
    uuid: () => 'uuid-1',
    backfillSession: async () => ({ ok: true }),
    startFromDraft: input => store.startFromDraft(input),
    canOpenSession: () => false,
  }

  const mockWorkspaces = {
    items: [{ workspaceId: 'dsh-plugins', name: 'dsh-plugins', sessionIds: ['s1', 's2'] }],
    activeWorkspaceId: 'dsh-plugins',
  }
  const mockSessions = {
    byId: {
      s1: { id: 's1', title: 'Real Session', workspaceId: 'dsh-plugins', updatedAt: 100, blank: false },
      s2: { id: 's2', title: 'Prompt Session', workspaceId: 'dsh-plugins', updatedAt: 200, blank: false },
    },
  }
  const useWorkspaces = selector => (typeof selector === 'function' ? selector(mockWorkspaces) : mockWorkspaces)
  useWorkspaces.items = mockWorkspaces.items
  const useSessions = selector => (typeof selector === 'function' ? selector(mockSessions) : mockSessions)
  useSessions.byId = mockSessions.byId

  const runtime = createHookRuntime()
  const DeskPage = createDeskPage({ h, React: runtime.React, services })
  const view = () => runtime.render(DeskPage, { useWorkspaces, useSessions })
  view()
  await runtime.runEffects()
  await waitFor(() => !textOf(view()).includes('initializing'), 'desk loaded')
  await runtime.runEffects()
  const text = textOf(view())

  assert.ok(text.includes('Real Session'), 'a session with data stays visible')
  assert.equal(text.includes('s-phantom'), false, 'an empty session key must not render as a raw-id card')
  const selectNode = findNode(view(), item => item.type === 'select' && item.props?.['aria-label'] === 'Workspace')
  const option = (selectNode.children || []).find(child => child?.props?.value === 'dsh-plugins')
  assert.match(textOf(option), /2 会话/, 'the empty session key must not inflate the workspace count')

  runtime.unmount()
})

test('DeskPage left-rail sections fold from the whole header row', async () => {
  // Same Session Pane pattern as the dashboard sections: the drafts and
  // sessions rails fold when the title row is clicked, while the "new draft"
  // button and other inner controls keep their own click.
  const store = createDeskStore()
  const services = {
    store,
    t,
    uuid: () => 'uuid-1',
    backfillSession: async () => ({ ok: true }),
    startFromDraft: input => store.startFromDraft(input),
    canOpenSession: () => false,
  }
  const runtime = createHookRuntime()
  const DeskPage = createDeskPage({ h, React: runtime.React, services })
  const view = () => runtime.render(DeskPage, { defaultTab: 'dashboard' })
  const sectionHeader = key => findNode(view(), node => node.props?.['data-desk-section'] === key)

  view()
  await runtime.runEffects()
  await waitFor(() => !textOf(view()).includes('initializing'), 'desk loaded')

  const railBody = key => findNode(view(), node => node.props?.['data-desk-rail-body'] === key)
  assert.ok(railBody('drafts'), 'draft cards start visible')
  const draftsHeader = sectionHeader('drafts')
  assert.ok(draftsHeader, 'the drafts rail header renders as a fold control')
  assert.equal(typeof draftsHeader.props.onClick, 'function',
    'the whole drafts header toggles the section')

  draftsHeader.props.onClick({})
  assert.equal(railBody('drafts'), undefined,
    'clicking the drafts title folds the draft cards')

  // An inner control (the "new draft" button) must not fold the section.
  sectionHeader('drafts').props.onClick({ target: { closest: () => ({ tagName: 'BUTTON' }) } })
  assert.equal(railBody('drafts'), undefined,
    'inner controls keep their own click and never toggle the rail')

  sectionHeader('drafts').props.onClick({})
  assert.ok(railBody('drafts'), 'clicking the title again expands the drafts rail')

  assert.ok(railBody('sessions'), 'session cards start visible')
  const sessionsHeader = sectionHeader('sessions')
  assert.ok(sessionsHeader, 'the sessions rail header renders as a fold control')
  sessionsHeader.props.onClick({})
  assert.equal(railBody('sessions'), undefined,
    'clicking the sessions title folds the session cards')
  sectionHeader('sessions').props.onClick({})
  assert.ok(railBody('sessions'), 'clicking the title again expands the sessions rail')

  runtime.unmount()
})

test('DeskPage surfaces an active distillation batch in every tab', async () => {
  const store = createDeskStore()
  const services = {
    store,
    t,
    uuid: () => 'generated-1',
    backfillSession: async () => ({ ok: true }),
    startFromDraft: input => store.startFromDraft(input),
    canOpenSession: () => false,
  }
  const runtime = createHookRuntime()
  const DeskPage = createDeskPage({ h, React: runtime.React, services })
  const originalFetch = globalThis.fetch
  const runs = [{ workspaceId: 'ws-1', status: 'ready', stage: 'stage2', progress: { log: [] } }]
  globalThis.fetch = async (url, init) => (String(url).includes('api/punch-desk/distill-run')
    ? { ok: true, json: async () => ({ ok: true, runs }) }
    : originalFetch(url, init))
  try {
    const view = () => runtime.render(DeskPage, { defaultTab: 'dashboard', workspaceId: 'ws-1' })
    view()
    await runtime.runEffects()
    await waitFor(() => textOf(view()).includes('distill.banner.ready'), 'distillation banner')

    const bannerView = view()
    assert.ok(textOf(bannerView).includes('distill.banner.submitPaused'), 'banner states why submission is paused')
    // The reviews tab carries the persistent indicator, independent of the banner.
    const breathing = findNode(bannerView, item => item.props?.className === 'pd-breathe')
    assert.ok(breathing, 'the reviews tab keeps a breathing run indicator')

    findButtonByLabel(bannerView, 'distill.banner.dismiss')?.props.onClick()
    const dismissed = view()
    assert.ok(!textOf(dismissed).includes('distill.banner.ready'), 'the banner can be dismissed')
  } finally {
    runtime.unmount()
    globalThis.fetch = originalFetch
  }
})

test('DeskPage stays quiet when no distillation batch is active', async () => {
  const store = createDeskStore()
  const services = {
    store,
    t,
    uuid: () => 'generated-1',
    backfillSession: async () => ({ ok: true }),
    startFromDraft: input => store.startFromDraft(input),
    canOpenSession: () => false,
  }
  const runtime = createHookRuntime()
  const DeskPage = createDeskPage({ h, React: runtime.React, services })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => (String(url).includes('api/punch-desk/distill-run')
    ? { ok: true, json: async () => ({ ok: true, runs: [] }) }
    : originalFetch(url, init))
  try {
    const view = () => runtime.render(DeskPage, { defaultTab: 'dashboard', workspaceId: 'ws-1' })
    view()
    await runtime.runEffects()
    await waitFor(() => !textOf(view()).includes('initializing'), 'desk loaded')
    const text = textOf(view())
    assert.ok(!text.includes('distill.banner.ready'), 'no banner without a ready run')
    assert.ok(!text.includes('distill.banner.running'), 'no banner without a running batch')
    assert.equal(findNode(view(), item => item.props?.className === 'pd-breathe'), undefined, 'no idle indicator')
  } finally {
    runtime.unmount()
    globalThis.fetch = originalFetch
  }
})

test('DeskPage dashboard sections are iconised and collapsible', async () => {
  const store = createDeskStore()
  const services = {
    store,
    t,
    uuid: () => 'generated-1',
    backfillSession: async () => ({ ok: true }),
    startFromDraft: input => store.startFromDraft(input),
    canOpenSession: () => false,
  }
  const runtime = createHookRuntime()
  const DeskPage = createDeskPage({ h, React: runtime.React, services })
  const view = () => runtime.render(DeskPage, { defaultTab: 'dashboard', workspaceId: 'ws-1' })
  view()
  await runtime.runEffects()
  await waitFor(() => !textOf(view()).includes('initializing'), 'desk loaded')

  const expandedToggles = () => {
    const found = []
    const walk = node => {
      if (!node || typeof node !== 'object') return
      if (node.props?.['aria-expanded'] === true) found.push(node)
      for (const child of node.children ?? []) walk(child)
    }
    walk(view())
    return found
  }

  const before = expandedToggles()
  assert.ok(before.length >= 2, 'dashboard section headers expose collapse toggles')
  assert.ok(textOf(view()).includes('近期会话流') || textOf(view()).includes('dashboard.recentSessions'),
    'the recent-sessions section header still renders')
  assert.ok(!textOf(view()).includes('desk.section.sessionDigest'),
    'the standalone session digest panel is gone (product decision C)')

  // Drive one dashboard section's own caret; the desk rails now expose their
  // own collapse buttons, so `before[0]` is no longer guaranteed to be one.
  const sectionHeader = key => findNode(view(), node => node.props?.['data-dashboard-section'] === key)
  const sectionToggle = key => {
    const header = sectionHeader(key)
    return header === undefined ? undefined : findNode(header, node => node.props?.['aria-expanded'] === true)
  }
  const recentToggle = sectionToggle('recent')
  assert.ok(recentToggle, 'a dashboard section exposes its own caret toggle')
  recentToggle.props.onClick()
  const after = expandedToggles()
  assert.equal(after.length, before.length - 1, 'clicking a section toggle collapses that section')

  // Like the Session Pane group header, the whole section header row is the
  // hit target — the title text must fold the panel, not only the caret.
  const recentHeader = sectionHeader('recent')
  assert.ok(recentHeader, 'dashboard section headers render as clickable rows')
  assert.equal(typeof recentHeader.props.onClick, 'function',
    'the whole section header toggles the panel')

  const collapsedCount = after.length
  // The row toggles the current state: the caret click above collapsed it, so
  // the first title click expands it again.
  recentHeader.props.onClick({})
  assert.equal(expandedToggles().length, collapsedCount + 1,
    'clicking the title row toggles the section')

  // A click that belongs to an inner control (new-draft button, caret, link)
  // must not toggle the surrounding section.
  sectionHeader('recent').props.onClick({ target: { closest: () => ({ tagName: 'BUTTON' }) } })
  assert.equal(expandedToggles().length, collapsedCount + 1,
    'inner controls keep their own click and never double-toggle the section')

  sectionHeader('recent').props.onClick({})
  assert.equal(expandedToggles().length, collapsedCount,
    'clicking the title row again collapses the section')
  runtime.unmount()
})
