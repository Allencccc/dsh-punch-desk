import test from 'node:test'
import assert from 'node:assert/strict'
import {
  selectMaterials,
  computeBudget,
  truncateMaterials,
  estimateTokens,
  MAX_PAIR_CHARS,
  MAX_EXCERPT_CHARS,
  MAX_BUDGET_TOKENS,
  OUTPUT_RESERVE_TOKENS,
  TRACE_MAX_AGE_MS,
  CONTEXT_WINDOW_UNAVAILABLE,
} from '../src/domain/distill.js'

const NOW = Date.UTC(2026, 10, 11, 0, 0, 0)
const DAY = 24 * 3600 * 1000
const HEAD_A = 'a'.repeat(40)
const HEAD_B = 'b'.repeat(40)

/**
 * @param {string} type
 * @param {number} seq
 * @param {object} data
 * @returns {object} one raw session event (AGENTS.md §5 shape)
 */
function ev(type, seq, data) {
  return { type, seq, time: NOW + seq * 1000, data }
}

/**
 * @param {string} id
 * @param {string} text
 * @param {object} [over]
 * @returns {object} a genuine user-authored message
 */
function userMsg(id, text, over = {}) {
  return {
    id,
    role: 'user',
    source: { kind: 'user', rpcId: `rpc-${id}` },
    content: [{ type: 'text', text }],
    ...over,
  }
}

/**
 * @param {string} id
 * @param {string} text
 * @param {object} [over]
 * @returns {object}
 */
function assistantMsg(id, text, over = {}) {
  return { id, role: 'assistant', content: [{ type: 'text', text }], ...over }
}

/**
 * One complete turn: turn/start + user/message + assistant/message + turn/end.
 * @param {number} turn
 * @param {{ user?: string, assistant?: string, userId?: string, assistantId?: string,
 *   interrupted?: boolean, dataInterrupted?: boolean, end?: boolean, extra?: object[] }} [opts]
 * @returns {object[]}
 */
function turnBlock(turn, opts = {}) {
  const {
    user = `user prompt ${turn}`,
    assistant = `assistant result ${turn}`,
    userId = `u${turn}`,
    assistantId = `a${turn}`,
    interrupted = false,
    dataInterrupted = false,
    end = true,
    extra = [],
  } = opts
  const base = turn * 100
  const events = [
    ev('turn/start', base, { turn }),
    ev('user/message', base + 1, userMsg(userId, user)),
    ev('assistant/message', base + 2, {
      message: assistantMsg(assistantId, assistant, interrupted ? { interrupted: true } : {}),
      turn,
      ...(dataInterrupted ? { interrupted: true } : {}),
    }),
    ...extra,
  ]
  if (end) events.push(ev('turn/end', base + 9, { turn }))
  return events
}

/**
 * @param {string} id
 * @param {object} [over]
 * @returns {object} a submitted finding anchored to turn 1 by default
 */
function finding(id, over = {}) {
  return {
    id,
    kind: 'finding',
    sessionId: 's1',
    workspaceKey: 'session:s1',
    title: `finding ${id}`,
    body: `body ${id}`,
    submissionStatus: 'submitted',
    reviewStatus: 'pending',
    submittedAt: NOW - DAY,
    createdAt: NOW - 2 * DAY,
    anchors: [{ type: 'message', messageId: 'a1' }],
    ...over,
  }
}

/**
 * @param {object} [over]
 * @returns {object} a qualifying complete CommitTrace for f1 in s1
 */
function trace(over = {}) {
  return {
    id: 'r1#1',
    requestId: 'r1',
    sessionId: 's1',
    workspaceId: 'ws1',
    turn: 1,
    findingIds: ['f1'],
    preHead: HEAD_A,
    postHead: HEAD_B,
    commits: [{ hash: HEAD_B, shortHash: 'bbbbbbb', subject: 'feat: x', time: NOW - DAY }],
    status: 'complete',
    capturedAt: NOW - DAY,
    updatedAt: NOW - DAY,
    ...over,
  }
}

/**
 * @param {object[]} events
 * @param {{ sessionId?: string, archived?: boolean }} [opts]
 * @returns {object} one sessionTurns entry (archived by default)
 */
function session(events, opts = {}) {
  return { sessionId: opts.sessionId ?? 's1', archived: opts.archived ?? true, events }
}

/**
 * @param {object[]} materials
 * @param {string} grade
 * @returns {object[]}
 */
function ofGrade(materials, grade) {
  return materials.filter(material => material.grade === grade)
}

// ---------------------------------------------------------------------------
// 证据等级判定 (spec §6.2)
// ---------------------------------------------------------------------------

test('resolved grade requires reviewStatus resolved AND completedVia group-wrap-up', () => {
  const result = selectMaterials({
    findings: [finding('f1', { reviewStatus: 'resolved', completedVia: 'group-wrap-up', resolvedAt: NOW })],
    sessionTurns: [session(turnBlock(1))],
  })
  assert.equal(result.materialCount, 1)
  assert.equal(result.materials[0].grade, 'resolved')
  assert.equal(result.materials[0].pendingConfirmation, false)
  assert.deepEqual(result.byGrade, { resolved: 1, commit: 0, submitted: 0, dismissed: 0 })
})

test('resolved without group-wrap-up falls back to the submitted ladder', () => {
  const result = selectMaterials({
    findings: [
      finding('f1', { reviewStatus: 'resolved', completedVia: 'manual' }),
      finding('f2', { reviewStatus: 'resolved' }),
    ],
    sessionTurns: [session(turnBlock(1))],
  })
  assert.deepEqual(result.materials.map(m => m.grade), ['submitted', 'submitted'])
  assert.equal(result.byGrade.resolved, 0)
  assert.equal(result.byGrade.submitted, 2)
})

test('submitted finding with a qualifying commit trace grades commit and attaches evidence', () => {
  const result = selectMaterials({
    findings: [finding('f1')],
    commitTraces: [trace()],
    sessionTurns: [session(turnBlock(1))],
  })
  const material = result.materials[0]
  assert.equal(material.grade, 'commit')
  assert.equal(material.traceId, 'r1#1')
  assert.equal(material.preHead, HEAD_A)
  assert.equal(material.postHead, HEAD_B)
  assert.deepEqual(material.commits, [{ hash: HEAD_B, shortHash: 'bbbbbbb', subject: 'feat: x', time: NOW - DAY }])
  assert.deepEqual(result.byGrade, { resolved: 0, commit: 1, submitted: 0, dismissed: 0 })
})

test('submitted finding without a trace grades submitted and is pending confirmation', () => {
  const result = selectMaterials({
    findings: [finding('f1')],
    sessionTurns: [session(turnBlock(1))],
  })
  assert.equal(result.materials[0].grade, 'submitted')
  assert.equal(result.materials[0].pendingConfirmation, true)
  assert.equal(result.materials[0].commits, undefined)
})

test('open and unsubmitted findings are excluded from materials and byGrade', () => {
  const result = selectMaterials({
    findings: [
      finding('f1', { submissionStatus: 'unsubmitted', reviewStatus: 'pending' }),
      finding('f2', { status: 'open', submissionStatus: undefined, reviewStatus: undefined }),
      finding('f3'),
    ],
    sessionTurns: [session(turnBlock(1))],
  })
  assert.equal(result.materialCount, 1)
  assert.deepEqual(result.materials.map(m => m.findingId), ['f3'])
  assert.deepEqual(result.byGrade, { resolved: 0, commit: 0, submitted: 1, dismissed: 0 })
})

test('dismissed findings are negative context only: counted, no pair text, zero tokens', () => {
  const result = selectMaterials({
    findings: [finding('f1', { reviewStatus: 'dismissed' })],
    sessionTurns: [session(turnBlock(1))],
  })
  const material = result.materials[0]
  assert.equal(material.grade, 'dismissed')
  assert.equal(material.negativeContext, true)
  assert.equal(material.text, '')
  assert.equal(material.userText, '')
  assert.equal(material.assistantText, '')
  assert.equal(material.tokens, 0)
  assert.equal(material.turn, null)
  assert.equal(material.anchored, false)
  assert.deepEqual(result.byGrade, { resolved: 0, commit: 0, submitted: 0, dismissed: 1 })
  assert.equal(result.materialCount, 1)
})

test('legacy status dismissed without reviewStatus is dismissed', () => {
  const result = selectMaterials({
    findings: [finding('f1', { status: 'dismissed', reviewStatus: undefined, submissionStatus: undefined })],
    sessionTurns: [session(turnBlock(1))],
  })
  assert.equal(result.materials[0].grade, 'dismissed')
})

test('legacy status sent is treated as submitted', () => {
  const result = selectMaterials({
    findings: [finding('f1', { status: 'sent', reviewStatus: undefined, submissionStatus: undefined })],
    sessionTurns: [session(turnBlock(1))],
  })
  assert.equal(result.materials[0].grade, 'submitted')
})

test('a trace with zero commits (equal heads) is not commit evidence', () => {
  const result = selectMaterials({
    findings: [finding('f1')],
    commitTraces: [trace({ preHead: HEAD_A, postHead: HEAD_A, commits: [] })],
    sessionTurns: [session(turnBlock(1))],
  })
  assert.equal(result.materials[0].grade, 'submitted')
})

test('a trace without 40-hex preHead/postHead is not commit evidence', () => {
  const result = selectMaterials({
    findings: [finding('f1'), finding('f2', { anchors: [{ type: 'message', messageId: 'a1' }] })],
    commitTraces: [
      trace({ preHead: 'abc123' }),
      trace({ id: 'r2#1', findingIds: ['f2'], postHead: undefined }),
    ],
    sessionTurns: [session(turnBlock(1))],
  })
  assert.deepEqual(result.materials.map(m => m.grade), ['submitted', 'submitted'])
})

test('a failed trace is not commit evidence', () => {
  const result = selectMaterials({
    findings: [finding('f1')],
    commitTraces: [trace({ status: 'failed', commits: [] })],
    sessionTurns: [session(turnBlock(1))],
  })
  assert.equal(result.materials[0].grade, 'submitted')
})

test('a trace hitting another finding id is not commit evidence', () => {
  const result = selectMaterials({
    findings: [finding('f1')],
    commitTraces: [trace({ findingIds: ['someone-else'] })],
    sessionTurns: [session(turnBlock(1))],
  })
  assert.equal(result.materials[0].grade, 'submitted')
})

test('a trace from another session is not commit evidence', () => {
  const result = selectMaterials({
    findings: [finding('f1')],
    commitTraces: [trace({ sessionId: 's2' })],
    sessionTurns: [session(turnBlock(1))],
  })
  assert.equal(result.materials[0].grade, 'submitted')
})

test('among multiple qualifying traces the newest one is attached', () => {
  const result = selectMaterials({
    findings: [finding('f1')],
    commitTraces: [
      trace({ id: 'old#1', capturedAt: NOW - 5 * DAY, commits: [{ hash: HEAD_A, subject: 'old', time: NOW - 5 * DAY }] }),
      trace({ id: 'new#2', turn: 2, capturedAt: NOW - DAY, commits: [{ hash: HEAD_B, subject: 'new', time: NOW - DAY }] }),
    ],
    sessionTurns: [session(turnBlock(1))],
  })
  assert.equal(result.materials[0].traceId, 'new#2')
  assert.equal(result.materials[0].commits[0].subject, 'new')
})

test('commitTraces accepts the store per-session bucket map shape', () => {
  const result = selectMaterials({
    findings: [finding('f1')],
    commitTraces: { 'session:s1': [trace()] },
    sessionTurns: [session(turnBlock(1))],
  })
  assert.equal(result.materials[0].grade, 'commit')
})

// ---------------------------------------------------------------------------
// commitTraces 超期降级 (spec §6.2, mirrors store pruneCommitTraces)
// ---------------------------------------------------------------------------

test('an expired trace demotes commit to submitted and byGrade records the demotion', () => {
  const result = selectMaterials({
    findings: [finding('f1')],
    commitTraces: [trace({ capturedAt: NOW - TRACE_MAX_AGE_MS - DAY })],
    sessionTurns: [session(turnBlock(1))],
    now: NOW,
  })
  assert.equal(result.materials[0].grade, 'submitted')
  assert.equal(result.materials[0].commits, undefined)
  assert.deepEqual(result.byGrade, { resolved: 0, commit: 0, submitted: 1, dismissed: 0 })
})

test('a trace exactly at the 30-day boundary still qualifies', () => {
  const result = selectMaterials({
    findings: [finding('f1')],
    commitTraces: [trace({ capturedAt: NOW - TRACE_MAX_AGE_MS })],
    sessionTurns: [session(turnBlock(1))],
    now: NOW,
  })
  assert.equal(result.materials[0].grade, 'commit')
})

test('legacy traces without any timestamp are not demoted', () => {
  const result = selectMaterials({
    findings: [finding('f1')],
    commitTraces: [trace({ capturedAt: undefined, updatedAt: undefined })],
    sessionTurns: [session(turnBlock(1))],
    now: NOW,
  })
  assert.equal(result.materials[0].grade, 'commit')
})

test('without injected now the bucket is trusted as already pruned', () => {
  const result = selectMaterials({
    findings: [finding('f1')],
    commitTraces: [trace({ capturedAt: NOW - 400 * DAY })],
    sessionTurns: [session(turnBlock(1))],
  })
  assert.equal(result.materials[0].grade, 'commit')
})

test('expiry falls back to updatedAt when capturedAt is missing', () => {
  const result = selectMaterials({
    findings: [finding('f1')],
    commitTraces: [trace({ capturedAt: undefined, updatedAt: NOW - TRACE_MAX_AGE_MS - DAY })],
    sessionTurns: [session(turnBlock(1))],
    now: NOW,
  })
  assert.equal(result.materials[0].grade, 'submitted')
})

// ---------------------------------------------------------------------------
// messageId → turn 反查表与结果对抽取 (spec §6.3)
// ---------------------------------------------------------------------------

test('the messageId reverse lookup wins over an unreliable anchor turn', () => {
  const events = [...turnBlock(1), ...turnBlock(2), ...turnBlock(3)]
  const result = selectMaterials({
    findings: [finding('f1', { anchors: [{ type: 'message', messageId: 'a2', turn: 1 }] })],
    sessionTurns: [session(events)],
  })
  const material = result.materials[0]
  assert.equal(material.turn, 2)
  assert.equal(material.turnSource, 'lookup')
  assert.equal(material.messageId, 'a2')
  assert.ok(material.text.includes('user prompt 2'))
  assert.ok(material.text.includes('assistant result 2'))
  assert.ok(!material.text.includes('assistant result 1'))
})

test('a capture anchor carrying only messageId resolves via turn/start order', () => {
  const events = [...turnBlock(1), ...turnBlock(2), ...turnBlock(3)]
  const result = selectMaterials({
    findings: [finding('f1', { anchors: [{ type: 'message', messageId: 'a3' }] })],
    sessionTurns: [session(events)],
  })
  assert.equal(result.materials[0].turn, 3)
  assert.ok(result.materials[0].text.includes('assistant result 3'))
})

test('a quote anchor resolves through the reverse index, not its own turn', () => {
  const events = [...turnBlock(1), ...turnBlock(2)]
  const result = selectMaterials({
    findings: [finding('f1', { anchors: [{ type: 'quote', messageId: 'a2', turn: 99, text: 'quoted' }] })],
    sessionTurns: [session(events)],
  })
  assert.equal(result.materials[0].turn, 2)
})

test('a turn-only anchor uses its turn when no messageId resolves', () => {
  const events = [...turnBlock(1), ...turnBlock(2)]
  const result = selectMaterials({
    findings: [finding('f1', { anchors: [{ type: 'turn', turn: 2 }] })],
    sessionTurns: [session(events)],
  })
  const material = result.materials[0]
  assert.equal(material.turn, 2)
  assert.equal(material.messageId, null)
  assert.equal(material.turnSource, 'anchor')
})

test('an unknown messageId falls back to the anchor turn hint', () => {
  const events = [...turnBlock(1), ...turnBlock(2)]
  const result = selectMaterials({
    findings: [finding('f1', { anchors: [{ type: 'message', messageId: 'ghost', turn: 2 }] })],
    sessionTurns: [session(events)],
  })
  const material = result.materials[0]
  assert.equal(material.turn, 2)
  assert.equal(material.turnSource, 'anchor-fallback')
})

test('the reverse index prefers a resolvable later anchor over an earlier fallback', () => {
  const events = [...turnBlock(1), ...turnBlock(2)]
  const result = selectMaterials({
    findings: [finding('f1', {
      anchors: [
        { type: 'message', messageId: 'ghost', turn: 1 },
        { type: 'message', messageId: 'a2' },
      ],
    })],
    sessionTurns: [session(events)],
  })
  assert.equal(result.materials[0].turn, 2)
  assert.equal(result.materials[0].turnSource, 'lookup')
})

test('tool/call and tool/result bodies never enter material text', () => {
  const events = turnBlock(1, {
    extra: [
      ev('tool/call', 105, { id: 't1', name: 'bash', arguments: { command: 'SECRET_TOOL_ARG' } }),
      ev('tool/result', 106, { id: 't1', content: [{ type: 'text', text: 'SECRET_TOOL_RESULT' }] }),
    ],
  })
  const result = selectMaterials({
    findings: [finding('f1')],
    sessionTurns: [session(events)],
  })
  const material = result.materials[0]
  assert.ok(!material.text.includes('SECRET_TOOL_ARG'))
  assert.ok(!material.text.includes('SECRET_TOOL_RESULT'))
  assert.ok(material.text.includes('user prompt 1'))
  assert.ok(material.text.includes('assistant result 1'))
})

test('synthetic user messages are not treated as the turn prompt', () => {
  const base = 100
  const events = [
    ev('turn/start', base, { turn: 1 }),
    ev('user/message', base + 1, userMsg('synthetic', 'SYNTHETIC PROMPT', { source: { kind: 'synthetic' } })),
    ev('user/message', base + 2, userMsg('u1', 'real prompt')),
    ev('assistant/message', base + 3, { message: assistantMsg('a1', 'real answer'), turn: 1 }),
    ev('turn/end', base + 9, { turn: 1 }),
  ]
  const result = selectMaterials({
    findings: [finding('f1')],
    sessionTurns: [session(events)],
  })
  const material = result.materials[0]
  assert.ok(material.text.includes('real prompt'))
  assert.ok(!material.text.includes('SYNTHETIC PROMPT'))
})

test('the last non-interrupted assistant message before turn/end wins', () => {
  const events = turnBlock(1, {
    assistant: 'first complete answer',
    extra: [
      ev('assistant/message', 107, { message: assistantMsg('a1-tail', 'interrupted tail', { interrupted: true }), turn: 1 }),
    ],
  })
  const result = selectMaterials({
    findings: [finding('f1')],
    sessionTurns: [session(events)],
  })
  const material = result.materials[0]
  assert.ok(material.text.includes('first complete answer'))
  assert.ok(!material.text.includes('interrupted tail'))
})

test('an interrupted flag on the event data is honored too', () => {
  const events = turnBlock(1, { assistant: 'complete answer', dataInterrupted: false, extra: [
    ev('assistant/message', 107, { message: assistantMsg('a1-tail', 'data-interrupted tail'), turn: 1, interrupted: true }),
  ] })
  const result = selectMaterials({
    findings: [finding('f1')],
    sessionTurns: [session(events)],
  })
  assert.ok(result.materials[0].text.includes('complete answer'))
  assert.ok(!result.materials[0].text.includes('data-interrupted tail'))
})

test('a turn with only interrupted assistants yields no pair', () => {
  const events = turnBlock(1, { interrupted: true })
  const result = selectMaterials({
    findings: [finding('f1')],
    sessionTurns: [session(events)],
  })
  const material = result.materials[0]
  assert.equal(material.anchored, true)
  assert.equal(material.turn, 1)
  assert.equal(material.text, '')
  assert.equal(material.tokens, 0)
})

test('an unfinished turn without turn/end yields no pair', () => {
  const events = turnBlock(1, { end: false })
  const result = selectMaterials({
    findings: [finding('f1')],
    sessionTurns: [session(events)],
  })
  assert.equal(result.materials[0].text, '')
})

test('messages after turn/end do not join the result pair', () => {
  const events = [
    ...turnBlock(1, { assistant: 'ended answer' }),
    ev('assistant/message', 110, { message: assistantMsg('a1-late', 'late stray message'), turn: 1 }),
  ]
  const result = selectMaterials({
    findings: [finding('f1')],
    sessionTurns: [session(events)],
  })
  const material = result.materials[0]
  assert.ok(material.text.includes('ended answer'))
  assert.ok(!material.text.includes('late stray message'))
})

test('the full user prompt joins all text blocks and skips non-text blocks', () => {
  const events = [
    ev('turn/start', 100, { turn: 1 }),
    ev('user/message', 101, {
      id: 'u1',
      role: 'user',
      source: { kind: 'user' },
      content: [
        { type: 'text', text: 'line one' },
        { type: 'image', url: 'x' },
        { type: 'text', text: 'line two' },
      ],
    }),
    ev('assistant/message', 102, { message: assistantMsg('a1', 'answer'), turn: 1 }),
    ev('turn/end', 109, { turn: 1 }),
  ]
  const result = selectMaterials({
    findings: [finding('f1')],
    sessionTurns: [session(events)],
  })
  assert.ok(result.materials[0].userText.includes('line one\nline two'))
})

test('an unanchored finding is counted but carries no pair', () => {
  const result = selectMaterials({
    findings: [finding('f1', { anchors: [] })],
    sessionTurns: [session(turnBlock(1))],
  })
  const material = result.materials[0]
  assert.equal(result.byGrade.submitted, 1)
  assert.equal(material.anchored, false)
  assert.equal(material.text, '')
})

test('a finding whose session history is missing is counted but carries no pair', () => {
  const result = selectMaterials({
    findings: [finding('f1')],
    sessionTurns: [],
  })
  assert.equal(result.byGrade.submitted, 1)
  assert.equal(result.materials[0].text, '')
  assert.equal(result.materials[0].anchored, false)
})

test('two findings anchoring the same turn both receive the pair', () => {
  const result = selectMaterials({
    findings: [
      finding('f1', { reviewStatus: 'resolved', completedVia: 'group-wrap-up' }),
      finding('f2'),
    ],
    sessionTurns: [session(turnBlock(1))],
  })
  assert.equal(result.materialCount, 2)
  for (const material of result.materials) {
    assert.ok(material.text.includes('assistant result 1'))
  }
})

// ---------------------------------------------------------------------------
// 代码块折叠与单 turn 20k 上限 (spec §6.3 item 3)
// ---------------------------------------------------------------------------

test('code blocks fold to path + line count + first 10 lines', () => {
  const lines = Array.from({ length: 25 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`)
  const assistant = `before\n\`\`\`src/domain/a.js\n${lines.join('\n')}\n\`\`\`\nafter`
  const result = selectMaterials({
    findings: [finding('f1')],
    sessionTurns: [session(turnBlock(1, { assistant }))],
  })
  const text = result.materials[0].assistantText
  assert.ok(text.includes('路径: src/domain/a.js'))
  assert.ok(text.includes('共 25 行'))
  assert.ok(text.includes('L01'))
  assert.ok(text.includes('L10'))
  assert.ok(!text.includes('L11'))
  assert.ok(!text.includes('L25'))
  assert.ok(text.includes('before'))
  assert.ok(text.includes('after'))
})

test('a language-only fence folds with a language label', () => {
  const assistant = '```js\nconsole.log(1)\n```'
  const result = selectMaterials({
    findings: [finding('f1')],
    sessionTurns: [session(turnBlock(1, { assistant }))],
  })
  const text = result.materials[0].assistantText
  assert.ok(text.includes('语言: js'))
  assert.ok(text.includes('共 1 行'))
  assert.ok(text.includes('console.log(1)'))
})

test('an unclosed fence folds through the end of the text', () => {
  const assistant = 'intro\n```py\nprint(1)\nprint(2)'
  const result = selectMaterials({
    findings: [finding('f1')],
    sessionTurns: [session(turnBlock(1, { assistant }))],
  })
  const text = result.materials[0].assistantText
  assert.ok(text.includes('共 2 行'))
  assert.ok(text.includes('print(2)'))
})

test('a short code block keeps all of its lines in the fold', () => {
  const assistant = '```\na\nb\nc\n```'
  const result = selectMaterials({
    findings: [finding('f1')],
    sessionTurns: [session(turnBlock(1, { assistant }))],
  })
  const text = result.materials[0].assistantText
  assert.ok(text.includes('共 3 行'))
  assert.ok(text.includes('a\nb\nc'))
})

test('code folding also applies to the user prompt', () => {
  const user = 'please refactor\n```src/a.js\nx\n```'
  const result = selectMaterials({
    findings: [finding('f1')],
    sessionTurns: [session(turnBlock(1, { user }))],
  })
  assert.ok(result.materials[0].userText.includes('路径: src/a.js'))
})

test('a pair over 20k chars keeps paragraph head and tail and marks truncation', () => {
  const paragraphs = Array.from({ length: 40 }, (_, i) => `PARA-${String(i).padStart(2, '0')} ${'x'.repeat(600)}`)
  const assistant = paragraphs.join('\n\n')
  const result = selectMaterials({
    findings: [finding('f1')],
    sessionTurns: [session(turnBlock(1, { assistant }))],
  })
  const material = result.materials[0]
  assert.equal(material.pairTruncated, true)
  assert.ok(material.text.length <= MAX_PAIR_CHARS)
  assert.ok(material.text.includes('PARA-00'))
  assert.ok(material.text.includes('PARA-39'))
  assert.ok(material.text.includes('中间截断'))
  assert.ok(!material.text.includes('PARA-20'))
})

test('a pair at exactly 20k chars is not truncated', () => {
  // pair overhead: '[user]\n' (7) + '\n\n[assistant]\n' (14) = 21 chars
  const user = 'u'.repeat(100)
  const assistant = 'a'.repeat(MAX_PAIR_CHARS - 21 - 100)
  const result = selectMaterials({
    findings: [finding('f1')],
    sessionTurns: [session(turnBlock(1, { user, assistant }))],
  })
  const material = result.materials[0]
  assert.equal(material.text.length, MAX_PAIR_CHARS)
  assert.equal(material.pairTruncated, false)
})

test('one char beyond the 20k cap triggers truncation', () => {
  const user = 'u'.repeat(100)
  const assistant = 'a'.repeat(MAX_PAIR_CHARS - 21 - 100 + 1)
  const result = selectMaterials({
    findings: [finding('f1')],
    sessionTurns: [session(turnBlock(1, { user, assistant }))],
  })
  const material = result.materials[0]
  assert.equal(material.pairTruncated, true)
  assert.ok(material.text.length <= MAX_PAIR_CHARS)
})

// ---------------------------------------------------------------------------
// 会话级 ±1 相邻 turn 与未锚定首段 (spec §6.3 items 2/4)
// ---------------------------------------------------------------------------

test('adjacent unanchored turns contribute first-paragraph excerpts capped at 500', () => {
  const events = [
    ...turnBlock(1, { assistant: 'neighbor one first para\n\nneighbor one second para' }),
    ...turnBlock(2),
    ...turnBlock(3, { assistant: `${'y'.repeat(800)}\n\ntail para` }),
  ]
  const result = selectMaterials({
    findings: [finding('f1', { anchors: [{ type: 'message', messageId: 'a2' }] })],
    sessionTurns: [session(events)],
  })
  const material = result.materials[0]
  assert.deepEqual(material.contextTurns.map(c => c.turn), [1, 3])
  assert.equal(material.contextTurns[0].excerpt, 'neighbor one first para')
  assert.equal(material.contextTurns[1].excerpt.length, MAX_EXCERPT_CHARS)
  assert.ok(!material.contextTurns[1].excerpt.includes('tail para'))
  assert.ok(!material.text.includes('neighbor one'))
})

test('anchored neighbor turns are not duplicated as excerpts', () => {
  const events = [...turnBlock(1), ...turnBlock(2), ...turnBlock(3)]
  const result = selectMaterials({
    findings: [
      finding('f1', { anchors: [{ type: 'message', messageId: 'a1' }] }),
      finding('f2', { anchors: [{ type: 'message', messageId: 'a2' }] }),
    ],
    sessionTurns: [session(events)],
  })
  const byFinding = Object.fromEntries(result.materials.map(m => [m.findingId, m]))
  assert.deepEqual(byFinding.f1.contextTurns, [])
  assert.deepEqual(byFinding.f2.contextTurns.map(c => c.turn), [3])
})

test('non-adjacent turns never enter context', () => {
  const events = [1, 2, 3, 4, 5].flatMap(turn => turnBlock(turn))
  const result = selectMaterials({
    findings: [finding('f1', { anchors: [{ type: 'message', messageId: 'a3' }] })],
    sessionTurns: [session(events)],
  })
  assert.deepEqual(result.materials[0].contextTurns.map(c => c.turn), [2, 4])
})

test('an unfinished or interrupted-only neighbor yields no excerpt', () => {
  const events = [
    ...turnBlock(1, { end: false }),
    ...turnBlock(2),
    ...turnBlock(3, { interrupted: true }),
  ]
  const result = selectMaterials({
    findings: [finding('f1', { anchors: [{ type: 'message', messageId: 'a2' }] })],
    sessionTurns: [session(events)],
  })
  assert.deepEqual(result.materials[0].contextTurns, [])
})

// ---------------------------------------------------------------------------
// 未归档会话降级「待确认」(spec §6.2 / §16.13)
// ---------------------------------------------------------------------------

test('an unarchived session demotes resolved conclusions to pending confirmation', () => {
  const result = selectMaterials({
    findings: [finding('f1', { reviewStatus: 'resolved', completedVia: 'group-wrap-up' })],
    sessionTurns: [session(turnBlock(1), { archived: false })],
  })
  const material = result.materials[0]
  assert.equal(material.grade, 'resolved')
  assert.equal(material.pendingConfirmation, true)
})

test('an unarchived session keeps commit grade without pending confirmation', () => {
  const result = selectMaterials({
    findings: [finding('f1')],
    commitTraces: [trace()],
    sessionTurns: [session(turnBlock(1), { archived: false })],
  })
  const material = result.materials[0]
  assert.equal(material.grade, 'commit')
  assert.equal(material.pendingConfirmation, false)
})

test('an archived session resolved conclusion is not pending confirmation', () => {
  const result = selectMaterials({
    findings: [finding('f1', { reviewStatus: 'resolved', completedVia: 'group-wrap-up' })],
    sessionTurns: [session(turnBlock(1), { archived: true })],
  })
  assert.equal(result.materials[0].pendingConfirmation, false)
})

test('submitted is always pending confirmation even in archived sessions', () => {
  const result = selectMaterials({
    findings: [finding('f1')],
    sessionTurns: [session(turnBlock(1), { archived: true })],
  })
  assert.equal(result.materials[0].pendingConfirmation, true)
})

test('a missing archived flag defaults to in-progress demotion', () => {
  const result = selectMaterials({
    findings: [finding('f1', { reviewStatus: 'resolved', completedVia: 'group-wrap-up' })],
    sessionTurns: [{ sessionId: 's1', events: turnBlock(1) }],
  })
  assert.equal(result.materials[0].pendingConfirmation, true)
})

// ---------------------------------------------------------------------------
// 排序与截断顺序 (spec §6.3 item 5)
// ---------------------------------------------------------------------------

test('materials sort by evidence grade then time recency', () => {
  const events = [1, 2, 3, 4].flatMap(turn => turnBlock(turn))
  const result = selectMaterials({
    findings: [
      finding('f-submitted', { anchors: [{ type: 'message', messageId: 'a4' }] }),
      finding('f-resolved-old', { reviewStatus: 'resolved', completedVia: 'group-wrap-up', anchors: [{ type: 'message', messageId: 'a1' }] }),
      finding('f-dismissed', { reviewStatus: 'dismissed' }),
      finding('f-commit', { anchors: [{ type: 'message', messageId: 'a2' }] }),
      finding('f-resolved-new', { reviewStatus: 'resolved', completedVia: 'group-wrap-up', anchors: [{ type: 'message', messageId: 'a3' }] }),
    ],
    commitTraces: [trace({ findingIds: ['f-commit'] })],
    sessionTurns: [session(events)],
  })
  assert.deepEqual(result.materials.map(m => m.findingId), [
    'f-resolved-new', 'f-resolved-old', 'f-commit', 'f-submitted', 'f-dismissed',
  ])
  assert.equal(result.materialCount, 5)
  assert.deepEqual(result.byGrade, { resolved: 2, commit: 1, submitted: 1, dismissed: 1 })
})

test('truncateMaterials keeps the high-grade prefix and flags truncation', () => {
  const materials = [
    { findingId: 'm1', grade: 'resolved', time: 5, tokens: 100 },
    { findingId: 'm2', grade: 'commit', time: 4, tokens: 100 },
    { findingId: 'm3', grade: 'submitted', time: 3, tokens: 100 },
    { findingId: 'm4', grade: 'submitted', time: 2, tokens: 100 },
    { findingId: 'm5', grade: 'dismissed', time: 1, tokens: 50 },
  ]
  const result = truncateMaterials(materials, 250)
  assert.deepEqual(result.materials.map(m => m.findingId), ['m1', 'm2'])
  assert.equal(result.usedTokens, 200)
  assert.equal(result.truncated, true)
})

test('truncateMaterials drops dismissed negative context before writable grades', () => {
  const materials = [
    { findingId: 'm-dismissed', grade: 'dismissed', time: 9, tokens: 50 },
    { findingId: 'm-resolved', grade: 'resolved', time: 1, tokens: 100 },
  ]
  const result = truncateMaterials(materials, 120)
  assert.deepEqual(result.materials.map(m => m.findingId), ['m-resolved'])
  assert.equal(result.truncated, true)
})

test('truncateMaterials drops the older submitted material first', () => {
  const materials = [
    { findingId: 'older', grade: 'submitted', time: 2, tokens: 100 },
    { findingId: 'newer', grade: 'submitted', time: 3, tokens: 100 },
  ]
  const result = truncateMaterials(materials, 150)
  assert.deepEqual(result.materials.map(m => m.findingId), ['newer'])
  assert.equal(result.usedTokens, 100)
  assert.equal(result.truncated, true)
})

test('truncateMaterials keeps everything when the budget fits', () => {
  const materials = [
    { findingId: 'm1', grade: 'resolved', time: 2, tokens: 100 },
    { findingId: 'm2', grade: 'dismissed', time: 1, tokens: 0 },
  ]
  const result = truncateMaterials(materials, 100)
  assert.equal(result.materials.length, 2)
  assert.equal(result.usedTokens, 100)
  assert.equal(result.truncated, false)
})

test('truncateMaterials with a single oversized material keeps nothing', () => {
  const materials = [{ findingId: 'big', grade: 'resolved', time: 1, tokens: 500 }]
  const result = truncateMaterials(materials, 100)
  assert.deepEqual(result.materials, [])
  assert.equal(result.usedTokens, 0)
  assert.equal(result.truncated, true)
})

test('truncateMaterials re-sorts unordered input before truncating', () => {
  const materials = [
    { findingId: 'm3', grade: 'submitted', time: 3, tokens: 100 },
    { findingId: 'm1', grade: 'resolved', time: 5, tokens: 100 },
    { findingId: 'm2', grade: 'commit', time: 4, tokens: 100 },
  ]
  const result = truncateMaterials(materials, 200)
  assert.deepEqual(result.materials.map(m => m.findingId), ['m1', 'm2'])
  assert.equal(result.truncated, true)
})

test('truncateMaterials with a non-positive budget keeps nothing', () => {
  const materials = [{ findingId: 'm1', grade: 'resolved', time: 1, tokens: 10 }]
  for (const budget of [0, -5, NaN, undefined]) {
    const result = truncateMaterials(materials, budget)
    assert.deepEqual(result.materials, [])
    assert.equal(result.truncated, true)
  }
  assert.deepEqual(truncateMaterials([], 0), { materials: [], usedTokens: 0, truncated: false })
})

test('selectMaterials output feeds truncateMaterials end to end', () => {
  const events = [1, 2, 3].flatMap(turn => turnBlock(turn, { assistant: 'x'.repeat(4000) }))
  const { materials } = selectMaterials({
    findings: [
      finding('f-resolved', { reviewStatus: 'resolved', completedVia: 'group-wrap-up', anchors: [{ type: 'message', messageId: 'a1' }] }),
      finding('f-submitted-old', { anchors: [{ type: 'message', messageId: 'a2' }] }),
      finding('f-submitted-new', { anchors: [{ type: 'message', messageId: 'a3' }] }),
    ],
    sessionTurns: [session(events)],
  })
  const budget = computeBudget({ contextWindow: 11000, materialTokens: materials.reduce((sum, m) => sum + m.tokens, 0) })
  assert.equal(budget.ok, true)
  assert.equal(budget.truncated, true)
  const result = truncateMaterials(materials, budget.maxTokens)
  assert.equal(result.truncated, true)
  assert.ok(result.usedTokens <= budget.maxTokens)
  assert.equal(result.materials[0].findingId, 'f-resolved')
  assert.ok(result.materials.every(m => m.grade !== 'dismissed'))
})

// ---------------------------------------------------------------------------
// 空素材
// ---------------------------------------------------------------------------

test('empty inputs yield empty materials and zero byGrade', () => {
  const result = selectMaterials()
  assert.deepEqual(result.materials, [])
  assert.deepEqual(result.byGrade, { resolved: 0, commit: 0, submitted: 0, dismissed: 0 })
  assert.equal(result.materialCount, 0)
  assert.deepEqual(selectMaterials({ findings: [], commitTraces: [], sessionTurns: [] }), result)
})

test('all-open findings yield empty materials', () => {
  const result = selectMaterials({
    findings: [finding('f1', { submissionStatus: 'unsubmitted' })],
    sessionTurns: [session(turnBlock(1))],
  })
  assert.equal(result.materialCount, 0)
  assert.deepEqual(result.byGrade, { resolved: 0, commit: 0, submitted: 0, dismissed: 0 })
})

test('malformed findings and session entries are skipped defensively', () => {
  const result = selectMaterials({
    findings: [null, {}, { id: '' }, finding('f1')],
    sessionTurns: [null, { events: [] }, session(turnBlock(1))],
  })
  assert.equal(result.materialCount, 1)
  assert.equal(result.materials[0].findingId, 'f1')
})

// ---------------------------------------------------------------------------
// computeBudget 与 CONTEXT_WINDOW_UNAVAILABLE (spec §6.3 item 5 / §16.17)
// ---------------------------------------------------------------------------

test('budget subtracts the output reserve from contextWindow', () => {
  const result = computeBudget({ contextWindow: 100000, materialTokens: 1000 })
  assert.deepEqual(result, { ok: true, maxTokens: 100000 - OUTPUT_RESERVE_TOKENS, usedTokens: 1000, truncated: false })
})

test('budget caps at 200k tokens', () => {
  const result = computeBudget({ contextWindow: 1000000, materialTokens: 0 })
  assert.equal(result.ok, true)
  assert.equal(result.maxTokens, MAX_BUDGET_TOKENS)
  assert.equal(result.truncated, false)
})

test('budget flags truncated when materialTokens exceed maxTokens', () => {
  const result = computeBudget({ contextWindow: 20000, materialTokens: 50000 })
  assert.equal(result.ok, true)
  assert.equal(result.maxTokens, 20000 - OUTPUT_RESERVE_TOKENS)
  assert.equal(result.truncated, true)
})

test('missing contextWindow rejects with CONTEXT_WINDOW_UNAVAILABLE', () => {
  for (const input of [{}, { materialTokens: 10 }, { contextWindow: undefined }, { contextWindow: null }]) {
    const result = computeBudget(input)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, CONTEXT_WINDOW_UNAVAILABLE)
    assert.ok(typeof result.error.message === 'string' && result.error.message.length > 0)
  }
})

test('non-numeric or NaN contextWindow rejects without guessing a default', () => {
  for (const contextWindow of ['100000', NaN, Infinity, {}, true]) {
    const result = computeBudget({ contextWindow, materialTokens: 1 })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, CONTEXT_WINDOW_UNAVAILABLE)
  }
})

test('zero or negative contextWindow rejects', () => {
  for (const contextWindow of [0, -100]) {
    const result = computeBudget({ contextWindow })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, CONTEXT_WINDOW_UNAVAILABLE)
  }
})

test('contextWindow equal to the output reserve rejects (budget 0)', () => {
  const result = computeBudget({ contextWindow: OUTPUT_RESERVE_TOKENS })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, CONTEXT_WINDOW_UNAVAILABLE)
})

test('contextWindow below the output reserve rejects (negative budget)', () => {
  const result = computeBudget({ contextWindow: OUTPUT_RESERVE_TOKENS - 1 })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, CONTEXT_WINDOW_UNAVAILABLE)
})

test('contextWindow just above the reserve yields a positive budget', () => {
  const result = computeBudget({ contextWindow: OUTPUT_RESERVE_TOKENS + 1, materialTokens: 1 })
  assert.equal(result.ok, true)
  assert.equal(result.maxTokens, 1)
  assert.equal(result.truncated, false)
})

test('empty materials still require a usable contextWindow', () => {
  assert.equal(computeBudget({ materialTokens: 0 }).ok, false)
  const ok = computeBudget({ contextWindow: 100000, materialTokens: 0 })
  assert.equal(ok.ok, true)
  assert.equal(ok.truncated, false)
  assert.equal(ok.usedTokens, 0)
})

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

test('estimateTokens counts CJK as one token and other chars as a quarter', () => {
  assert.equal(estimateTokens('中文'), 2)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens(null), 0)
  assert.equal(estimateTokens('中文abcd'), 3)
})