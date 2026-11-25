import test from 'node:test'
import assert from 'node:assert/strict'
import { createFindingRecord } from '../src/domain/entries.js'
import { createGroupRecord } from '../src/domain/active-group.js'
import { deriveGroupBadgeState, deriveHarnessProjection } from '../src/client/ui/session-pane.js'
import { makePaneHarness, flattenButtons, textOfNode, t } from './helpers/pane-harness.js'

test('Two active groups: submission requires an explicit target (no implicit default)', async () => {
  const g1 = createGroupRecord({ id: 'g-1', groupNumber: 1, sessionId: 's-1', workspaceId: 'session:s-1', items: [] })
  const g2 = createGroupRecord({ id: 'g-2', groupNumber: 2, sessionId: 's-1', workspaceId: 'session:s-1', items: [] })
  const f1 = createFindingRecord({ id: 'f-1', sessionId: 's-1', text: 'Needs a destination', submissionStatus: 'unsubmitted' })
  const { render, flushEffects, SessionPane } = makePaneHarness({ groups: [g1, g2], entries: [f1] })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  let tree = render(SessionPane, { sessionId: 's-1' })
  // settle the target-selection effect after the async group load
  await flushEffects()
  tree = render(SessionPane, { sessionId: 's-1' })
  const checkbox = (function find(node) {
    if (!node || typeof node !== 'object') return null
    if (node.type === 'input' && node.props?.type === 'checkbox' && node.props?.id !== 'selectAllCheckbox') return node
    for (const child of node.children || []) { const found = find(child); if (found) return found }
    return null
  })(tree)
  assert.ok(checkbox, 'finding checkbox must exist')
  checkbox.props.onChange()
  tree = render(SessionPane, { sessionId: 's-1' })
  const submitPrefix = t('dock.submitTo').split('{')[0]
  const submitBtn = flattenButtons(tree).find(b => typeof b.props?.title === 'string'
    && (b.props.title.startsWith(submitPrefix) || b.props.title === t('dock.submitCombined1Turn')))
  assert.ok(submitBtn, 'submit button must exist')
  assert.equal(submitBtn.props.disabled, true, 'submit must be blocked until a target is chosen')
  const needTargetText = t('dock.needTarget').replace('{groups}', '+G1 / +G2')
  assert.ok(JSON.stringify(tree).includes(needTargetText), 'dock must ask for an explicit target')
})

test('Single active group auto-selects the unambiguous target', async () => {
  const g1 = createGroupRecord({ id: 'g-1', groupNumber: 1, sessionId: 's-1', workspaceId: 'session:s-1', items: [] })
  const f1 = createFindingRecord({ id: 'f-1', sessionId: 's-1', text: 'Only one destination', submissionStatus: 'unsubmitted' })
  const { render, flushEffects, SessionPane } = makePaneHarness({ groups: [g1], entries: [f1] })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  let tree = render(SessionPane, { sessionId: 's-1' })
  // settle the target-selection effect after the async group load
  await flushEffects()
  tree = render(SessionPane, { sessionId: 's-1' })
  const checkbox = (function find(node) {
    if (!node || typeof node !== 'object') return null
    if (node.type === 'input' && node.props?.type === 'checkbox' && node.props?.id !== 'selectAllCheckbox') return node
    for (const child of node.children || []) { const found = find(child); if (found) return found }
    return null
  })(tree)
  checkbox.props.onChange()
  tree = render(SessionPane, { sessionId: 's-1' })
  const submitPrefix = t('dock.submitTo').split('{')[0]
  const submitBtn = flattenButtons(tree).find(b => typeof b.props?.title === 'string' && b.props.title.startsWith(submitPrefix))
  assert.ok(submitBtn, 'submit button must exist')
  assert.equal(submitBtn.props.disabled, false, 'the single group is an unambiguous target and auto-selects')
  assert.ok(submitBtn.props.title.includes('G1'), 'button must name the auto-selected destination')
})

test('Appending to a non-empty group requires a second explicit confirmation', async () => {
  const existing = createFindingRecord({ id: 'f-old', sessionId: 's-1', text: 'Already in G1', submissionStatus: 'submitted', status: 'sent', assignedGroupId: 'g-1' })
  const g1 = createGroupRecord({ id: 'g-1', groupNumber: 1, sessionId: 's-1', workspaceId: 'session:s-1', items: [{ findingId: 'f-old', order: 1 }] })
  const f1 = createFindingRecord({ id: 'f-new', sessionId: 's-1', text: 'Append me', submissionStatus: 'unsubmitted' })
  const { render, flushEffects, SessionPane, groupsStore, entriesStore } = makePaneHarness({ groups: [g1], entries: [existing, f1] })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  let tree = render(SessionPane, { sessionId: 's-1' })
  // settle the target-selection effect after the async group load
  await flushEffects()
  tree = render(SessionPane, { sessionId: 's-1' })
  const checkbox = (function find(node) {
    if (!node || typeof node !== 'object') return null
    if (node.type === 'input' && node.props?.type === 'checkbox' && node.props?.id !== 'selectAllCheckbox') return node
    for (const child of node.children || []) { const found = find(child); if (found) return found }
    return null
  })(tree)
  checkbox.props.onChange()
  tree = render(SessionPane, { sessionId: 's-1' })
  const submitPrefix = t('dock.submitTo').split('{')[0]
  const submitBtn = flattenButtons(tree).find(b => typeof b.props?.title === 'string' && b.props.title.startsWith(submitPrefix))
  await submitBtn.props.onClick()
  await flushEffects()
  // First click only arms the append confirmation; nothing is written yet.
  assert.equal(groupsStore[0].items.length, 1, 'no silent append before confirmation')
  assert.equal(entriesStore.find(e => e.id === 'f-new').submissionStatus, 'unsubmitted')
  tree = render(SessionPane, { sessionId: 's-1' })
  const confirmBtn = flattenButtons(tree).find(b => textOfNode(b) === t('dock.appendConfirmYes'))
  assert.ok(confirmBtn, 'append confirmation must be rendered')
  await confirmBtn.props.onClick()
  await flushEffects()
  assert.equal(groupsStore[0].items.length, 2, 'confirmed append adds the finding')
  assert.equal(entriesStore.find(e => e.id === 'f-new').submissionStatus, 'submitted')
  assert.ok(JSON.stringify({ notice: t('dock.submittedTo') }).length > 0)
})

test('Group badge and row badges share one projection (executed vs executing)', async () => {
  const executed = createFindingRecord({
    id: 'f-exec', sessionId: 's-1', text: 'Ran to completion', submissionStatus: 'submitted',
    status: 'sent', requestId: 'req-exec', assignedGroupId: 'g-1',
  })
  const noEvidence = createFindingRecord({
    id: 'f-none', sessionId: 's-1', text: 'Legacy sent row', submissionStatus: 'submitted',
    status: 'sent', requestId: 'req-none', assignedGroupId: 'g-2',
  })
  const g1 = createGroupRecord({ id: 'g-1', groupNumber: 1, sessionId: 's-1', workspaceId: 'session:s-1', items: [{ findingId: 'f-exec', order: 1 }] })
  const g2 = createGroupRecord({ id: 'g-2', groupNumber: 2, sessionId: 's-1', workspaceId: 'session:s-1', items: [{ findingId: 'f-none', order: 1 }] })
  const { render, flushEffects, SessionPane } = makePaneHarness({
    groups: [g1, g2],
    entries: [executed, noEvidence],
    promptLogRows: [{ requestId: 'req-exec', status: 'completed', source: 'desk-batch' }],
  })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  let tree = render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  tree = render(SessionPane, { sessionId: 's-1' })
  const text = textOfNode(tree)
  // G1: the single finding has real execution evidence -> the group count badge
  // expands to 待结项 (executed but not reviewed), never 已完成.
  assert.ok(text.includes(t('group.status.awaitingWrapUp')), 'group with executed-but-unreviewed items reads 待结项')
  assert.ok(text.includes(t('finding.badge.executed')), 'row with executed projection must read 已执行')
  // G2: legacy status 'sent' with no log/queue evidence is a submission fact only.
  assert.ok(text.includes(t('finding.badge.submitted')), 'legacy sent row without evidence must read submitted')
  assert.equal(deriveHarnessProjection(noEvidence, [], []), 'unknown', 'legacy sent is not execution evidence')
  assert.equal(deriveHarnessProjection(executed, [{ requestId: 'req-exec', status: 'completed' }], []), 'executed')

  // Regression (2026-11-11): 忽略 (dismiss) and 完成 (resolve) are different review
  // outcomes. A dismissed row used to render 已完成 because both shared one branch.
  const dismissed = createFindingRecord({
    id: 'f-dismiss', sessionId: 's-1', text: 'No follow-up needed', submissionStatus: 'submitted',
    reviewStatus: 'dismissed', status: 'dismissed', assignedGroupId: 'g-3',
  })
  const g3 = createGroupRecord({ id: 'g-3', groupNumber: 3, sessionId: 's-1', workspaceId: 'session:s-1', items: [{ findingId: 'f-dismiss', order: 1 }] })
  const dismissedHarness = makePaneHarness({ groups: [g3], entries: [dismissed] })
  dismissedHarness.render(dismissedHarness.SessionPane, { sessionId: 's-1' })
  await dismissedHarness.flushEffects()
  let dismissedTree = dismissedHarness.render(dismissedHarness.SessionPane, { sessionId: 's-1' })
  await dismissedHarness.flushEffects()
  dismissedTree = dismissedHarness.render(dismissedHarness.SessionPane, { sessionId: 's-1' })
  // Legacy ignored row (status only) must render 已忽略 and offer no review actions.
  const legacyIgnored = { id: 'f-legacy', sessionId: 's-1', text: 'legacy ignored', submissionStatus: 'submitted', status: 'dismissed', assignedGroupId: 'g-legacy' }
  const gLegacy = createGroupRecord({ id: 'g-legacy', groupNumber: 6, sessionId: 's-1', workspaceId: 'session:s-1', items: [{ findingId: 'f-legacy', order: 1 }] })
  const legacyHarness = makePaneHarness({ groups: [gLegacy], entries: [legacyIgnored] })
  legacyHarness.render(legacyHarness.SessionPane, { sessionId: 's-1' })
  await legacyHarness.flushEffects()
  let legacyTree = legacyHarness.render(legacyHarness.SessionPane, { sessionId: 's-1' })
  await legacyHarness.flushEffects()
  legacyTree = legacyHarness.render(legacyHarness.SessionPane, { sessionId: 's-1' })
  assert.ok(textOfNode(legacyTree).includes(t('list.dismissed')), 'legacy ignored row renders 已忽略')
  assert.ok(!flattenButtons(legacyTree).some(b => b.props?.title === t('finding.action.resolve')), 'legacy ignored row is already reviewed')

  // Render-level regression: the running header dot must actually carry the
  // breathing class (the CSS class existing in the bundle is not enough).
  const runningFind = createFindingRecord({
    id: 'f-running', sessionId: 's-1', text: 'Still running', submissionStatus: 'submitted',
    status: 'sent', requestId: 'req-running', assignedGroupId: 'g-run',
  })
  const gRun = createGroupRecord({ id: 'g-run', groupNumber: 4, sessionId: 's-1', workspaceId: 'session:s-1', items: [{ findingId: 'f-running', order: 1 }] })
  const runHarness = makePaneHarness({
    groups: [gRun], entries: [runningFind],
    promptLogRows: [{ requestId: 'req-running', status: 'sent', source: 'desk-batch' }],
  })
  runHarness.render(runHarness.SessionPane, { sessionId: 's-1' })
  await runHarness.flushEffects()
  let runTree = runHarness.render(runHarness.SessionPane, { sessionId: 's-1' })
  await runHarness.flushEffects()
  runTree = runHarness.render(runHarness.SessionPane, { sessionId: 's-1' })
  assert.ok(JSON.stringify(runTree).includes('pd-breathe'), 'running header dot must render the breathing class')
  // Static-only gating: queued/running rows must not offer resolve/dismiss.
  const runButtons = flattenButtons(runTree)
  assert.ok(!runButtons.some(b => b.props?.title === t('finding.action.resolve')), 'running rows must not offer resolve')
  assert.ok(!runButtons.some(b => b.props?.title === t('finding.action.dismiss')), 'running rows must not offer dismiss')
  const staticButtons = flattenButtons(tree)
  assert.ok(staticButtons.some(b => b.props?.title === t('finding.action.resolve')), 'static executed rows keep resolve')
  assert.ok(staticButtons.some(b => b.props?.title === t('finding.action.dismiss')), 'static executed rows keep dismiss')

  const dismissedText = textOfNode(dismissedTree)
  assert.ok(dismissedText.includes(t('list.dismissed')), 'dismissed row must render 已忽略 (not 已完成)')
  // Dismissed-only batch: category badge reads 已忽略, never 已完成.
  assert.ok(dismissedText.includes(t('group.status.ignored')), 'dismissed-only batch counts 已忽略')
  assert.ok(!dismissedText.includes(`${t('group.status.completed')} 1`), 'dismissed-only batch must not count a completed row')

  // Mixed resolved + dismissed batch reads 已处理 · 含忽略.
  const resolvedRow = createFindingRecord({
    id: 'f-mixed-ok', sessionId: 's-1', text: 'Done', submissionStatus: 'submitted',
    reviewStatus: 'resolved', status: 'resolved', assignedGroupId: 'g-mixed',
  })
  const ignoredRow = createFindingRecord({
    id: 'f-mixed-ig', sessionId: 's-1', text: 'Ignored', submissionStatus: 'submitted',
    reviewStatus: 'dismissed', status: 'dismissed', assignedGroupId: 'g-mixed',
  })
  const gMixed = createGroupRecord({
    id: 'g-mixed', groupNumber: 5, sessionId: 's-1', workspaceId: 'session:s-1',
    items: [{ findingId: 'f-mixed-ok', order: 1 }, { findingId: 'f-mixed-ig', order: 2 }],
  })
  const mixedHarness = makePaneHarness({ groups: [gMixed], entries: [resolvedRow, ignoredRow] })
  mixedHarness.render(mixedHarness.SessionPane, { sessionId: 's-1' })
  await mixedHarness.flushEffects()
  let mixedTree = mixedHarness.render(mixedHarness.SessionPane, { sessionId: 's-1' })
  await mixedHarness.flushEffects()
  mixedTree = mixedHarness.render(mixedHarness.SessionPane, { sessionId: 's-1' })
  assert.ok(textOfNode(mixedTree).includes(`${t('group.status.completed')} 1`), 'mixed batch counts the resolved row as 已完成')
  assert.ok(textOfNode(mixedTree).includes(`${t('group.status.ignored')} 1`), 'mixed batch counts the dismissed row as 已忽略')

  // Helper-level contract, including array-shaped findings maps.
  assert.equal(deriveGroupBadgeState(g3, new Map([[dismissed.id, dismissed]]), new Map()).kind, 'allIgnored')
  assert.equal(deriveGroupBadgeState(gMixed, new Map([[resolvedRow.id, resolvedRow], [ignoredRow.id, ignoredRow]]), new Map()).kind, 'partialIgnored')
  assert.equal(deriveGroupBadgeState({ id: 'g-empty', items: [] }, new Map(), new Map()).kind, 'inProgress')
  const arrayShape = deriveGroupBadgeState(
    { id: 'g-arr', items: [{ findingId: 'f-arr' }] },
    [{ id: 'f-arr', submissionStatus: 'submitted', status: 'dismissed' }],
    new Map(),
  )
  assert.equal(arrayShape.kind, 'allIgnored', 'legacy ignored rows + array-shaped findings maps count as ignored')
})

test('Git footprint badge shows only the short hash; branch and full hash live in the shared tooltip', async () => {
  const done = createFindingRecord({
    id: 'f-git', sessionId: 's-1', text: 'Shipped', submissionStatus: 'submitted',
    status: 'completed', reviewStatus: 'resolved',
    gitFootprint: { branch: 'feat/beta-hardening', commit: 'a1b2c3d4e5f6' },
  })
  const g1 = createGroupRecord({ id: 'g-1', groupNumber: 1, sessionId: 's-1', workspaceId: 'session:s-1', items: [{ findingId: 'f-git', order: 1 }] })
  const { render, flushEffects, SessionPane } = makePaneHarness({ groups: [g1], entries: [done] })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  let tree = render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  tree = render(SessionPane, { sessionId: 's-1' })

  let gitWrap = null
  ;(function walk(node) {
    if (!node || typeof node !== 'object' || gitWrap) return
    const label = node.props?.['aria-label']
    if (typeof label === 'string' && label.includes('feat/beta-hardening')) { gitWrap = node; return }
    for (const child of node.children || []) walk(child)
  })(tree)
  assert.ok(gitWrap, 'git footprint badge wrapper must exist and name the branch for a11y')
  assert.ok(gitWrap.props['aria-label'].includes('a1b2c3d4e5f6'), 'aria-label must expose the full hash')
  const text = textOfNode(gitWrap)
  assert.ok(text.includes('a1b2c3'), 'badge text must be the short hash only')
  assert.ok(!text.includes('feat/beta-hardening'), 'branch must not be rendered inline')
  // One tooltip mechanism for the whole plugin: the badge carries the text and the
  // factory converts it to data-pd-tip; the item must not render its own card.
  assert.ok(!text.includes(t('finding.gitFootprint.branch').replace('{branch}', 'feat/beta-hardening')), 'no bespoke hover card in the row')
  const tipText = gitWrap.props.tip
  assert.equal(typeof tipText, 'string', 'info tooltips must opt in with tip so generic titles stay quiet')
  assert.ok(tipText.includes('feat/beta-hardening'), 'tooltip names the branch')
  assert.ok(tipText.includes('a1b2c3d4e5f6'), 'tooltip carries the full hash')
})

test('Deleting a draft finding needs a second explicit confirmation', async () => {
  const f1 = createFindingRecord({ id: 'f-del', sessionId: 's-1', text: 'Delete me', submissionStatus: 'unsubmitted' })
  const { render, flushEffects, SessionPane, deleted, entriesStore } = makePaneHarness({ groups: [], entries: [f1] })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  let tree = render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  tree = render(SessionPane, { sessionId: 's-1' })

  const deleteBtn = flattenButtons(tree).find(b => b.props?.title === t('desk.draft.delete'))
  assert.ok(deleteBtn, 'draft finding must expose a delete action')
  deleteBtn.props.onClick()
  await flushEffects()
  tree = render(SessionPane, { sessionId: 's-1' })

  // First click only arms the confirmation: nothing is deleted yet.
  assert.deepEqual(deleted, [], 'a single click must not delete anything')
  assert.ok(entriesStore.some(e => e.id === 'f-del'), 'the finding is still in the store')
  assert.ok(JSON.stringify(tree).includes(t('finding.deleteConfirmShort')), 'confirmation prompt must appear')

  const confirmBtn = flattenButtons(tree).find(b => b.props?.title === t('finding.deleteConfirmYes'))
  assert.ok(confirmBtn, 'confirmation must offer an explicit confirm action')
  confirmBtn.props.onClick()
  await flushEffects()
  assert.deepEqual(deleted, ['f-del'], 'only the confirmed click deletes')
})

test('Sequential queue states its turn cost before submitting (US4)', async () => {
  const f1 = createFindingRecord({ id: 'f-1', sessionId: 's-1', text: 'One', submissionStatus: 'unsubmitted' })
  const f2 = createFindingRecord({ id: 'f-2', sessionId: 's-1', text: 'Two', submissionStatus: 'unsubmitted' })
  const f3 = createFindingRecord({ id: 'f-3', sessionId: 's-1', text: 'Three', submissionStatus: 'unsubmitted' })
  const { render, flushEffects, SessionPane } = makePaneHarness({ groups: [], entries: [f1, f2, f3] })
  const hint = n => t('dock.sequentialCost').replace('{count}', String(n))
  const poolCheckboxes = tree => {
    const found = []
    const walk = node => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'input' && node.props?.type === 'checkbox' && node.props?.id !== 'selectAllCheckbox') found.push(node)
      for (const child of node.children || []) walk(child)
    }
    walk(tree)
    return found
  }

  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  let tree = render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  tree = render(SessionPane, { sessionId: 's-1' })
  assert.ok(!JSON.stringify(tree).includes(hint(2)), 'no turn-cost hint before anything is selected')

  let boxes = poolCheckboxes(tree)
  assert.equal(boxes.length, 3, 'all three findings must be selectable')
  boxes.forEach(box => box.props.onChange())
  tree = render(SessionPane, { sessionId: 's-1' })
  assert.ok(JSON.stringify(tree).includes(hint(3)), 'three selected findings must warn about three turns')

  boxes = poolCheckboxes(tree)
  boxes[2].props.onChange()
  tree = render(SessionPane, { sessionId: 's-1' })
  assert.ok(JSON.stringify(tree).includes(hint(2)), 'the hinted turn count must follow the selection')

  boxes = poolCheckboxes(tree)
  boxes[1].props.onChange()
  tree = render(SessionPane, { sessionId: 's-1' })
  assert.ok(!JSON.stringify(tree).includes(t('dock.sequentialCost').split('{')[0]), 'one finding needs no turn-cost hint')
})

test('Executed findings can fork the next round with a round note', async () => {
  const forkPrefix = t('entry.forkRound').split('{')[0]
  const roundNote = n => t('entry.forkRoundNote').replace('{round}', String(n))

  // A. executed-but-unreviewed row exposes Fork (no need to complete it first)
  const executed = createFindingRecord({
    id: 'f-exec-round', sessionId: 's-1', text: 'Original review target', submissionStatus: 'submitted',
    status: 'sent', requestId: 'req-round', assignedGroupId: 'g-1',
  })
  const g1 = createGroupRecord({ id: 'g-1', groupNumber: 1, sessionId: 's-1', workspaceId: 'session:s-1', items: [{ findingId: 'f-exec-round', order: 1 }] })
  const harnessA = makePaneHarness({
    groups: [g1],
    entries: [executed],
    promptLogRows: [{ requestId: 'req-round', status: 'completed', source: 'desk-batch' }],
  })
  harnessA.render(harnessA.SessionPane, { sessionId: 's-1' })
  await harnessA.flushEffects()
  let tree = harnessA.render(harnessA.SessionPane, { sessionId: 's-1' })
  await harnessA.flushEffects()
  tree = harnessA.render(harnessA.SessionPane, { sessionId: 's-1' })

  const forkButton = flattenButtons(tree).find(b => typeof b.props?.title === 'string' && b.props.title.startsWith(forkPrefix))
  assert.ok(forkButton, 'executed (unreviewed) row must expose the fork action')
  await forkButton.props.onClick()
  await harnessA.flushEffects()

  const forkedA = harnessA.entriesStore.find(e => e.sourceFindingId === 'f-exec-round')
  assert.ok(forkedA, 'fork must create a derived finding')
  assert.equal(forkedA.reviewRound, 2, 'first fork is round 2')
  assert.equal(forkedA.roundNote, roundNote(2), 'fork stores the round note it injected')
  assert.ok(forkedA.text.startsWith(roundNote(2) + '\n'), 'forked text carries the round note prefix')
  assert.ok(forkedA.text.includes('Original review target'), 'forked text keeps the original body')
  assert.equal(harnessA.entriesStore.find(e => e.id === 'f-exec-round').reviewStatus, 'pending', 'the parent row stays untouched')

  tree = harnessA.render(harnessA.SessionPane, { sessionId: 's-1' })
  assert.ok(textOfNode(tree).includes(t('entry.reviewRoundBadge').replace('{round}', '2')), 'pool card shows the round badge')

  // B. forking a round-2 entry yields round 3 without stacking old notes
  const roundTwo = createFindingRecord({
    id: 'f-round-two', sessionId: 's-1', text: roundNote(2) + '\nOriginal review target', submissionStatus: 'submitted',
    status: 'sent', requestId: 'req-round-2', assignedGroupId: 'g-2',
  })
  roundTwo.reviewRound = 2
  roundTwo.roundNote = roundNote(2)
  const g2 = createGroupRecord({ id: 'g-2', groupNumber: 2, sessionId: 's-1', workspaceId: 'session:s-1', items: [{ findingId: 'f-round-two', order: 1 }] })
  const harnessB = makePaneHarness({
    groups: [g2],
    entries: [roundTwo],
    promptLogRows: [{ requestId: 'req-round-2', status: 'completed', source: 'desk-batch' }],
  })
  harnessB.render(harnessB.SessionPane, { sessionId: 's-1' })
  await harnessB.flushEffects()
  let treeB = harnessB.render(harnessB.SessionPane, { sessionId: 's-1' })
  await harnessB.flushEffects()
  treeB = harnessB.render(harnessB.SessionPane, { sessionId: 's-1' })
  const forkB = flattenButtons(treeB).find(b => typeof b.props?.title === 'string' && b.props.title.startsWith(forkPrefix))
  assert.ok(forkB, 'round-2 executed row must expose the fork action')
  await forkB.props.onClick()
  await harnessB.flushEffects()
  const forkedB = harnessB.entriesStore.find(e => e.sourceFindingId === 'f-round-two')
  assert.ok(forkedB, 'round-3 fork must be created')
  assert.equal(forkedB.reviewRound, 3)
  assert.ok(forkedB.text.startsWith(roundNote(3) + '\n'), 'new note prefixes the text')
  assert.ok(!forkedB.text.includes(roundNote(2)), 'previous round note must be replaced, not stacked')
  assert.ok(forkedB.text.includes('Original review target'), 'body survives the note replacement')
})
