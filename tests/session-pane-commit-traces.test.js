import test from 'node:test'
import assert from 'node:assert/strict'
import { createFindingRecord } from '../src/domain/entries.js'
import { createGroupRecord } from '../src/domain/active-group.js'
import { makePaneHarness, textOfNode, findButtonByLabel, t } from './helpers/pane-harness.js'
import { setPendingCommitFocus } from '../src/client/ui/bits.js'

const finding = createFindingRecord({
  id: 'f1', sessionId: 's1', text: 'hit', severity: 'P1', tag: 'code',
  submissionStatus: 'submitted', status: 'sent', requestId: 'r1', assignedGroupId: 'g1',
})
const group = createGroupRecord({
  id: 'g1', groupNumber: 1, sessionId: 's1', workspaceId: 'session:s1',
  items: [{ findingId: 'f1', order: 1 }],
})
const trace = {
  id: 'r1#1', requestId: 'r1', sessionId: 's1', workspaceId: 'ws1',
  mode: 'sequential', turn: 1, groupIds: ['g1'], findingIds: ['f1'],
  preHead: 'a'.repeat(40), postHead: 'b'.repeat(40), preHeadSource: 'turn',
  commits: [
    { hash: 'abcdef0123456789abcdef0123456789abcdef01', shortHash: 'abcdef0', subject: 'feat: one', time: 1 },
    { hash: 'abcdef0123456789abcdef0123456789abcdef02', shortHash: 'abcdef0', subject: 'fix: two', time: 2 },
  ],
  truncated: false, status: 'complete', capturedAt: 1, updatedAt: 1,
}

test('finding row shows commit badge, expands to hashes/subjects, and hides retry without endpoints', async () => {
  const harness = makePaneHarness({
    entries: [finding], groups: [group], traces: [trace],
    promptLogRows: [{ requestId: 'r1', status: 'completed', source: 'desk-batch' }],
  })
  const render = () => harness.render(harness.SessionPane, { sessionId: 's1' })
  render(); await harness.flushEffects()
  let view = render(); await harness.flushEffects(); view = render()

  let text = textOfNode(view)
  assert.doesNotMatch(text, /2 commits/)
  assert.ok(harness.retryCalls.length === 0)

  const badge = findButtonByLabel(view, /2 commits/)
  assert.equal(textOfNode(badge).trim(), '2', 'commit badge renders the number only')
  await badge.props.onClick()
  view = render()
  text = textOfNode(view)
  assert.match(text, /abcdef0/)
  assert.match(text, /feat: one/)
  assert.match(text, /fix: two/)

  // 缺端点的 failed trace：无重试按钮
  const failed = { ...trace, id: 'r1#2', status: 'failed', error: 'no-post-head', postHead: undefined }
  harness.setTraces([failed])
  view = render()
  assert.ok(!textOfNode(view).includes('commitTrace.retry'))
  assert.equal(findButtonByLabel(view, /retry/i), null)
})

test('failed trace with both endpoints exposes retry and calls services.commitTraces.retryTrace', async () => {
  const harness = makePaneHarness({
    entries: [finding], groups: [group],
    traces: [{ ...trace, status: 'failed', error: 'range-failed' }],
    promptLogRows: [{ requestId: 'r1', status: 'completed', source: 'desk-batch' }],
  })
  let view = harness.render(harness.SessionPane, { sessionId: 's1' })
  await harness.flushEffects(); view = harness.render(harness.SessionPane, { sessionId: 's1' })
  const retry = findButtonByLabel(view, /retry/i)
  assert.ok(retry)
  await retry.props.onClick()
  assert.equal(harness.retryCalls.length, 1)
  assert.deepEqual(harness.retryCalls[0], { sessionId: 's1', traceId: 'r1#1' })
})

test('0 commits badge, truncated hint, non-retryable errors, secondary gitFootprint, and group deduplicated summary', async () => {
  const f1WithFootprint = createFindingRecord({
    id: 'f1', sessionId: 's1', text: 'first item', severity: 'P1', tag: 'code',
    submissionStatus: 'submitted', status: 'completed', reviewStatus: 'resolved', requestId: 'r1', assignedGroupId: 'g1',
    gitFootprint: { branch: 'main', commit: '5f251df0000' },
  })
  const f2 = createFindingRecord({
    id: 'f2', sessionId: 's1', text: 'second item', severity: 'P2', tag: 'code',
    submissionStatus: 'submitted', status: 'sent', requestId: 'r2', assignedGroupId: 'g1',
  })
  const g1 = createGroupRecord({
    id: 'g1', groupNumber: 1, sessionId: 's1', workspaceId: 'session:s1',
    items: [{ findingId: 'f1', order: 1 }, { findingId: 'f2', order: 2 }],
  })
  const c1 = { hash: '1111111111111111111111111111111111111111', shortHash: '1111111', subject: 'feat: shared', time: 100 }
  const c2 = { hash: '2222222222222222222222222222222222222222', shortHash: '2222222', subject: 'fix: second', time: 200 }
  const t1 = {
    id: 'r1#1', requestId: 'r1', sessionId: 's1', workspaceId: 'ws1',
    mode: 'sequential', turn: 1, groupIds: ['g1'], findingIds: ['f1'],
    preHead: 'a'.repeat(40), postHead: 'b'.repeat(40), preHeadSource: 'turn',
    commits: [c1], truncated: true, status: 'complete', capturedAt: 1, updatedAt: 1,
  }
  const t2 = {
    id: 'r2#2', requestId: 'r2', sessionId: 's1', workspaceId: 'ws1',
    mode: 'sequential', turn: 2, groupIds: ['g1'], findingIds: ['f2'],
    preHead: 'b'.repeat(40), postHead: 'c'.repeat(40), preHeadSource: 'turn',
    commits: [c1, c2], truncated: false, status: 'complete', capturedAt: 2, updatedAt: 2,
  }

  const harness = makePaneHarness({
    entries: [f1WithFootprint, f2],
    groups: [g1],
    traces: [t1, t2],
    promptLogRows: [
      { requestId: 'r1', status: 'completed', source: 'desk-batch' },
      { requestId: 'r2', status: 'completed', source: 'desk-batch' },
    ],
  })
  const render = () => harness.render(harness.SessionPane, { sessionId: 's1' })
  render(); await harness.flushEffects()
  let view = render(); await harness.flushEffects(); view = render()

  // Group header deduplicates c1 across t1 and t2 -> 2 commits total in group
  const groupBadge = findButtonByLabel(view, /group-commit-trace/)
  assert.ok(groupBadge, 'group commit trace badge must exist')
  assert.equal(textOfNode(groupBadge).trim(), '2', 'group commit badge renders the number only')

  // Expand group commit trace summary
  await groupBadge.props.onClick()
  view = render()
  assert.ok(textOfNode(view).includes(t('group.commitTrace.expandedTitle')))

  // Expand f1's commit trace badge (1 commit + truncatedHint + secondary gitFootprint)
  const f1Badge = findButtonByLabel(view, /^1 commits$/)
  assert.ok(f1Badge, 'f1 badge should have a 1-commit accessible label')
  assert.equal(textOfNode(f1Badge).trim(), '1')
  await f1Badge.props.onClick()
  view = render()
  const expandedText = textOfNode(view)
  assert.ok(expandedText.includes(t('finding.commitTrace.truncatedHint')), 'truncated trace shows hint')
  assert.ok(
    expandedText.includes(t('finding.gitFootprint.secondary').replace('{branch}', 'main').replace('{commit}', '5f251df')),
    'legacy gitFootprint is rendered as secondary row inside expanded git area',
  )

  // 0 commits trace
  harness.setTraces([{ ...t1, commits: [], truncated: false }])
  view = render()
  const zeroBadge = findButtonByLabel(view, /0 commits/)
  assert.ok(zeroBadge, '0 commits trace keeps an icon-only accessible label')
  assert.equal(textOfNode(zeroBadge).trim(), '', 'zero commits renders the icon without a 0')

  // not-a-repo and workspace-unresolved do not expose retry even with endpoints
  harness.setTraces([{ ...t1, status: 'failed', error: 'not-a-repo', commits: [] }])
  view = render()
  assert.ok(textOfNode(view).includes(t('commitTrace.error.notARepo')))
  assert.equal(findButtonByLabel(view, /retry/i), null)

  harness.setTraces([{ ...t1, status: 'failed', error: 'workspace-unresolved', commits: [] }])
  view = render()
  assert.ok(textOfNode(view).includes(t('commitTrace.error.workspaceUnresolved')))
  assert.equal(findButtonByLabel(view, /retry/i), null)
})

test('no trace without gitFootprint renders no git badge; legacy gitFootprint expands to secondary row', async () => {
  const plainFinding = createFindingRecord({
    id: 'f-plain', sessionId: 's1', text: 'no git info', severity: 'P1', tag: 'code',
    submissionStatus: 'submitted', status: 'completed', reviewStatus: 'resolved', assignedGroupId: 'g1',
  })
  const fpOnlyFinding = createFindingRecord({
    id: 'f-fp', sessionId: 's1', text: 'only footprint', severity: 'P1', tag: 'code',
    submissionStatus: 'submitted', status: 'completed', reviewStatus: 'resolved', assignedGroupId: 'g1',
    gitFootprint: { branch: 'feat/legacy', commit: 'deadbeef123456' },
  })
  const g1 = createGroupRecord({
    id: 'g1', groupNumber: 1, sessionId: 's1', workspaceId: 'session:s1',
    items: [{ findingId: 'f-plain', order: 1 }, { findingId: 'f-fp', order: 2 }],
  })
  const harness = makePaneHarness({
    entries: [plainFinding, fpOnlyFinding],
    groups: [g1],
    traces: [],
  })
  const render = () => harness.render(harness.SessionPane, { sessionId: 's1' })
  render(); await harness.flushEffects()
  let view = render(); await harness.flushEffects(); view = render()

  // No commit count badge when traces are empty
  assert.equal(findButtonByLabel(view, /commits/), null)
  assert.equal(findButtonByLabel(view, /group-commit-trace/), null)

  // Legacy gitFootprint badge exists on f-fp and clicking it expands the secondary line
  const fpBadge = findButtonByLabel(view, /deadbee/)
  assert.ok(fpBadge, 'legacy gitFootprint badge must exist')
  const secondaryExpected = t('finding.gitFootprint.secondary')
    .replace('{branch}', 'feat/legacy')
    .replace('{commit}', 'deadbee')
  assert.ok(!textOfNode(view).includes(secondaryExpected), 'secondary line is collapsed initially')
  await fpBadge.props.onClick()
  view = render()
  assert.ok(textOfNode(view).includes(secondaryExpected), 'clicking legacy gitFootprint badge reveals secondary line')
})


test('desk lookup focus expands the target finding and commit block', async () => {
  // Use a unique session so listeners left by earlier harnesses cannot consume
  // this module-level focus payload first.
  const focusFinding = createFindingRecord({
    id: 'ffocus', sessionId: 'sfocus', text: 'focused hit', severity: 'P1', tag: 'code',
    submissionStatus: 'submitted', status: 'sent', requestId: 'rfocus', assignedGroupId: 'gfocus',
  })
  const focusGroup = createGroupRecord({
    id: 'gfocus', groupNumber: 1, sessionId: 'sfocus', workspaceId: 'session:sfocus',
    items: [{ findingId: 'ffocus', order: 1 }],
  })
  const focusTrace = {
    ...trace,
    id: 'rfocus#1', requestId: 'rfocus', sessionId: 'sfocus', groupIds: ['gfocus'], findingIds: ['ffocus'],
    commits: [
      { hash: 'abcdef0123456789abcdef0123456789abcdef01', shortHash: 'abcdef0', subject: 'feat: focus', time: 1 },
    ],
  }
  const harness = makePaneHarness({
    entries: [focusFinding], groups: [focusGroup], traces: [focusTrace],
    promptLogRows: [{ requestId: 'rfocus', status: 'completed', source: 'desk-batch' }],
  })
  setPendingCommitFocus('sfocus', {
    traceId: 'rfocus#1',
    commitHash: 'abcdef0123456789abcdef0123456789abcdef01',
    shortHash: 'abcdef0',
    findingIds: ['ffocus'],
    turn: 1,
  })
  harness.render(harness.SessionPane, { sessionId: 'sfocus' })
  await harness.flushEffects()
  let view = harness.render(harness.SessionPane, { sessionId: 'sfocus' })
  await harness.flushEffects()
  view = harness.render(harness.SessionPane, { sessionId: 'sfocus' })

  const text = textOfNode(view)
  assert.ok(text.includes(t('desk.gitLookup.locatedBadge').replace('{commit}', 'abcdef0')))
  assert.ok(text.includes('feat: focus'), 'focused commit block must be expanded')
})
