import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDispositionSection,
  verdictOf,
  mapVerdict,
  classifyFinalAnswer,
  itemOriginKey,
  findFindingByOriginKey,
  mergeTurnActionItems,
  matchPromptLogFinding,
  deriveTurnDigests,
  convertTurnActionToFinding,
  QUOTE_MAX_BYTES,
  BODY_MAX_BYTES,
  TITLE_MAX_CHARS,
} from '../src/domain/turn-actions.js'
import {
  createEntry,
  createFindingRecord,
  migrateFinding,
} from '../src/domain/entries.js'

// ============================================================================
// Acceptance Criteria §11.1 (16 Criteria)
// ============================================================================

test('AC 1: "1. 已修复 —— …" -> fixed, produces no action item', () => {
  const text = '1. 已修复 —— 修复了空指针异常与边界溢出问题'
  const parsed = parseDispositionSection(text)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].no, 1)
  assert.equal(parsed[0].verdict, 'fixed')

  const digests = deriveTurnDigests([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  assert.equal(digests.length, 1)
  assert.equal(digests[0].items.length, 0)
})

test('AC 2: "## 1. … — **需确认**（…）" -> confirm, findingNo=1', () => {
  const text = '## 1. 缓存清理策略 — **需确认**（是否需要全局清空）'
  const parsed = parseDispositionSection(text)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].no, 1)
  assert.equal(parsed[0].verdict, 'confirm')

  const digests = deriveTurnDigests([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  assert.equal(digests.length, 1)
  assert.equal(digests[0].items.length, 1)
  const item = digests[0].items[0]
  assert.equal(item.source, 'prompt-tail')
  assert.equal(item.kind, 'confirm')
  assert.equal(item.findingNo, 1)
  assert.equal(item.confidence, 'high')
  assert.equal(item.status, 'open')
})

test('AC 3: "**1. …** — **不修（…）**" -> wontfix, produces no action item', () => {
  const text = '**1. 废弃接口兼容** — **不修（已无外部依赖调用）**'
  const parsed = parseDispositionSection(text)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].no, 1)
  assert.equal(parsed[0].verdict, 'wontfix')

  const digests = deriveTurnDigests([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  assert.equal(digests.length, 1)
  assert.equal(digests[0].items.length, 0)
})

test('AC 4: "1. …" followed by "**状态：需确认**" on next line -> confirm item', () => {
  const text = '1. 关于精炼模式重构\n**状态：需确认**\n需要前端配合调整接口。'
  const parsed = parseDispositionSection(text)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].no, 1)
  assert.equal(parsed[0].verdict, 'confirm')

  const digests = deriveTurnDigests([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  assert.equal(digests.length, 1)
  assert.equal(digests[0].items.length, 1)
  assert.equal(digests[0].items[0].kind, 'confirm')
  assert.equal(digests[0].items[0].findingNo, 1)
})

test('AC 5: 编号行正文含"需要你确认"但不在判定位置 -> 不得产 item', () => {
  const text = '1. 这个方案在落地时可能需要你确认一下配置项，目前先采用默认值'
  const parsed = parseDispositionSection(text)
  assert.equal(parsed.length, 0) // Strictly rejected, not parsed as verdict

  const unparsed = parseDispositionSection(text, { includeUnparsed: true })
  assert.equal(unparsed.length, 1)
  assert.equal(unparsed[0].verdict, null)
  assert.equal(unparsed[0].unparsed, true)

  const digests = deriveTurnDigests([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  assert.equal(digests[0].items.length, 0)
})

test('AC 6: "1. …" followed by "**需确认**" 独立一行（无状态：前缀）-> 计入 unparsed，不产 item', () => {
  const text = '1. 某个待讨论的技术点\n**需确认**\n这里没有明确的状态冒号前缀'
  const parsed = parseDispositionSection(text)
  assert.equal(parsed.length, 0)

  const unparsed = parseDispositionSection(text, { includeUnparsed: true })
  assert.equal(unparsed.length, 1)
  assert.equal(unparsed[0].verdict, null)
  assert.equal(unparsed[0].unparsed, true)

  const digests = deriveTurnDigests([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  assert.equal(digests[0].items.length, 0)
})

test('AC 7: "未处理" -> unaddressed item', () => {
  const text = '1. 未处理 —— 时间不够，暂时搁置'
  const parsed = parseDispositionSection(text)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].no, 1)
  assert.equal(parsed[0].verdict, 'unaddressed')

  const digests = deriveTurnDigests([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  assert.equal(digests[0].items.length, 1)
  assert.equal(digests[0].items[0].kind, 'unaddressed')
  assert.equal(digests[0].items[0].findingNo, 1)
})

test('AC 8: 无文本 / 只有 reasoning / 纯 tool-call -> 不产 A 段 item', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'reasoning', text: '1. 需确认：思考中' }] } } },
    { type: 'tool/call', seq: 3, data: { turn: 1, callId: 'c1', name: 'read_file' } },
    { type: 'tool/result', seq: 4, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'file content' }] } } },
    { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const digests = deriveTurnDigests(events)
  assert.equal(digests.length, 1)
  assert.equal(digests[0].answerKind, 'none')
  assert.equal(digests[0].items.length, 0)
})

test('AC 9: ask answered -> 0 item; pending/error/缺失 -> item', () => {
  // 1. Answered: 0 item
  const answeredEvents = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, data: { turn: 1, callId: 'c1', name: 'ask_user_question' } },
    {
      type: 'tool/result',
      seq: 3,
      data: {
        message: {
          toolCallId: 'c1',
          content: [{ type: 'text', text: JSON.stringify({ answers: ['option A'] }) }],
        },
      },
    },
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const d1 = deriveTurnDigests(answeredEvents)
  assert.equal(d1[0].items.length, 0)

  // 2. Pending result: question-pending item
  const pendingEvents = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, data: { turn: 1, callId: 'c2', name: 'ask_user_question' } },
    {
      type: 'tool/result',
      seq: 3,
      data: {
        message: {
          toolCallId: 'c2',
          content: [{ type: 'text', text: JSON.stringify({ pending: true, message: '请选择部署分支' }) }],
        },
      },
    },
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const d2 = deriveTurnDigests(pendingEvents)
  assert.equal(d2[0].items.length, 1)
  assert.equal(d2[0].items[0].kind, 'question-pending')
  assert.equal(d2[0].items[0].callId, 'c2')

  // 3. Error result: question-error item
  const errorEvents = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, data: { turn: 1, callId: 'c3', name: 'ask_user_question' } },
    {
      type: 'tool/result',
      seq: 3,
      data: {
        message: {
          toolCallId: 'c3',
          isError: true,
          error: { code: 'USER_REJECTED' },
        },
      },
    },
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const d3 = deriveTurnDigests(errorEvents)
  assert.equal(d3[0].items.length, 1)
  assert.equal(d3[0].items[0].kind, 'question-error')
  assert.equal(d3[0].items[0].callId, 'c3')

  // 4. Missing result: question-pending item
  const missingEvents = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, data: { turn: 1, callId: 'c4', name: 'ask_user_question' } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const d4 = deriveTurnDigests(missingEvents)
  assert.equal(d4[0].items.length, 1)
  assert.equal(d4[0].items[0].kind, 'question-pending')
  assert.equal(d4[0].items[0].callId, 'c4')
})

test('AC 10: approval asked + decided -> 0 item; 未 decided -> item', () => {
  // 1. Decided: 0 item
  const decidedEvents = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'approval/asked', seq: 2, data: { id: 'appr-1', turn: 1, toolName: 'bash', reason: 'run rm -rf' } },
    { type: 'approval/decided', seq: 3, data: { id: 'appr-1', outcome: 'approved' } },
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const d1 = deriveTurnDigests(decidedEvents)
  assert.equal(d1[0].items.length, 0)

  // 2. Not decided: approval-pending item
  const pendingEvents = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'approval/asked', seq: 2, data: { id: 'appr-2', turn: 1, toolName: 'bash', reason: 'run dangerous script' } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const d2 = deriveTurnDigests(pendingEvents)
  assert.equal(d2[0].items.length, 1)
  assert.equal(d2[0].items[0].kind, 'approval-pending')
  assert.equal(d2[0].items[0].quote, 'run dangerous script')
})

test('AC 11: turn/end error/aborted -> turn-failed; 有更晚 turn -> stale; 最新 turn -> open', () => {
  const events = [
    // Turn 1 fails
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'error' } } },
    // Turn 2 succeeds
    { type: 'turn/start', seq: 3, data: { turn: 2 } },
    { type: 'turn/end', seq: 4, data: { turn: 2, reason: { kind: 'completed' } } },
    // Turn 3 aborted (latest turn)
    { type: 'turn/start', seq: 5, data: { turn: 3 } },
    { type: 'turn/end', seq: 6, data: { turn: 3, reason: { kind: 'aborted' } } },
  ]

  const digests = deriveTurnDigests(events, { sessionMaxTurn: 3 })
  assert.equal(digests.length, 3)

  // Turn 1 failure has later turns (1 < 3) -> stale
  assert.equal(digests[0].items.length, 1)
  assert.equal(digests[0].items[0].kind, 'turn-failed')
  assert.equal(digests[0].items[0].status, 'stale')

  // Turn 2 success -> 0 items
  assert.equal(digests[1].items.length, 0)

  // Turn 3 failure is the latest turn (3 === sessionMaxTurn) -> open
  assert.equal(digests[2].items.length, 1)
  assert.equal(digests[2].items[0].kind, 'turn-failed')
  assert.equal(digests[2].items[0].status, 'open')
})

test('AC 12: 文本以 "?" / "？" 结尾或含 ❓ + 开关 -> medium item; 关闭 -> 0 item', () => {
  const textQuestion = '当前方案有两个备选方案，你倾向于方案 A 还是方案 B？'
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text: textQuestion }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]

  // 1. Feature disabled (default) -> 0 item
  const dDisabled = deriveTurnDigests(events, { includeTextHeuristic: false })
  assert.equal(dDisabled[0].items.length, 0)
  assert.equal(dDisabled[0].answerKind, 'question')

  // 2. Feature enabled -> 1 medium item
  const dEnabled = deriveTurnDigests(events, { includeTextHeuristic: true })
  assert.equal(dEnabled[0].items.length, 1)
  assert.equal(dEnabled[0].items[0].kind, 'text-question')
  assert.equal(dEnabled[0].items[0].confidence, 'medium')
  assert.equal(dEnabled[0].items[0].source, 'text-heuristic')

  // 3. Question mark with ❓ emoji
  const emojiEvents = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text: '请确认是否继续 ❓' }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const dEmoji = deriveTurnDigests(emojiEvents, { includeTextHeuristic: true })
  assert.equal(dEmoji[0].items.length, 1)
  assert.equal(dEmoji[0].items[0].kind, 'text-question')

  // 4. Suppressed if P0 item already exists in the same turn
  const eventsWithP0 = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text: '1. 需确认 —— 是否需要回滚？' }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const dSuppressed = deriveTurnDigests(eventsWithP0, { includeTextHeuristic: true })
  assert.equal(dSuppressed[0].items.length, 1)
  assert.equal(dSuppressed[0].items[0].source, 'prompt-tail') // P0 takes precedence, no text-question item
})

test('AC 13: 同一输入重复解析 -> 相同 originKey，幂等', () => {
  const item1 = { sessionId: 'sess-1', turn: 5, source: 'prompt-tail', evidenceSeq: 10, findingNo: 1 }
  const item2 = { sessionId: 'sess-1', turn: 5, source: 'prompt-tail', evidenceSeq: 10, findingNo: 1 }
  const key1 = itemOriginKey(item1)
  const key2 = itemOriginKey(item2)
  assert.equal(key1, key2)
  assert.equal(key1, 'sess-1|5|prompt-tail|10|1')
})

test('AC 14: 不同 turn/编号 -> 不同 originKey，允许 Fork', () => {
  const k1 = itemOriginKey({ sessionId: 's', turn: 1, source: 'prompt-tail', evidenceSeq: 10, findingNo: 1 })
  const k2 = itemOriginKey({ sessionId: 's', turn: 2, source: 'prompt-tail', evidenceSeq: 20, findingNo: 1 })
  const k3 = itemOriginKey({ sessionId: 's', turn: 1, source: 'prompt-tail', evidenceSeq: 10, findingNo: 2 })
  assert.notEqual(k1, k2)
  assert.notEqual(k1, k3)
  assert.notEqual(k2, k3)
})

test('AC 15: 精确映射：promptText 编号 1..N 与同 request Finding 按 tag+title/body 匹配，重复文本按提交顺序，裁剪降级', () => {
  const requestId = 'req-100'
  const promptText = [
    '[会话手账 · 评审发现 2 条]',
    '1. [blocker] 修复内存泄漏',
    '   缓存未释放导致 OOM',
    '2. [blocker] 修复内存泄漏',
    '   缓存未释放导致 OOM',
  ].join('\n')

  const promptLogTurns = new Map([
    [1, { turn: 1, requestId, mode: 'combined', promptText }],
  ])

  const findingsByRequest = new Map([
    [
      requestId,
      [
        { id: 'f-1', requestId, tag: 'blocker', title: '修复内存泄漏', body: '缓存未释放导致 OOM' },
        { id: 'f-2', requestId, tag: 'blocker', title: '修复内存泄漏', body: '缓存未释放导致 OOM' },
      ],
    ],
  ])

  // Finding 1 matches first duplicate
  const match1 = matchPromptLogFinding({ turn: 1, promptLogTurns, findingNo: 1, findingsByRequest })
  assert.equal(match1, 'f-1')

  // Finding 2 matches second duplicate
  const match2 = matchPromptLogFinding({ turn: 1, promptLogTurns, findingNo: 2, findingsByRequest })
  assert.equal(match2, 'f-2')

  // Truncated / missing PromptLog -> degrades to null
  const matchMissingLog = matchPromptLogFinding({ turn: 2, promptLogTurns, findingNo: 1, findingsByRequest })
  assert.equal(matchMissingLog, null)

  // Empty promptText -> degrades to null
  const emptyLog = new Map([[3, { turn: 3, requestId: 'r2', promptText: '' }]])
  const matchEmpty = matchPromptLogFinding({ turn: 3, promptLogTurns: emptyLog, findingNo: 1, findingsByRequest })
  assert.equal(matchEmpty, null)
})

test('AC 16: sequential 的 promptText 只解析编号 1; combined 解析 1..N', () => {
  const reqSeq = 'req-seq'
  const promptSeq = [
    '[会话手账 · 评审发现 1 条]',
    '1. [optimize] 优化查询索引',
    '   为 user_id 增加联合索引',
  ].join('\n')

  const promptLogTurns = new Map([
    [1, { turn: 1, requestId: reqSeq, mode: 'sequential', promptText: promptSeq }],
  ])
  const findingsByRequest = new Map([
    [reqSeq, [{ id: 'f-seq', requestId: reqSeq, tag: 'optimize', title: '优化查询索引' }]],
  ])

  // Sequential with findingNo = 1 succeeds
  assert.equal(
    matchPromptLogFinding({ turn: 1, promptLogTurns, findingNo: 1, findingsByRequest }),
    'f-seq',
  )
  // Sequential with findingNo > 1 degrades to null
  assert.equal(
    matchPromptLogFinding({ turn: 1, promptLogTurns, findingNo: 2, findingsByRequest }),
    null,
  )
})

// ============================================================================
// Multiline & Edge Cases for Section A Parser
// ============================================================================

test('parseDispositionSection: supports various multiline prefixes (状态/结论/处置/判定/结果)', () => {
  const text = [
    '1. 架构梳理',
    '结论：需确认',
    '2. 性能评估',
    '**处置：已修复**',
    '3. 第三方包升级',
    '判定：需确认',
    '4. 历史遗留文件',
    '结果：不修',
  ].join('\n')

  const parsed = parseDispositionSection(text)
  assert.equal(parsed.length, 4)
  assert.equal(parsed[0].verdict, 'confirm')
  assert.equal(parsed[1].verdict, 'fixed')
  assert.equal(parsed[2].verdict, 'confirm')
  assert.equal(parsed[3].verdict, 'wontfix')
})

test('parseDispositionSection: clamps quote length to <= 8 KB (QUOTE_MAX_BYTES)', () => {
  const hugeText = '1. 需确认：' + 'a'.repeat(20000)
  const parsed = parseDispositionSection(hugeText)
  assert.equal(parsed.length, 1)
  assert.equal(QUOTE_MAX_BYTES, 8192)
  assert.ok(parsed[0].detail.length <= QUOTE_MAX_BYTES)
  assert.equal(parsed[0].detail.length, QUOTE_MAX_BYTES)
})

test('deriveTurnDigests: cap item quote at 8 KB and body at 32 KB', () => {
  const text = '1. 需确认：' + 'a'.repeat(50000)
  const digests = deriveTurnDigests([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  const item = digests[0].items[0]
  assert.equal(item.kind, 'confirm')
  assert.equal(BODY_MAX_BYTES, 32768)
  assert.ok(item.quote.length <= QUOTE_MAX_BYTES)
  assert.ok(item.body.length <= BODY_MAX_BYTES)
})

test('classifyFinalAnswer: question wins over narration per spec §5.1', () => {
  assert.equal(classifyFinalAnswer({ answerText: '继续吗？', answerSeq: 2, lastAmSeq: 4 }), 'question')
  assert.equal(classifyFinalAnswer({ answerText: '已完成', answerSeq: 2, lastAmSeq: 4 }), 'narration')
})

test('convertTurnActionToFinding: Fork overrides title/body/tag and records source, not kind', () => {
  const parent = createFindingRecord({
    id: 'parent-1',
    sessionId: 'old-session',
    workspaceId: 'old-ws',
    text: '旧正文',
    title: '旧标题',
    tag: 'optimize',
  })
  const item = {
    id: 'sess-1|3|prompt-tail|30|2',
    sessionId: 'sess-1',
    turn: 3,
    source: 'prompt-tail',
    kind: 'confirm',
    confidence: 'high',
    title: 'Turn 3 · 需确认 #2: 新标题',
    body: '新正文（含证据）',
    quote: '新正文（含证据）',
    evidenceSeq: 30,
    findingNo: 2,
  }
  const forked = convertTurnActionToFinding({
    item,
    parentFinding: parent,
    targetSessionId: 'active-session',
    targetWorkspaceKey: 'session:active-session',
    targetWorkspaceId: 'active-ws',
    targetSessionTitle: 'Active',
    thoughtNo: 7,
    idGenerator: () => 'fork-1',
  })
  assert.equal(forked.title, item.title)
  assert.equal(forked.body, item.body)
  assert.equal(forked.text, item.body)
  assert.equal(forked.tag, 'context')
  assert.deepEqual(forked.tags, ['context'])
  assert.equal(forked.sourceKind, 'prompt-tail')
  assert.equal(forked.sourceFindingNo, 2)
  assert.equal(forked.reviewRound, 2)
})

test('convertTurnActionToFinding: new finding tags a failed turn as blocker', () => {
  const finding = convertTurnActionToFinding({
    item: { sessionId: 's', turn: 1, source: 'turn-outcome', kind: 'turn-failed', confidence: 'high', title: '失败', body: '失败', quote: 'error', evidenceSeq: 1 },
    targetSessionId: 's',
    targetWorkspaceKey: 'session:s',
    targetWorkspaceId: 'ws',
    idGenerator: () => 'f-1',
  })
  assert.equal(finding.tag, 'blocker')
  assert.equal(finding.sourceKind, 'turn-outcome')
})

// ============================================================================
// findFindingByOriginKey Test Cases (Single, Not Found, Multiple)
// ============================================================================


test('parseDispositionSection: captures unnumbered prose confirmations', () => {
  const text = [
    '另有一处需你确认（不属于上面两条编号）',
    '一处需你确认：我把 rsync 目标也一并改成了 allen@192.168.158.201:/home/apps/tconsole/',
  ].join('\n')
  const parsed = parseDispositionSection(text)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].verdict, 'confirm')
  assert.equal(parsed[0].no, null)
  assert.equal(parsed[0].prose, true)
  assert.ok(parsed[0].detail.includes('另有一处需你确认'))
  assert.equal(parsed[1].verdict, 'confirm')
  assert.ok(parsed[1].detail.includes('rsync'))
})

test('parseDispositionSection: bare verdict and unrelated prose stay unparsed', () => {
  const text = [
    '**需确认**',
    '请用户确认是否继续',
    '这里不需要确认',
    '需要你确认这条是不是动作',
  ].join('\n')
  assert.equal(parseDispositionSection(text).length, 0)
  assert.equal(parseDispositionSection(text, { includeUnparsed: true }).length, 0)
})

test('parseDispositionSection: numbered 需你确认 is also confirm', () => {
  const parsed = parseDispositionSection('1. 需你确认 —— 是否修改部署目标')
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].verdict, 'confirm')
  assert.equal(parsed[0].no, 1)
})

test('deriveTurnDigests: prose confirmation becomes a normal high-confidence item', () => {
  const text = [
    '另有一处需你确认（不属于上面两条编号）',
    '一处需你确认：我把 rsync 目标也一并改成了 allen@192.168.158.201:/home/apps/tconsole/',
  ].join('\n')
  const digests = deriveTurnDigests([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  assert.equal(digests[0].items.length, 2)
  for (const item of digests[0].items) {
    assert.equal(item.kind, 'confirm')
    assert.equal(item.source, 'prompt-tail')
    assert.equal(item.confidence, 'high')
    assert.equal(item.findingNo, undefined)
    assert.ok(!item.title.includes('#null'))
    assert.ok(!item.body.includes('#null'))
  }
  assert.ok(digests[0].items[0].quote.includes('另有一处需你确认'))
  assert.ok(digests[0].items[1].quote.includes('rsync'))
})

test('findFindingByOriginKey: single match returns finding', () => {
  const findings = [
    { id: 'f-1', originKey: 'sess|1|prompt-tail|10|1' },
    { id: 'f-2', originKey: 'sess|1|prompt-tail|10|2' },
  ]
  const match = findFindingByOriginKey(findings, 'sess|1|prompt-tail|10|2')
  assert.equal(match.id, 'f-2')
})

test('findFindingByOriginKey: not found returns null', () => {
  const findings = [{ id: 'f-1', originKey: 'key-1' }]
  assert.equal(findFindingByOriginKey(findings, 'key-not-found'), null)
  assert.equal(findFindingByOriginKey([], 'key-1'), null)
  assert.equal(findFindingByOriginKey(null, 'key-1'), null)
})

test('findFindingByOriginKey: multiple matches returns first matching finding', () => {
  const findings = [
    { id: 'f-first', originKey: 'dup-key', createdAt: 100 },
    { id: 'f-second', originKey: 'dup-key', createdAt: 200 },
  ]
  const match = findFindingByOriginKey(findings, 'dup-key')
  assert.equal(match.id, 'f-first')
})

test('findFindingByOriginKey: works with Map and Object input', () => {
  const map = new Map([
    ['f-1', { id: 'f-1', originKey: 'map-key' }],
  ])
  assert.equal(findFindingByOriginKey(map, 'map-key').id, 'f-1')

  const dict = {
    'f-1': { id: 'f-1', originKey: 'dict-key' },
  }
  assert.equal(findFindingByOriginKey(dict, 'dict-key').id, 'f-1')
})

// ============================================================================
// mergeTurnActionItems Test Cases
// ============================================================================

test('mergeTurnActionItems: retains converted and dismissed status and finding links', () => {
  const existing = [
    { id: 'k1', status: 'converted', findingId: 'f-123', decidedAt: 1000, quote: 'old quote' },
    { id: 'k2', status: 'dismissed', decidedAt: 1005, quote: 'dismissed quote' },
    { id: 'k3', status: 'open', quote: 'old open quote' },
  ]
  const incoming = [
    { id: 'k1', status: 'open', quote: 'incoming quote 1' },
    { id: 'k2', status: 'open', quote: 'incoming quote 2' },
    { id: 'k3', status: 'stale', quote: 'incoming quote 3' },
    { id: 'k4', status: 'open', quote: 'new incoming item' },
  ]

  const merged = mergeTurnActionItems(existing, incoming)
  assert.equal(merged.length, 4)

  const m1 = merged.find(x => x.id === 'k1')
  assert.equal(m1.status, 'converted')
  assert.equal(m1.findingId, 'f-123')
  assert.equal(m1.decidedAt, 1000)

  const m2 = merged.find(x => x.id === 'k2')
  assert.equal(m2.status, 'dismissed')
  assert.equal(m2.decidedAt, 1005)

  const m3 = merged.find(x => x.id === 'k3')
  assert.equal(m3.status, 'stale')
  assert.equal(m3.quote, 'incoming quote 3')

  const m4 = merged.find(x => x.id === 'k4')
  assert.equal(m4.status, 'open')
})

// ============================================================================
// Finding Provenance Whitelist Round-Trip in entries.js
// ============================================================================

test('entries.js: createEntry preserves provenance fields', () => {
  const provenance = {
    origin: 'turn-action',
    originKey: 'sess|1|prompt-tail|10|1',
    sourceTurn: 1,
    sourceSeq: 10,
    sourceKind: 'prompt-tail',
    sourceConfidence: 'high',
    sourceCallId: 'c-1',
    sourceFindingNo: 1,
    generatedAt: 123456789,
  }

  const entry = createEntry({
    kind: 'finding',
    sessionId: 'sess-1',
    workspaceKey: '/repo',
    title: '需确认配置',
    body: '正文',
    ...provenance,
  })

  for (const [key, val] of Object.entries(provenance)) {
    assert.equal(entry[key], val, `expected ${key} to be preserved in createEntry`)
  }
})

test('entries.js: createFindingRecord preserves provenance fields', () => {
  const provenance = {
    origin: 'turn-action',
    originKey: 'sess|2|turn-outcome|20|-',
    sourceTurn: 2,
    sourceSeq: 20,
    sourceKind: 'turn-outcome',
    sourceConfidence: 'high',
    sourceFindingNo: undefined,
    generatedAt: 987654321,
  }

  const record = createFindingRecord({
    sessionId: 'sess-1',
    workspaceId: '/repo',
    text: '执行失败手账',
    tag: 'blocker',
    severity: 'blocker',
    ...provenance,
  })

  assert.equal(record.origin, 'turn-action')
  assert.equal(record.originKey, 'sess|2|turn-outcome|20|-')
  assert.equal(record.sourceTurn, 2)
  assert.equal(record.sourceSeq, 20)
  assert.equal(record.sourceKind, 'turn-outcome')
  assert.equal(record.sourceConfidence, 'high')
  assert.equal(record.generatedAt, 987654321)
})

test('entries.js: migrateFinding preserves provenance fields', () => {
  const legacy = {
    id: 'f-leg',
    sessionId: 'sess-1',
    workspaceId: '/repo',
    title: '旧条目',
    status: 'open',
    origin: 'turn-action',
    originKey: 'sess|3|ask-user|30|-',
    sourceTurn: 3,
    sourceSeq: 30,
    sourceKind: 'ask-user',
    sourceConfidence: 'high',
    generatedAt: 555555,
  }

  const migrated = migrateFinding(legacy)
  assert.equal(migrated.origin, 'turn-action')
  assert.equal(migrated.originKey, 'sess|3|ask-user|30|-')
  assert.equal(migrated.sourceTurn, 3)
  assert.equal(migrated.sourceSeq, 30)
  assert.equal(migrated.sourceKind, 'ask-user')
  assert.equal(migrated.sourceConfidence, 'high')
  assert.equal(migrated.generatedAt, 555555)
})

// ============================================================================
// Interrupted Flag Handling
// ============================================================================

test('deriveTurnDigests: assistant/message with interrupted: true is annotated in body', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 2,
      data: {
        turn: 1,
        interrupted: true,
        message: { content: [{ type: 'text', text: '1. 需确认 —— 输出被用户中断截断' }] },
      },
    },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'aborted' } } },
  ]

  const digests = deriveTurnDigests(events, { sessionMaxTurn: 1 })
  assert.equal(digests.length, 1)
  const item = digests[0].items.find(it => it.source === 'prompt-tail')
  assert.ok(item)
  assert.ok(item.body.includes('被中断的半截回复'))
})
