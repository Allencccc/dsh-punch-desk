import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DRAFTS_WORKSPACE_KEY, DRAFT_EDITOR_STATUSES, GLOBAL_DRAFT_VISIBILITY, WORKSPACE_DRAFT_VISIBILITY,
  createDraft, draftDisplayTitle, draftStatusOptions, draftVisibility, filterDrafts, filterDraftsForWorkspace,
  isDeleteArmed, isDraftVisibleInWorkspace, resolveWorkspaceSessionIds, saveDraftEntry,
  sessionActivity, sessionIdFromWorkspaceKey, sessionIdsFromWorkspaceKeys,
  sessionWorkspaceKey, sortSessionSummaries, summarizeSession,
} from '../src/domain/desk.js'
import { BODY_HARD_CAP_BYTES } from '../src/domain/entries.js'
import {
  createWorkspaceDashboard, groupTurnsMetricSubtext, sessionGroupTurnsSubtext,
} from '../src/client/ui/workspace-dashboard.js'
import { dictionaries } from '../src/locale.js'

const deps = { now: () => 1000, uuid: () => 'draft-1' }

test('createDraft always lands in draft:global with the idea status', () => {
  const draft = createDraft({ title: 'Ship it' }, deps)
  assert.equal(draft.kind, 'draft')
  assert.equal(draft.workspaceKey, DRAFTS_WORKSPACE_KEY)
  assert.equal(draft.status, 'idea')
  assert.equal(draft.id, 'draft-1')
  assert.equal(draft.createdAt, 1000)
})

test('createDraft cannot be redirected to another workspace or kind', () => {
  const draft = createDraft({ title: 'x', workspaceKey: 'session:s1', kind: 'finding', status: 'ready' }, deps)
  assert.equal(draft.workspaceKey, DRAFTS_WORKSPACE_KEY)
  assert.equal(draft.kind, 'draft')
  assert.equal(draft.status, 'ready')
})

test('createDraft still rejects an empty draft', () => {
  assert.throws(() => createDraft({ title: '', body: '' }, deps), /title or body/)
})

test('saveDraftEntry creates a global draft only when saved', () => {
  const result = saveDraftEntry({
    isNew: true, title: '  Ship it  ', body: ' body ', now: () => 1000, uuid: () => 'draft-new',
  })
  assert.equal(result.ok, true)
  assert.equal(result.entry.kind, 'draft')
  assert.equal(result.entry.workspaceKey, DRAFTS_WORKSPACE_KEY)
  assert.equal(result.entry.title, 'Ship it')
  assert.equal(result.entry.body, 'body')
  assert.equal(result.entry.status, 'idea')
  assert.equal(result.entry.id, 'draft-new')
  assert.equal(result.entry.createdAt, 1000)
  assert.equal(result.entry.updatedAt, 1000)
})

test('saveDraftEntry keeps id and createdAt when updating an existing draft', () => {
  const draft = {
    id: 'd1', schemaVersion: 1, workspaceKey: DRAFTS_WORKSPACE_KEY, kind: 'draft',
    title: 'Old', body: '', status: 'idea', createdAt: 5, updatedAt: 5,
  }
  const result = saveDraftEntry({ draft, title: ' New ', body: 'Body', status: 'ready', now: () => 2000 })
  assert.equal(result.ok, true)
  assert.equal(result.entry.id, 'd1')
  assert.equal(result.entry.createdAt, 5)
  assert.equal(result.entry.updatedAt, 2000)
  assert.equal(result.entry.title, 'New')
  assert.equal(result.entry.body, 'Body')
  assert.equal(result.entry.status, 'ready')
  // The helper never mutates the entry it was given.
  assert.equal(draft.title, 'Old')
  assert.equal(draft.updatedAt, 5)
})

test('saveDraftEntry rejects an oversized body without throwing', () => {
  let result
  assert.doesNotThrow(() => {
    result = saveDraftEntry({
      isNew: true, title: 'x', body: 'y'.repeat(BODY_HARD_CAP_BYTES + 1), now: () => 1, uuid: () => 'd1',
    })
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'invalid')
  assert.match(result.errors.join('; '), /body too large/)
})

test('saveDraftEntry rejects an oversized body on an existing draft too', () => {
  const draft = {
    id: 'd1', schemaVersion: 1, workspaceKey: DRAFTS_WORKSPACE_KEY, kind: 'draft',
    title: 'Old', body: '', status: 'idea', createdAt: 5, updatedAt: 5,
  }
  const result = saveDraftEntry({ draft, body: 'y'.repeat(BODY_HARD_CAP_BYTES + 1), now: () => 2000 })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('; '), /body too large/)
})

test('saveDraftEntry rejects a blank title and body', () => {
  for (const isNew of [true, false]) {
    const result = saveDraftEntry({
      isNew,
      draft: { id: 'd1', kind: 'draft', workspaceKey: DRAFTS_WORKSPACE_KEY, status: 'idea' },
      title: '   ', body: '\n',
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'empty')
    assert.deepEqual(result.errors, ['title or body required'])
  }
})

test('saveDraftEntry reports an invalid status instead of persisting it', () => {
  const draft = {
    id: 'd1', schemaVersion: 1, workspaceKey: DRAFTS_WORKSPACE_KEY, kind: 'draft',
    title: 'Old', body: '', status: 'idea', createdAt: 5, updatedAt: 5,
  }
  const result = saveDraftEntry({ draft, title: 'Old', body: 'Body', status: 'bogus', now: () => 2000 })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('; '), /invalid status/)
})

test('delete arms only for the clicked draft and confirms on the second click', () => {
  assert.equal(isDeleteArmed(null, 'd1'), false)
  assert.equal(isDeleteArmed('d1', 'd1'), true)
  assert.equal(isDeleteArmed('d1', 'd2'), false)
  assert.equal(isDeleteArmed('', ''), false)

  // First click arms, second click (same draft) confirms and resets.
  const armedAfterFirstClick = 'd1'
  assert.equal(isDeleteArmed(armedAfterFirstClick, 'd1'), true)
  const armedAfterConfirm = null
  assert.equal(isDeleteArmed(armedAfterConfirm, 'd1'), false)
})

test('filterDrafts drops other kinds, filters out archived drafts, and sorts newest first', () => {
  const entries = [
    { id: 'a', kind: 'draft', updatedAt: 10, status: 'idea' },
    { id: 'b', kind: 'finding', updatedAt: 30 },
    { id: 'c', kind: 'draft', updatedAt: 20, status: 'ready' },
    { id: 'd', kind: 'draft', updatedAt: 25, status: 'archived' },
    null,
  ]
  assert.deepEqual(filterDrafts(entries).map(item => item.id), ['c', 'a'])
  assert.deepEqual(filterDrafts(null), [])
})

test('createDraft defaults to the global scope and stores no owning workspace', () => {
  const draft = createDraft({ title: 'Shared idea' }, deps)
  assert.equal(draft.visibility, GLOBAL_DRAFT_VISIBILITY)
  assert.equal('workspaceId' in draft, false)
  assert.equal(draftVisibility(draft), GLOBAL_DRAFT_VISIBILITY)
  assert.equal(draftVisibility(undefined), GLOBAL_DRAFT_VISIBILITY)
})

test('createDraft files a workspace draft under its owning workspace', () => {
  const draft = createDraft({
    title: 'Local idea', visibility: WORKSPACE_DRAFT_VISIBILITY, workspaceId: 'ws-a',
  }, deps)
  assert.equal(draft.visibility, WORKSPACE_DRAFT_VISIBILITY)
  assert.equal(draft.workspaceId, 'ws-a')
  assert.equal(draft.workspaceKey, DRAFTS_WORKSPACE_KEY)
  // A global scope always drops the owning workspace, even if one was passed.
  const globalDraft = createDraft({ title: 'Global', workspaceId: 'ws-a' }, deps)
  assert.equal(globalDraft.visibility, GLOBAL_DRAFT_VISIBILITY)
  assert.equal('workspaceId' in globalDraft, false)
})

test('a workspace draft without a workspace id is rejected', () => {
  assert.throws(
    () => createDraft({ title: 'x', visibility: WORKSPACE_DRAFT_VISIBILITY }, deps),
    /workspace draft requires workspaceId/,
  )
})

test('saveDraftEntry persists the chosen visibility for new and existing drafts', () => {
  const created = saveDraftEntry({
    isNew: true, title: 'Scoped', body: 'body',
    visibility: WORKSPACE_DRAFT_VISIBILITY, workspaceId: 'ws-a',
    now: () => 1000, uuid: () => 'draft-scoped',
  })
  assert.equal(created.ok, true)
  assert.equal(created.entry.visibility, WORKSPACE_DRAFT_VISIBILITY)
  assert.equal(created.entry.workspaceId, 'ws-a')

  const globalCreated = saveDraftEntry({
    isNew: true, title: 'Shared', body: 'body', now: () => 1000, uuid: () => 'draft-shared',
  })
  assert.equal(globalCreated.entry.visibility, GLOBAL_DRAFT_VISIBILITY)

  // An existing global draft can be narrowed to a workspace...
  const updated = saveDraftEntry({
    draft: created.entry, title: 'Scoped', body: 'body',
    visibility: GLOBAL_DRAFT_VISIBILITY, now: () => 2000,
  })
  assert.equal(updated.ok, true)
  assert.equal(updated.entry.visibility, GLOBAL_DRAFT_VISIBILITY)
  assert.equal('workspaceId' in updated.entry, false)

  // ...and a scoped draft can be widened back to the shared pool.
  const rescoped = saveDraftEntry({
    draft: globalCreated.entry, title: 'Shared', body: 'body',
    visibility: WORKSPACE_DRAFT_VISIBILITY, workspaceId: 'ws-b', now: () => 3000,
  })
  assert.equal(rescoped.ok, true)
  assert.equal(rescoped.entry.visibility, WORKSPACE_DRAFT_VISIBILITY)
  assert.equal(rescoped.entry.workspaceId, 'ws-b')
})

test('saveDraftEntry refuses a workspace scope without a workspace id', () => {
  const result = saveDraftEntry({
    isNew: true, title: 'x', body: 'y', visibility: WORKSPACE_DRAFT_VISIBILITY,
  })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('; '), /workspace draft requires workspaceId/)
})

test('draft visibility keeps legacy drafts global and scopes workspace drafts', () => {
  const legacy = { id: 'd1', kind: 'draft', status: 'idea' }
  const globalDraft = { id: 'd2', kind: 'draft', status: 'idea', visibility: 'global' }
  const scopedA = { id: 'd3', kind: 'draft', status: 'idea', visibility: 'workspace', workspaceId: 'ws-a' }
  assert.equal(isDraftVisibleInWorkspace(legacy, 'ws-a'), true)
  assert.equal(isDraftVisibleInWorkspace(globalDraft, 'ws-b'), true)
  assert.equal(isDraftVisibleInWorkspace(scopedA, 'ws-a'), true)
  assert.equal(isDraftVisibleInWorkspace(scopedA, 'ws-b'), false)
  assert.equal(isDraftVisibleInWorkspace(scopedA, ''), false)
  assert.equal(isDraftVisibleInWorkspace(scopedA, undefined), false)
})

test('filterDraftsForWorkspace keeps global plus own-workspace drafts, newest first', () => {
  const entries = [
    { id: 'global-old', kind: 'draft', status: 'idea', updatedAt: 10, visibility: 'global' },
    { id: 'legacy', kind: 'draft', status: 'idea', updatedAt: 20 },
    { id: 'scoped-a', kind: 'draft', status: 'idea', updatedAt: 30, visibility: 'workspace', workspaceId: 'ws-a' },
    { id: 'scoped-b', kind: 'draft', status: 'idea', updatedAt: 40, visibility: 'workspace', workspaceId: 'ws-b' },
    { id: 'other-kind', kind: 'finding', updatedAt: 50 },
    null,
  ]
  assert.deepEqual(
    filterDraftsForWorkspace(entries, 'ws-a').map(draft => draft.id),
    ['scoped-a', 'legacy', 'global-old'],
  )
  assert.deepEqual(
    filterDraftsForWorkspace(entries, 'ws-b').map(draft => draft.id),
    ['scoped-b', 'legacy', 'global-old'],
  )
  assert.deepEqual(filterDraftsForWorkspace(entries, undefined).map(draft => draft.id), ['legacy', 'global-old'])
  assert.deepEqual(filterDraftsForWorkspace(null, 'ws-a'), [])
})

test('draftStatusOptions keeps derived statuses readable', () => {
  assert.deepEqual(draftStatusOptions('idea'), DRAFT_EDITOR_STATUSES)
  assert.deepEqual(draftStatusOptions('prefilled'), [...DRAFT_EDITOR_STATUSES, 'prefilled'])
  assert.deepEqual(draftStatusOptions('not-a-status'), DRAFT_EDITOR_STATUSES)
  assert.deepEqual(draftStatusOptions(undefined), DRAFT_EDITOR_STATUSES)
})

test('draftDisplayTitle falls back body first line, then placeholder', () => {
  assert.equal(draftDisplayTitle({ title: 'Title', body: 'Body' }, 'Untitled'), 'Title')
  assert.equal(draftDisplayTitle({ title: '  ', body: '\n first line \n second' }, 'Untitled'), 'first line')
  assert.equal(draftDisplayTitle({ title: '', body: '' }, 'Untitled'), 'Untitled')
  assert.equal(draftDisplayTitle(null, 'Untitled'), 'Untitled')
})

test('session workspace keys expose ids and ignore drafts', () => {
  assert.equal(sessionWorkspaceKey('s1'), 'session:s1')
  assert.equal(sessionIdFromWorkspaceKey('session:s1'), 's1')
  assert.equal(sessionIdFromWorkspaceKey('draft:global'), null)
  assert.equal(sessionIdFromWorkspaceKey('session:'), null)
  assert.equal(sessionIdFromWorkspaceKey(null), null)
  assert.deepEqual(
    sessionIdsFromWorkspaceKeys(['session:s1', 'draft:global', 'session:s2', 'session:s1', 'bogus']),
    ['s1', 's2'],
  )
  assert.deepEqual(sessionIdsFromWorkspaceKeys(undefined), [])
})

test('summarizeSession counts findings and keeps the latest activity', () => {
  const summary = summarizeSession('session:s1', [
    { kind: 'finding', status: 'open', updatedAt: 200 },
    { kind: 'finding', status: 'sent', updatedAt: 300 },
    { kind: 'finding', status: 'open', createdAt: 50 },
    { kind: 'draft', updatedAt: 100 },
  ])
  assert.deepEqual(summary, {
    sessionId: 's1',
    workspaceKey: 'session:s1',
    findingCount: 3,
    openFindingCount: 2,
    entryCount: 4,
    lastActivity: 300,
  })
})

test('summarizeSession tolerates an empty session', () => {
  assert.deepEqual(summarizeSession('session:s1', []), {
    sessionId: 's1',
    workspaceKey: 'session:s1',
    findingCount: 0,
    openFindingCount: 0,
    entryCount: 0,
    lastActivity: null,
  })
})

test('summarizeSession uses prompt-log time so a prompt-only session has recency', () => {
  const summary = summarizeSession('session:s2', [], [
    { messageId: 'm1', time: 5000 },
    { messageId: 'm2', time: 7000 },
    null,
  ])
  assert.equal(summary.entryCount, 0)
  assert.equal(summary.findingCount, 0)
  assert.equal(summary.lastActivity, 7000)

  // An entry newer than the prompt log still wins.
  const withEntry = summarizeSession('session:s2', [{ kind: 'finding', status: 'open', updatedAt: 9000 }], [
    { messageId: 'm1', time: 5000 },
  ])
  assert.equal(withEntry.lastActivity, 9000)
})

test('sortSessionSummaries orders by recency with a host updatedAt fallback', () => {
  const summaries = [
    { sessionId: 'a', lastActivity: 100 },
    { sessionId: 'b', lastActivity: null },
    { sessionId: 'c', lastActivity: 300 },
  ]
  assert.deepEqual(sortSessionSummaries(summaries).map(item => item.sessionId), ['c', 'a', 'b'])

  // The host timestamp is only needed when neither local source has a time.
  assert.deepEqual(
    sortSessionSummaries(summaries, { b: 500 }).map(item => item.sessionId),
    ['b', 'c', 'a'],
  )
  // A newer local entry still outranks an older host record.
  assert.deepEqual(sortSessionSummaries(summaries, { b: 50, a: 1000 }).map(item => item.sessionId),
    ['a', 'c', 'b'])
  const ordered = sortSessionSummaries(summaries)
  assert.deepEqual(ordered.map(item => item.sessionId), ['c', 'a', 'b'])
  assert.notEqual(ordered, summaries)
  assert.deepEqual(sortSessionSummaries(null), [])
  assert.equal(sessionActivity({ lastActivity: null }, 42), 42)
  assert.equal(sessionActivity({ lastActivity: 99 }, 42), 99)
  assert.equal(sessionActivity({ lastActivity: null }, undefined), 0)
})

test('summarizeSession derives groupTurns from submission evidence, not legacy group.turns', () => {
  const entries = [
    {
      id: 'f1', kind: 'finding', status: 'open', submissionStatus: 'submitted',
      assignedGroupId: 'g1', requestId: 'r1', acceptedAt: 100, submissionSeq: 1,
    },
    {
      id: 'f2', kind: 'finding', status: 'open', submissionStatus: 'submitted',
      assignedGroupId: 'g2', requestId: 'r2', acceptedAt: 200, submissionSeq: 2,
    },
  ]
  const promptLog = [
    { messageId: 'm1', requestId: 'r1', turn: 3, time: 110, source: 'desk-batch' },
    { messageId: 'm2', requestId: 'r2', turn: 5, time: 210, source: 'desk-batch' },
  ]
  const groups = [
    // Legacy `turns` values must be ignored (they always summed to 0 after the writers left).
    { id: 'g1', groupNumber: 1, sessionId: 's-gta', turns: 7, items: [{ findingId: 'f1' }] },
    { id: 'g2', groupNumber: 2, sessionId: 's-gta', turns: 2, items: [{ findingId: 'f2' }] },
  ]
  const summary = summarizeSession('session:s-gta', entries, promptLog, groups)
  assert.equal(summary.groupTurns, 2, 'one charged turn per accepted requestId')
  assert.equal(summary.deskTurns, 2, 'deskTurns stays the historical field name for the same value')
  assert.equal(summary.chargedTurns, 2)
  assert.equal(summary.attributedTurns, 0)
  assert.notEqual(summary.groupTurns, 9, 'legacy group.turns (7 + 2) is never re-aggregated')
  // Session elapsed turns stay independent context: deepest logged prompt turn.
  assert.equal(summary.contextTurns, 5)
  assert.equal(summary.turns, 5)
})

test('summarizeSession attributes direct input turns to the latest accepted group', () => {
  const entries = [
    {
      id: 'f1', kind: 'finding', status: 'open', submissionStatus: 'submitted',
      assignedGroupId: 'g1', requestId: 'r1', acceptedAt: 100, submissionSeq: 1,
    },
    {
      id: 'f2', kind: 'finding', status: 'open', submissionStatus: 'submitted',
      assignedGroupId: 'g2', requestId: 'r2', acceptedAt: 200, submissionSeq: 2,
    },
  ]
  const promptLog = [
    { messageId: 'm1', requestId: 'r1', turn: 3, time: 110, source: 'desk-batch' },
    { messageId: 'm2', requestId: 'r2', turn: 5, time: 210, source: 'desk-batch' },
    { messageId: 'm3', turn: 6, time: 300, source: 'composer' },
  ]
  const groups = [
    { id: 'g1', groupNumber: 1, sessionId: 's-dir', items: [{ findingId: 'f1' }] },
    { id: 'g2', groupNumber: 2, sessionId: 's-dir', items: [{ findingId: 'f2' }] },
  ]
  const summary = summarizeSession('session:s-dir', entries, promptLog, groups)
  assert.equal(summary.chargedTurns, 2)
  assert.equal(summary.attributedTurns, 1, 'composer turn 6 belongs to the latest accepted group')
  assert.equal(summary.groupTurns, 3)
})

test('summarizeSession also totals the write-once window snapshot of archived groups', () => {
  const groups = [
    {
      id: 'g3', groupNumber: 3, sessionId: 's-arch', status: 'archived',
      archivedTurn: 9, archivedCharged: 4, archivedAttributed: 2, items: [],
    },
  ]
  const summary = summarizeSession('session:s-arch', [], [], groups)
  assert.equal(summary.chargedTurns, 4)
  assert.equal(summary.attributedTurns, 2)
  assert.equal(summary.groupTurns, 6)
  assert.equal(summary.deskTurns, 6, 'the Desk metric survives with zero session context')
  assert.equal(summary.contextTurns, 0, 'elapsed is frozen from the snapshot turn, not invented')
})

test('summarizeSession replays legacy PromptLog submission rows when accepted evidence is absent', () => {
  const entries = [
    {
      id: 'f1', kind: 'finding', status: 'open', submissionStatus: 'submitted',
      assignedGroupId: 'g1', requestId: 'legacy-1',
    },
    {
      id: 'f2', kind: 'finding', status: 'open', submissionStatus: 'submitted',
      assignedGroupId: 'g1', requestId: 'legacy-2',
    },
  ]
  const promptLog = [
    { messageId: 'm1', requestId: 'legacy-1', turn: 4, time: 1000, source: 'desk-batch' },
    // `history` rows count as submissions when their requestId hits a submitted Finding.
    { messageId: 'm2', requestId: 'legacy-2', turn: 6, time: 1100, source: 'history' },
  ]
  const groups = [
    { id: 'g1', groupNumber: 1, sessionId: 's-legacy', turns: 11, items: [{ findingId: 'f1' }, { findingId: 'f2' }] },
  ]
  const summary = summarizeSession('session:s-legacy', entries, promptLog, groups)
  assert.equal(summary.chargedTurns, 2)
  assert.equal(summary.groupTurns, 2)
  assert.notEqual(summary.groupTurns, 11)
})

test('summarizeSession dedupes groupNumber records and ignores foreign-session groups', () => {
  const entries = [
    {
      id: 'f2', kind: 'finding', status: 'open', submissionStatus: 'submitted',
      assignedGroupId: 'g2-new', requestId: 'r2', acceptedAt: 50, submissionSeq: 1,
    },
  ]
  const promptLog = [{ messageId: 'm1', requestId: 'r2', turn: 5, time: 60, source: 'desk-batch' }]
  const groups = [
    { id: 'g2-old', groupNumber: 2, sessionId: 's-dup', items: [{ findingId: 'f2' }], createdAt: 1, updatedAt: 2 },
    { id: 'g2-new', groupNumber: 2, sessionId: 's-dup', items: [{ findingId: 'f2' }], createdAt: 10, updatedAt: 20 },
    // Another session's record must never inflate this session's card.
    { id: 'g-foreign', groupNumber: 9, sessionId: 'other-session', items: [{ findingId: 'f2' }] },
  ]
  const summary = summarizeSession('session:s-dup', entries, promptLog, groups)
  assert.equal(summary.chargedTurns, 1, 'the newest record for a groupNumber wins, still counted once')
  assert.equal(summary.groupTurns, 1)
})

test('summarizeSession keeps a rewritten groupId alias from losing its charged turns', () => {
  const entries = [
    {
      id: 'f2', kind: 'finding', status: 'open', submissionStatus: 'submitted',
      assignedGroupId: 'g2-old', requestId: 'r2', acceptedAt: 50, submissionSeq: 1,
    },
  ]
  const promptLog = [{ messageId: 'm1', requestId: 'r2', turn: 5, time: 60, source: 'desk-batch', groupId: 'g2-old' }]
  const groups = [
    // Same logical group (same groupNumber) rewritten under a new id.
    { id: 'g2-old', groupNumber: 2, sessionId: 's-alias', items: [{ findingId: 'f2' }], createdAt: 1, updatedAt: 2 },
    { id: 'g2-new', groupNumber: 2, sessionId: 's-alias', items: [{ findingId: 'f2' }], createdAt: 10, updatedAt: 20 },
  ]
  const summary = summarizeSession('session:s-alias', entries, promptLog, groups)
  assert.equal(summary.chargedTurns, 1, 'the alias that the findings still reference is derived')
  assert.equal(summary.groupTurns, 1, 'and the same turn is never counted twice')
})

test('summarizeSession keeps legacy group records readable without crashing', () => {
  const entries = [{ id: 'f1', kind: 'finding', status: 'open', submissionStatus: 'unsubmitted' }]
  const promptLog = [{ messageId: 'm1', turn: 2 }]
  const groups = [
    // No accepted evidence and no submission rows: derived turns are 0, never the legacy 4.
    { id: 'g1', groupNumber: 1, turns: 4, items: [{ findingId: 'f1' }] },
    null,
  ]
  const summary = summarizeSession('session:s-legacy2', entries, promptLog, groups)
  assert.equal(summary.groupTurns, 0)
  assert.equal(summary.deskTurns, 0)
  assert.equal(summary.chargedTurns, 0)
  assert.equal(summary.attributedTurns, 0)
  assert.equal(summary.contextTurns, 2)

  // Malformed/absent collections degrade to the base summary instead of throwing.
  assert.doesNotThrow(() => summarizeSession('session:s-legacy2', null, null, null, null))
})

test('summarizeSession counts a charged turn from commit traces when PromptLog has no turn', () => {
  const entries = [
    {
      id: 'f1', kind: 'finding', status: 'open', submissionStatus: 'submitted',
      assignedGroupId: 'g1', requestId: 'r-trace', acceptedAt: 10, submissionSeq: 1,
    },
  ]
  const promptLog = [{ messageId: 'm1', requestId: 'r-trace', time: 20, source: 'desk-batch' }]
  const groups = [{ id: 'g1', groupNumber: 1, sessionId: 's-trace', items: [{ findingId: 'f1' }] }]
  const traces = [{ requestId: 'r-trace', turn: 7, groupIds: ['g1'] }]

  const withoutTraces = summarizeSession('session:s-trace', entries, promptLog, groups)
  assert.equal(withoutTraces.chargedTurns, 0, 'a PromptLog row without a turn proves nothing alone')

  const withTraces = summarizeSession('session:s-trace', entries, promptLog, groups, { traces })
  assert.equal(withTraces.chargedTurns, 1)
  assert.equal(withTraces.groupTurns, 1)
  assert.equal(withTraces.contextTurns, 1, 'elapsed counts the logged prompt row, not the trace turn')
  assert.equal(withTraces.deskTurns, 1, 'the Desk metric does not depend on session elapsed turns')
})

test('resolveWorkspaceSessionIds: records, host index and findings claim sessions for a workspace', () => {
  const sessions = [
    { sessionId: 's-record' },
    { sessionId: 's-host' },
    { sessionId: 's-finding' },
    { sessionId: 's-foreign' },
    { sessionId: 's-unclaimed' },
  ]
  const ids = resolveWorkspaceSessionIds({
    sessions,
    findings: [{ sessionId: 's-finding', workspaceId: 'ws-a' }],
    sessionsById: {
      's-host': { workspaceId: 'ws-a' },
      's-foreign': { workspaceId: 'ws-b' },
    },
    workspaces: [
      { id: 'ws-a', sessionIds: ['s-record'] },
      { id: 'ws-b', sessionIds: [] },
    ],
    activeWorkspaceId: 'ws-a',
  })
  assert.deepEqual([...ids].sort(), ['s-finding', 's-host', 's-record', 's-unclaimed'],
    'another workspace\'s session is never included; unclaimed legacy sessions stay visible')
})

test('resolveWorkspaceSessionIds: without an active workspace only unclaimed sessions survive', () => {
  const ids = resolveWorkspaceSessionIds({
    sessions: [{ sessionId: 'claimed' }, { sessionId: 'unclaimed' }],
    findings: [],
    sessionsById: { claimed: { workspaceId: 'ws-a' } },
    workspaces: [],
    activeWorkspaceId: '',
  })
  assert.deepEqual([...ids], ['unclaimed'],
    'no active workspace cannot resolve ownership, so claimed sessions are not guessed into the view')
})

test('resolveWorkspaceSessionIds: malformed input degrades to an empty set', () => {
  assert.deepEqual([...resolveWorkspaceSessionIds()], [])
  assert.deepEqual([...resolveWorkspaceSessionIds({
    sessions: [null, {}, { sessionId: '' }],
    findings: [null, {}],
    sessionsById: null,
    workspaces: null,
    activeWorkspaceId: null,
  })], [], 'rows without a session id are skipped defensively')
})

// --- L12: the desk group-turn subtext must never claim "0 轮推进" ---

const dashboardDict = dictionaries()
const dashboardT = key => dashboardDict.zh[key] ?? key

/** Minimal React-free renderer: `createWorkspaceDashboard` uses no hooks. */
function renderDashboard(sessions, drafts = []) {
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
  const Dashboard = createWorkspaceDashboard({
    h, React: {}, services: { t: dashboardT }, DraftEditor: () => null,
  })
  return Dashboard({ sessions, drafts })
}

function dashboardText(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(dashboardText).join(' ')
  return (node.children ?? []).map(dashboardText).join(' ')
}

test('groupTurnsMetricSubtext hides an empty attribution window', () => {
  // Zero/absent/negative/NaN windows all render nothing instead of "手账推进 0 轮".
  assert.equal(groupTurnsMetricSubtext(0, dashboardT), null)
  assert.equal(groupTurnsMetricSubtext(undefined, dashboardT), null)
  assert.equal(groupTurnsMetricSubtext(null, dashboardT), null)
  assert.equal(groupTurnsMetricSubtext(-4, dashboardT), null)
  assert.equal(groupTurnsMetricSubtext(Number.NaN, dashboardT), null)
  // A measured window still renders the count with the singular/plural template.
  assert.equal(groupTurnsMetricSubtext(1, dashboardT), '手账推进 1 轮')
  assert.equal(groupTurnsMetricSubtext(3, dashboardT), '手账推进 3 轮')
})

test('sessionGroupTurnsSubtext hides per-session zero while keeping the session turn segment', () => {
  assert.equal(sessionGroupTurnsSubtext({ groupTurns: 0 }, dashboardT), null)
  assert.equal(sessionGroupTurnsSubtext({}, dashboardT), null)
  assert.equal(sessionGroupTurnsSubtext(undefined, dashboardT), null)
  assert.equal(sessionGroupTurnsSubtext({ groupTurns: Number.NaN }, dashboardT), null)
  assert.equal(sessionGroupTurnsSubtext({ groupTurns: 2 }, dashboardT), '2 轮推进')
  // Legacy alias still feeds the same subtext rather than silently dropping it.
  assert.equal(sessionGroupTurnsSubtext({ deskTurns: 4 }, dashboardT), '4 轮推进')
})

test('summarizeSession output can never produce a "0 轮推进" subtext (B3/L12 chain)', () => {
  const empty = summarizeSession('session:l12-empty', [], [], [])
  assert.equal(empty.groupTurns ?? 0, 0)
  assert.equal(groupTurnsMetricSubtext(empty.groupTurns ?? empty.deskTurns ?? 0, dashboardT), null)

  const legacyOnly = summarizeSession(
    'session:l12-legacy',
    [{ id: 'f1', kind: 'finding', status: 'open', submissionStatus: 'unsubmitted' }],
    [{ messageId: 'm1', turn: 2 }],
    [{ id: 'g1', groupNumber: 1, turns: 4, items: [{ findingId: 'f1' }] }],
  )
  assert.equal(legacyOnly.groupTurns, 0, 'the legacy group.turns value is not a turn attribution')
  assert.equal(groupTurnsMetricSubtext(legacyOnly.groupTurns, dashboardT), null)
  assert.equal(legacyOnly.contextTurns, 2, 'session 交互轮次 stays a separate, unaffected metric')
})

test('WorkspaceDashboard renders no group-turn subtext for an empty window', () => {
  // Session context turns are real: the workspace still shows 交互轮次, but the
  // group-turn subtext is absent rather than a fabricated zero.
  const text = dashboardText(renderDashboard([
    { sessionId: 's-empty', contextTurns: 5, turns: 5, findingCount: 2, groupTurns: 0 },
  ]))
  assert.ok(text.includes('交互轮次'), 'session turn metric stays visible')
  assert.ok(!text.includes('手账推进'), 'empty window renders no desk-turn subtext at all')
  assert.ok(!text.includes('0 轮推进'), 'and never the empty per-session advance segment')
})

test('WorkspaceDashboard shows the group-turn subtext once a turn is attributed', () => {
  const text = dashboardText(renderDashboard([
    { sessionId: 's-active', contextTurns: 5, turns: 5, findingCount: 2, groupTurns: 3 },
  ]))
  assert.ok(text.includes('手账推进 3 轮'), 'workspace metric sums the session group turns')
  assert.ok(text.includes('3 轮推进'), 'session card reports its attributed window')
  assert.ok(text.includes('交互轮次'), 'session elapsed turns remain a separate row value')
})
