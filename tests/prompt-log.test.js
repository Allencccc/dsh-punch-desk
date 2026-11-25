import test from 'node:test'
import assert from 'node:assert/strict'
import {
  toLocalDate, isIndexableUserMessage, promptLogEntryFromMessage,
  upsertPromptLog, markCompleted, groupByDateAndSession, prunePromptLog,
} from '../src/domain/prompt-log.js'

const event = (over = {}) => ({
  type: 'user/message',
  seq: 1,
  time: Date.UTC(2026, 10, 6, 3, 0, 0),
  data: {
    message: {
      id: 'm1', role: 'user', source: { kind: 'user', rpcId: 'r1' },
      content: [{ type: 'text', text: '请修复登录问题' }],
    },
    turn: 1,
  },
  ...over,
})

test('filters only user-authored messages', () => {
  assert.equal(isIndexableUserMessage(event()), true)
  assert.equal(isIndexableUserMessage({ type: 'user/message', data: { message: { source: { kind: 'system' } } } }), false)
  assert.equal(isIndexableUserMessage({ type: 'assistant/message' }), false)
})

test('localDate respects the given time zone', () => {
  assert.equal(toLocalDate(Date.UTC(2026, 10, 6, 3, 0, 0), 'Asia/Shanghai'), '2026-11-06')
  assert.equal(toLocalDate(Date.UTC(2026, 10, 5, 20, 0, 0), 'Asia/Shanghai'), '2026-11-06')
  assert.equal(toLocalDate(Date.UTC(2026, 10, 5, 20, 0, 0), 'UTC'), '2026-11-05')
})

test('builds a sent entry from a user message', () => {
  const entry = promptLogEntryFromMessage({
    event: event(), sessionId: 's1', workspaceKey: 'session:s1',
    timeZone: 'Asia/Shanghai', source: 'composer',
  })
  assert.equal(entry.messageId, 'm1')
  assert.equal(entry.status, 'sent')
  assert.equal(entry.excerpt, '请修复登录问题')
  assert.equal(entry.promptText, '请修复登录问题')
  assert.equal(entry.requestId, 'r1')
  assert.equal(entry.localDate, '2026-11-06')
})

test('builds entry with untruncated promptText when prompt is longer than 200 characters (Task 1.1)', () => {
  const longPrompt = 'A'.repeat(500)
  const longEvent = {
    time: 1762340400000,
    data: {
      turn: 1,
      message: {
        id: 'm-long',
        content: [{ type: 'text', text: longPrompt }],
        source: { rpcId: 'r-long' },
      },
    },
  }
  const entry = promptLogEntryFromMessage({
    event: longEvent,
    sessionId: 's1',
    workspaceKey: 'session:s1',
    timeZone: 'UTC',
    source: 'composer',
  })
  assert.equal(entry.excerpt.length, 200, 'excerpt maintains 200-char preview cap')
  assert.equal(entry.promptText.length, 500, 'promptText preserves 100% full text without truncation')
  assert.equal(entry.promptText, longPrompt)
})

test('upsert dedupes by messageId', () => {
  const a = { messageId: 'm1', status: 'queued' }
  const b = { messageId: 'm1', status: 'sent' }
  const list = upsertPromptLog(upsertPromptLog([], a), b)
  assert.equal(list.length, 1)
  assert.equal(list[0].status, 'sent')
})

test('upsert keeps existing fields when the patch omits them', () => {
  const existing = {
    messageId: 'm1', sessionId: 's1', time: 1762340400000,
    localDate: '2026-11-06', turn: 1, status: 'sent',
  }
  const [merged] = upsertPromptLog([existing], { messageId: 'm1', status: 'completed' })
  assert.equal(merged.status, 'completed')
  assert.equal(merged.time, existing.time)
  assert.equal(merged.localDate, '2026-11-06')
  assert.equal(merged.sessionId, 's1')
  assert.equal(merged.turn, 1)
  assert.equal(existing.status, 'sent', 'input entry is not mutated')

  // An explicit `undefined` in the patch must not blank the stored value either.
  const [patchedUndefined] = upsertPromptLog(
    [existing],
    { messageId: 'm1', status: 'completed', time: undefined, localDate: undefined, sessionId: undefined },
  )
  assert.equal(patchedUndefined.time, existing.time)
  assert.equal(patchedUndefined.localDate, '2026-11-06')
  assert.equal(patchedUndefined.sessionId, 's1')
  assert.equal(patchedUndefined.status, 'completed')
})

test('markCompleted only affects earlier turns of the session', () => {
  const list = [
    { messageId: 'm1', sessionId: 's1', turn: 1, status: 'sent' },
    { messageId: 'm2', sessionId: 's1', turn: 2, status: 'sent' },
    { messageId: 'm3', sessionId: 's2', turn: 1, status: 'sent' },
  ]
  const out = markCompleted(list, { sessionId: 's1', turn: 2 })
  assert.equal(out.find(x => x.messageId === 'm1').status, 'completed')
  assert.equal(out.find(x => x.messageId === 'm2').status, 'completed')
  assert.equal(out.find(x => x.messageId === 'm3').status, 'sent')
})

test('groupByDateAndSession sorts newest date, session, and message first', () => {
  const base = Date.UTC(2026, 10, 6, 0, 0, 0)
  const list = [
    { localDate: '2026-11-05', sessionId: 's1', messageId: 'old', time: base - 86400000 },
    { localDate: '2026-11-06', sessionId: 's2', messageId: 'c1', time: base + 2000 },
    { localDate: '2026-11-06', sessionId: 's1', messageId: 'b1', time: base + 1000 },
    { localDate: '2026-11-06', sessionId: 's1', messageId: 'b2', time: base + 3000 },
  ]
  const groups = groupByDateAndSession(list)
  assert.deepEqual(groups.map(group => group.date), ['2026-11-06', '2026-11-05'])
  assert.equal(groups[0].sessions.length, 2)
  // s1 holds the newest message, so it sorts before s2 despite being inserted later.
  assert.deepEqual(groups[0].sessions.map(session => session.sessionId), ['s1', 's2'])
  // Newest message first inside the session, not insertion order.
  assert.deepEqual(groups[0].sessions[0].entries.map(entry => entry.messageId), ['b2', 'b1'])
})

test('prune drops entries outside the day window, not just the cap', () => {
  const now = Date.UTC(2026, 10, 6, 0, 0, 0)
  const day = 86400000
  const list = [
    { localDate: '2026-09-01', time: now - 80 * day, messageId: 'old' },
    { localDate: '2026-11-04', time: now - 2 * day, messageId: 'recent' },
    { localDate: '2026-11-06', time: now, messageId: 'new' },
  ]
  // `max` is far above the result size, so only the day window can remove `old`.
  const kept = prunePromptLog(list, { now, days: 30, max: 100 })
  assert.deepEqual(kept.map(entry => entry.messageId), ['new', 'recent'])
})

test('prune caps the number of entries', () => {
  const now = Date.UTC(2026, 10, 6, 0, 0, 0)
  const list = [
    { localDate: '2026-11-06', time: now - 3000, messageId: 'a' },
    { localDate: '2026-11-06', time: now - 2000, messageId: 'b' },
    { localDate: '2026-11-06', time: now - 1000, messageId: 'c' },
  ]
  assert.deepEqual(prunePromptLog(list, { now, days: 30, max: 2 }).map(entry => entry.messageId), ['c', 'b'])
})
