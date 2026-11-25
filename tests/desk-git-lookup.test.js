import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeskPage } from '../src/client/ui/desk.js'
import { dictionaries } from '../src/locale.js'
import { formatLocalDateTime } from '../src/client/ui/bits.js'
import {
  createDeskHarness,
  findButtonByAria,
  findInputByPlaceholder,
  findButtonByLabel,
  findNode,
  textOf,
} from './helpers/desk-harness.js'

const dicts = dictionaries()

test('desk header lookup calls services.git.lookup and opens a result session', async () => {
  const t = key => key
  const calls = []
  const services = {
    store: {
      subscribe: () => () => {},
      readRevision: () => 1,
      listEntries: async () => [],
      listPromptLog: async () => [],
      listWorkspaceRecords: async () => [],
      getPrefs: async () => ({}),
    },
    t: key => key,
    getCurrentWorkspaceId: () => 'ws1',
    git: {
      lookup: async (workspaceId, hash) => {
        calls.push({ workspaceId, hash })
        return {
          matches: [
            {
              traceId: 'r1#1',
              sessionId: 's1',
              commit: { hash: 'abcdef0123', shortHash: 'abcdef0', subject: 'feat: x' },
              findingIds: [],
              capturedAt: 1,
            },
          ],
        }
      },
    },
    canOpenSession: () => true,
    openSession: sessionId => {
      calls.push({ openSession: sessionId })
      return true
    },
    setPendingCommitFocus: (sessionId, payload) => {
      calls.push({ pendingFocus: { sessionId, payload } })
    },
  }
  const harness = createDeskHarness({ services })
  const DeskPage = createDeskPage({ h: harness.h, React: harness.React, services })
  const view = () => harness.runtime.render(DeskPage, { defaultTab: 'dashboard' })
  view()
  await harness.flush()
  let tree = view()

  const open = findButtonByAria(tree, t('desk.gitLookup.title'))
  assert.ok(open, 'desk header must expose the git lookup button')
  await open.props.onClick()
  tree = view()
  const input = findInputByPlaceholder(tree, t('desk.gitLookup.placeholder'))
  assert.ok(input)
  input.props.onChange({ target: { value: 'abcdef0' } })
  input.props.onKeyDown({ key: 'Enter', preventDefault() {} })
  await harness.flush()

  assert.deepEqual(calls[0], { workspaceId: 'ws1', hash: 'abcdef0' })
  tree = view()
  const result = findButtonByLabel(tree, /feat: x/)
  assert.ok(result)
  await result.props.onClick()
  assert.deepEqual(calls.at(-1), {
    pendingFocus: {
      sessionId: 's1',
      payload: {
        traceId: 'r1#1',
        commitHash: 'abcdef0123',
        shortHash: 'abcdef0',
        findingIds: [],
        turn: undefined,
      },
    },
  })
})

test('desk header lookup validates hex input, handles empty/failed states, and supports button trigger', async () => {
  const t = key => key
  const calls = []
  let mode = 'empty'
  const services = {
    store: {
      subscribe: () => () => {},
      readRevision: () => 1,
      listEntries: async () => [],
      listPromptLog: async () => [],
      listWorkspaceRecords: async () => [],
      getPrefs: async () => ({}),
    },
    t,
    getCurrentWorkspaceId: () => 'ws1',
    git: {
      lookup: async (workspaceId, hash) => {
        calls.push({ workspaceId, hash })
        if (mode === 'fail') throw new Error('network error')
        return { matches: [] }
      },
    },
    canOpenSession: () => true,
  }
  const harness = createDeskHarness({ services })
  const DeskPage = createDeskPage({ h: harness.h, React: harness.React, services })
  const view = () => harness.runtime.render(DeskPage, { defaultTab: 'dashboard' })
  view()
  await harness.flush()
  let tree = view()

  const open = findButtonByAria(tree, t('desk.gitLookup.title'))
  await open.props.onClick()
  tree = view()

  let focused = false
  const input = findInputByPlaceholder(tree, t('desk.gitLookup.placeholder'))
  input.props.ref?.({ focus: () => { focused = true } })
  await harness.flush()
  assert.equal(focused, true, 'input ref should focus when popover is open')

  // 1. Invalid inputs (empty, too short, non-hex) -> desk.gitLookup.invalid without calling lookup
  input.props.onChange({ target: { value: '12345' } })
  input.props.onKeyDown({ key: 'Enter', preventDefault() {} })
  await harness.flush()
  tree = view()
  assert.equal(calls.length, 0)
  assert.ok(textOf(tree).includes('desk.gitLookup.invalid'))

  input.props.onChange({ target: { value: 'zzzzzzz' } })
  const submitBtn = findNode(tree, n => n.props?.['data-action'] === 'git-lookup-submit')
  assert.ok(submitBtn)
  await submitBtn.props.onClick()
  await harness.flush()
  tree = view()
  assert.equal(calls.length, 0)
  assert.ok(textOf(tree).includes('desk.gitLookup.invalid'))

  // 2. Valid hex but empty matches -> desk.gitLookup.empty
  mode = 'empty'
  input.props.onChange({ target: { value: 'deadbeef' } })
  await submitBtn.props.onClick()
  await harness.flush()
  tree = view()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { workspaceId: 'ws1', hash: 'deadbeef' })
  assert.ok(textOf(tree).includes('desk.gitLookup.empty'))
  assert.ok(!textOf(tree).includes('desk.gitLookup.invalid'))

  // 3. Lookup failure -> desk.gitLookup.failed
  mode = 'fail'
  input.props.onChange({ target: { value: 'cafebabe' } })
  input.props.onKeyDown({ key: 'Enter', preventDefault() {} })
  await harness.flush()
  tree = view()
  assert.equal(calls.length, 2)
  assert.ok(textOf(tree).includes('desk.gitLookup.failed'))
})

test('desk header lookup falls back to store.lookupCommitTraces, formats resultMeta/capturedAt, and clears on workspace switch', async () => {
  const t = key => dicts.en[key] ?? key
  const storeCalls = []
  const openCalls = []
  let canOpen = false
  const services = {
    store: {
      subscribe: () => () => {},
      readRevision: () => 1,
      listEntries: async () => [],
      listPromptLog: async () => [],
      listWorkspaceRecords: async () => [
        { id: 'ws1', name: 'Workspace One', path: '/ws1', sessionIds: ['s1'] },
        { id: 'ws2', name: 'Workspace Two', path: '/ws2', sessionIds: ['s2'] },
      ],
      getPrefs: async () => ({}),
      lookupCommitTraces: async ({ workspaceId, hash }) => {
        storeCalls.push({ workspaceId, hash })
        return {
          matches: [
            {
              traceId: 'r9#3',
              sessionId: 's1',
              turn: 3,
              findingIds: ['f1', 'f2'],
              commit: {
                hash: '1234567890abcdef1234567890abcdef12345678',
                shortHash: '1234567',
                subject: 'fix: attribution fallback',
              },
              capturedAt: Date.UTC(2026, 10, 10, 12, 30, 0),
            },
          ],
        }
      },
    },
    t,
    getActiveWorkspaceId: () => 'ws1',
    getSessionTitles: () => ({ s1: { title: 'Auth Session' } }),
    canOpenSession: () => canOpen,
    openSession: sid => openCalls.push(sid),
  }

  const harness = createDeskHarness({ services })
  const DeskPage = createDeskPage({ h: harness.h, React: harness.React, services })
  const view = () => harness.runtime.render(DeskPage, { defaultTab: 'dashboard' })
  view()
  await harness.flush()
  let tree = view()

  const open = findButtonByAria(tree, t('desk.gitLookup.title'))
  await open.props.onClick()
  tree = view()

  const input = findInputByPlaceholder(tree, t('desk.gitLookup.placeholder'))
  input.props.onChange({ target: { value: '1234567890abcdef' } })
  input.props.onKeyDown({ key: 'Enter', preventDefault() {} })
  await harness.flush()
  tree = view()

  assert.deepEqual(storeCalls, [{ workspaceId: 'ws1', hash: '1234567890abcdef' }])
  const treeText = textOf(tree)
  assert.match(treeText, /1234567/)
  assert.match(treeText, /fix: attribution fallback/)
  assert.match(treeText, /Session Auth Session · Turn 3 · 2 finding\(s\)/)
  const expectedCapturedAt = formatLocalDateTime(Date.UTC(2026, 10, 10, 12, 30, 0))
  assert.ok(expectedCapturedAt)
  assert.ok(treeText.includes(expectedCapturedAt), `expected local-time ${expectedCapturedAt} in result meta`)

  // When canOpenSession() is false, button is disabled and does not call openSession
  const disabledResult = findButtonByLabel(tree, /fix: attribution fallback/)
  assert.ok(disabledResult)
  assert.equal(disabledResult.props.disabled, true)
  await disabledResult.props.onClick()
  assert.equal(openCalls.length, 0)

  // Switching workspace clears results and error state
  const wsSelect = findNode(tree, n => n.type === 'select' && n.props?.['aria-label'] === t('desk.workspace.select'))
  assert.ok(wsSelect)
  wsSelect.props.onChange({ target: { value: 'ws2' } })
  await harness.flush()
  tree = view()
  assert.ok(!textOf(tree).includes('fix: attribution fallback'), 'results must clear when workspace changes')
})
