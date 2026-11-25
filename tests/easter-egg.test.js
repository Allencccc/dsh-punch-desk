import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NEON_CLASS,
  NEON_DURATION_MS,
  NEON_MARK,
  createNeonSignal,
  hasNeonMark,
} from '../src/client/ui/easter-egg.js'
import { PUNCH_DESK_THEME_CSS } from '../src/client/ui/nord.js'

test('only a bracketed, upper-case marker counts as a hit', () => {
  assert.equal(NEON_MARK, '[AC]')
  assert.equal(hasNeonMark('决定走 A 方案 [AC] 先落地'), true)
  assert.equal(hasNeonMark('[ac] 小写不算'), false)
  assert.equal(hasNeonMark('AC 没有括号'), false)
  assert.equal(hasNeonMark(''), false)
  assert.equal(hasNeonMark(null), false)
})

test('the signal arms on demand, expires by itself, and notifies subscribers', () => {
  let now = 1000
  const signal = createNeonSignal({ durationMs: 500, now: () => now })
  const seen = []
  const unsubscribe = signal.subscribe(armed => seen.push(armed))

  assert.equal(signal.isArmed(), false)
  signal.arm()
  assert.equal(signal.isArmed(), true)
  assert.equal(signal.remaining(), 500)
  assert.deepEqual(seen, [true])

  now += 499
  assert.equal(signal.isArmed(), true)
  now += 1
  assert.equal(signal.isArmed(), false)
  assert.equal(signal.remaining(), 0)

  signal.clear()
  assert.deepEqual(seen, [true], 'clearing an expired window is a no-op')
  signal.arm()
  assert.deepEqual(seen, [true, true], 're-arming notifies again')
  unsubscribe()
  signal.arm()
  assert.deepEqual(seen, [true, true], 'unsubscribed listeners stop receiving updates')
  assert.ok(NEON_DURATION_MS > 1000)
})

test('the composer glow flashes a rainbow and honours reduced motion', () => {
  assert.equal(NEON_CLASS, 'pd-neon')
  assert.match(PUNCH_DESK_THEME_CSS, /@keyframes pd-neon/)
  assert.match(PUNCH_DESK_THEME_CSS, /\.pd-neon \{ animation: pd-neon/)
  assert.match(PUNCH_DESK_THEME_CSS, /#ff3b30[\s\S]*#34c759[\s\S]*#5856d6/)
  assert.match(PUNCH_DESK_THEME_CSS, /prefers-reduced-motion[\s\S]*?\.pd-neon \{ animation: none/)
})
