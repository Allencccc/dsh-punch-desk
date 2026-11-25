import test from 'node:test'
import assert from 'node:assert/strict'
import { makePaneHarness, textOfNode, findButtonByLabel, t } from './helpers/pane-harness.js'

const groups = [1, 2, 3].map(number => ({
  id: `g${number}`,
  groupNumber: number,
  status: 'archived',
  sessionId: 's1',
  workspaceId: 'session:s1',
  items: [],
  archivedAt: number,
  createdAt: number,
  updatedAt: number,
}))

const titleOf = n => t('group.title').replace('{number}', String(n))

test('archived groups default to descending group number and toggle to ascending', async () => {
  const harness = makePaneHarness({ groups })
  harness.render(harness.SessionPane, { sessionId: 's1' })
  await harness.flushEffects()
  let view = harness.render(harness.SessionPane, { sessionId: 's1' })
  await harness.flushEffects()
  view = harness.render(harness.SessionPane, { sessionId: 's1' })

  let text = textOfNode(view)
  assert.ok(text.indexOf(titleOf(3)) >= 0 && text.indexOf(titleOf(1)) >= 0)
  assert.ok(text.indexOf(titleOf(3)) < text.indexOf(titleOf(1)), 'default order must be newest-first')

  const toAsc = findButtonByLabel(view, t('group.archivedSortToAsc'))
  assert.ok(toAsc, 'descending state must offer ascending toggle')
  await toAsc.props.onClick()
  view = harness.render(harness.SessionPane, { sessionId: 's1' })
  text = textOfNode(view)
  assert.ok(text.indexOf(titleOf(1)) < text.indexOf(titleOf(3)), 'ascending order must be oldest-first')

  const toDesc = findButtonByLabel(view, t('group.archivedSortToDesc'))
  assert.ok(toDesc, 'ascending state must offer descending toggle')
})
