import test from 'node:test'
import assert from 'node:assert/strict'
import { createTipH, computeTipPosition, markTipHost, TIP_ATTR } from '../src/client/ui/tooltip-layer.js'

const rawH = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })

test('a title on a DOM element only becomes an aria-label (no visual tip)', () => {
  const h = createTipH(rawH)
  const node = h('button', { title: '展开' })
  assert.equal(node.props.title, undefined, 'native title must not survive')
  assert.equal(node.props['aria-label'], '展开')
  assert.equal(node.props[TIP_ATTR], undefined, 'action names must not pop a tooltip')
})

test('only an explicit tip prop opts into the visual tooltip', () => {
  const h = createTipH(rawH)
  const node = h('span', { tip: '分支 main · 提交 a1b2c3d4', title: '提交' })
  assert.equal(node.props[TIP_ATTR], '分支 main · 提交 a1b2c3d4')
  assert.equal(node.props['aria-label'], '分支 main · 提交 a1b2c3d4', 'tip also feeds screen readers')
  assert.equal(node.props.title, undefined)
})

test('props on non-tip-host components are left untouched (component data)', () => {
  const h = createTipH(rawH)
  const Card = props => h('div', props)
  const node = h(Card, { title: '会话标题', tip: 'ignored' })
  assert.equal(node.props.title, '会话标题')
  assert.equal(node.props.tip, 'ignored')
  assert.equal(node.props[TIP_ATTR], undefined)
})

test('marked components may own a tip (Badge/Button opt in)', () => {
  const h = createTipH(rawH)
  const Badge = props => h('span', props)
  markTipHost(Badge)
  const node = h(Badge, { tip: '已归档会话只读' })
  assert.equal(node.props[TIP_ATTR], '已归档会话只读')
  assert.equal(node.props['aria-label'], '已归档会话只读')
})

test('computeTipPosition prefers above, flips below and clamps horizontally', () => {
  const viewport = { width: 800, height: 600 }
  const tip = { width: 200, height: 40 }
  const above = computeTipPosition({ left: 400, top: 300, width: 30, height: 20 }, viewport, tip)
  assert.equal(above.placement, 'top')
  assert.equal(above.top, 254)
  assert.equal(above.left, 315)
  const below = computeTipPosition({ left: 400, top: 20, width: 30, height: 20 }, viewport, tip)
  assert.equal(below.placement, 'bottom')
  assert.equal(below.top, 46)
  const clamped = computeTipPosition({ left: 5, top: 300, width: 10, height: 20 }, viewport, tip)
  assert.equal(clamped.left, 6)
  assert.equal(computeTipPosition({ left: 795, top: 300, width: 10, height: 20 }, viewport, tip).left, 594)
})

test('factory keeps the single hyperscript boundary for tooltips', async () => {
  const fs = await import('node:fs')
  const path = new URL('../src/client/factory.js', import.meta.url)
  const source = fs.readFileSync(path, 'utf8')
  assert.ok(source.includes('createTipH(React.createElement)'), 'factory must wrap h with createTipH')
  assert.ok(source.includes('installTooltipLayer()'), 'factory must mount the tooltip layer on apply')
})
